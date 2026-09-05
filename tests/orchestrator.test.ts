import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../server/config.js'
import { LLMAbortedError, LLMRequestError, type LLMResult } from '../server/contracts.js'
import { createMockLLM } from '../server/llm/mock.js'
import { createToolRegistry } from '../server/tools.js'
import { assign, deferred, harness, ready, reply, settle, tool, until, usage } from './helpers.js'

for (const gate of [true, false]) {
  test(`run.finish never merges with gate ${gate ? 'on' : 'off'}`, async (t) => {
    let finish = false
    const h = harness(t, async () => { if (finish) { finish = false; return reply([tool('run_finish', { summary: 'done' })]) } return reply() })
    await h.orchestrator.start()
    await settle()
    await ready(h.workspace)
    h.orchestrator.setGate(gate)
    finish = true
    await h.orchestrator.humanMessage('finish now', 'atlas')
    await settle()
    assert.equal(h.workspace.pr.state().merged, false)
    assert.equal(h.store.snapshot().run.status, 'live')
    assert.ok(h.store.snapshot().thread.some((item) => item.kind === 'tool' && item.tool === 'run.finish' && item.status === 'error'))
  })
}

test('run.finish can acknowledge an already merged PR', async (t) => {
  let finish = false
  const h = harness(t, async () => finish ? reply([tool('run_finish', { summary: 'merged already' }), assign('probe')]) : reply())
  await h.orchestrator.start()
  await settle()
  await ready(h.workspace)
  assert.equal(h.workspace.pr.merge().ok, true)
  finish = true
  await h.orchestrator.humanMessage('finish', 'atlas')
  await until(() => h.store.snapshot().run.status === 'done')
  assert.equal(h.store.tasks().length, 0, 'remaining batch effects are dropped')
})

test('merge request holds for human approval and early approval without evidence cannot bypass it', async (t) => {
  let merge = false
  const h = harness(t, async () => { if (merge) { merge = false; return reply([tool('run_request_merge', { summary: 'ready' })]) } return reply() })
  await h.orchestrator.start()
  await settle()
  h.orchestrator.approve()
  await ready(h.workspace)
  merge = true
  await h.orchestrator.humanMessage('request merge', 'atlas')
  await until(() => h.store.snapshot().run.status === 'needs_approval')
  assert.equal(h.workspace.pr.state().merged, false)
  h.orchestrator.approve()
  assert.equal(h.workspace.pr.state().merged, true)
  assert.equal(h.store.snapshot().run.status, 'done')
  assert.deepEqual(h.store.snapshot().typing, [])
})

for (const early of [true, false]) {
  test(`${early ? 'early' : 'held'} human approval cannot transfer to a newer revision`, async (t) => {
    let merge = false
    const h = harness(t, async () => { if (merge) { merge = false; return reply([tool('run_request_merge', { summary: 'ready' })]) } return reply() })
    await h.orchestrator.start()
    await settle()
    await ready(h.workspace)
    if (early) h.orchestrator.approve()
    else {
      merge = true
      await h.orchestrator.humanMessage('merge', 'atlas')
      await until(() => h.store.snapshot().run.status === 'needs_approval')
    }
    h.workspace.push('new revision, same content')
    await h.workspace.run('pnpm e2e')
    h.workspace.pr.review('sentry', 'approve', 'new revision review')
    if (!early) h.orchestrator.approve()
    assert.equal(h.workspace.pr.state().merged, false)
    // Any early approval granted for the new revision is explicitly cleared by another push.
    h.workspace.push('final revision')
    await h.workspace.run('pnpm e2e')
    h.workspace.pr.review('sentry', 'approve', 'final review')
    merge = true
    await h.orchestrator.humanMessage('new merge request', 'atlas')
    await until(() => h.store.snapshot().run.status === 'needs_approval')
    assert.equal(h.workspace.pr.state().merged, false)
    h.orchestrator.approve()
    assert.equal(h.store.snapshot().run.status, 'done')
  })
}

for (const failure of ['missing evidence', 'merge rejected'] as const) {
  test(`${failure} never produces done`, async (t) => {
    let merge = false
    const h = harness(t, async () => { if (merge) { merge = false; return reply([tool('run_request_merge', { summary: 'ready' }), tool('run_finish', { summary: 'done' })]) } return reply() })
    await h.orchestrator.start()
    await settle()
    if (failure === 'merge rejected') {
      await ready(h.workspace)
      h.workspace.pr.merge = () => ({ ok: false, reason: 'simulated merge rejected' })
    }
    h.orchestrator.setGate(false)
    merge = true
    await h.orchestrator.humanMessage('merge', 'atlas')
    await settle()
    assert.equal(h.workspace.pr.state().merged, false)
    assert.equal(h.store.snapshot().run.status, 'live')
    assert.ok(h.store.snapshot().thread.some((item) => item.kind === 'tool' && item.status === 'error'))
  })
}

test('stale Sentry response cannot review a revision pushed while the request was in flight', async (t) => {
  const pending = deferred<LLMResult>()
  let reviewCalls = 0
  const h = harness(t, async (req) => req.agent === 'sentry' && ++reviewCalls === 1 ? pending.promise : reply())
  await h.orchestrator.start()
  await settle()
  await ready(h.workspace)
  await h.orchestrator.humanMessage('review', 'sentry')
  await until(() => reviewCalls === 1)
  h.workspace.push('concurrent new revision')
  pending.resolve(reply([tool('pr_review', { verdict: 'approve', summary: 'old response' })]))
  await settle()
  assert.equal(h.workspace.pr.state().review, 'none')
  assert.ok(h.store.snapshot().agents.find((a) => a.id === 'sentry')!.tools.some((item) => item.status === 'error'))
})

for (const terminal of ['done', 'failed'] as const) {
  test(`${terminal} cancels queued and outstanding work, closes streams, and retains late reported usage`, async (t) => {
    const pending = deferred<LLMResult>()
    let initial = true
    let end = false
    const h = harness(t, async (req) => {
      if (req.agent === 'forge') { req.onText?.('working'); return pending.promise }
      if (initial) { initial = false; return reply([assign()]) }
      if (end) return terminal === 'done' ? reply([tool('run_request_merge', { summary: 'ready' }), assign('probe')]) : reply([assign('probe')], 200_000)
      return reply()
    }, { env: { RUN_BUDGET_USD: '1' } })
    await h.orchestrator.start()
    await until(() => h.requests.some((req) => req.agent === 'forge'))
    await settle()
    await ready(h.workspace)
    await h.orchestrator.humanMessage('queued work', 'forge')
    h.orchestrator.setGate(false)
    end = true
    await h.orchestrator.humanMessage('end', 'atlas')
    await until(() => h.store.snapshot().run.status === terminal)
    const requests = h.requests.length
    const tasks = h.store.tasks()
    const thread = h.store.snapshot().thread
    const forgeRequest = h.requests.find((req) => req.agent === 'forge')!
    assert.equal(forgeRequest.signal.aborted, true)
    forgeRequest.onText?.('late stream must be ignored')
    pending.resolve(reply([tool('repo_write', { path: 'late.ts', content: 'bad' }), tool('agent_done', { summary: 'late', io: [] })], 200))
    await settle()
    assert.equal(h.requests.length, requests)
    assert.deepEqual(h.store.tasks(), tasks)
    assert.deepEqual(h.store.snapshot().thread, thread)
    assert.equal(h.workspace.read('late.ts'), null)
    assert.ok(h.store.stats().costUsd >= (terminal === 'failed' ? 1.001 : 0.001))
    assert.equal(h.store.snapshot().run.status, terminal)
    assert.deepEqual(h.store.snapshot().typing, [])
    assert.ok(h.store.snapshot().agents.every((a) => a.status !== 'working' && a.status !== 'thinking'))
  })
}

test('restarted run ignores stale responses and streams while banking their cost only to lifetime', async (t) => {
  const old = deferred<LLMResult>()
  let calls = 0
  const h = harness(t, async () => ++calls === 1 ? old.promise : reply())
  await h.orchestrator.start()
  const oldId = h.store.snapshot().run.id
  const req = h.requests[0]
  await h.orchestrator.start()
  await settle()
  assert.notEqual(h.store.snapshot().run.id, oldId)
  const current = h.store.snapshot()
  req.onText?.('stale stream')
  old.resolve(reply([assign()], 200_000, 'stale text'))
  await settle()
  assert.deepEqual(h.store.snapshot(), current)
  assert.equal(h.store.stats().costUsd, 0)
  assert.equal(h.store.lifetimeCostUsd(), 1)
})

test('late tool effects cannot mutate a restarted run', async (t) => {
  const pending = deferred<{ ok: boolean; result: string; effect: { kind: 'assign'; agent: 'forge'; phase: 'build'; title: string; subtask: string } }>()
  const tools = createToolRegistry()
  tools.byApiName('run_assign')!.execute = async () => pending.promise
  let first = true
  const h = harness(t, async () => { if (first) { first = false; return reply([assign()]) } return reply() }, { tools })
  await h.orchestrator.start()
  await until(() => h.store.snapshot().thread.some((item) => item.kind === 'tool'))
  await h.orchestrator.start()
  await settle()
  const before = h.store.snapshot()
  pending.resolve({ ok: true, result: 'late', effect: { kind: 'assign', agent: 'forge', phase: 'build', title: 'late', subtask: 'late' } })
  await settle()
  assert.deepEqual(h.store.snapshot(), before)
  assert.equal(h.store.tasks().length, 0)
})

for (const agent of ['atlas', 'forge'] as const) {
  test(`unrecoverable ${agent} provider failure explicitly fails the run`, async (t) => {
    const h = harness(t, async (req) => {
      if (req.agent === agent) throw new LLMRequestError('provider unavailable', usage(200))
      return reply([assign()])
    })
    await h.orchestrator.start()
    await until(() => h.store.snapshot().run.status === 'failed')
    assert.match(h.store.snapshot().run.error!, /model call failed: provider unavailable/)
    assert.equal(h.store.stats().costUsd, 0.001)
  })
}

test('unexpected tool executor error fails instead of silently stalling', async (t) => {
  const tools = createToolRegistry()
  tools.byApiName('run_read_status')!.execute = async () => { throw new Error('executor failure') }
  const h = harness(t, async () => reply([tool('run_read_status')]), { tools })
  await h.orchestrator.start()
  await until(() => h.store.snapshot().run.status === 'failed')
  assert.match(h.store.snapshot().run.error!, /executor failure/)
})

test('human interruption stays live, retains partial cost, and allows the next message', async (t) => {
  let calls = 0
  const h = harness(t, async (req) => {
    if (++calls > 1) return reply([], 0, 'resumed')
    return new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(new LLMAbortedError(usage(200))), { once: true }))
  })
  await h.orchestrator.start()
  h.orchestrator.interrupt('atlas')
  await settle()
  assert.equal(h.store.snapshot().run.status, 'live')
  assert.equal(h.store.snapshot().run.error, undefined)
  assert.equal(h.store.stats().costUsd, 0.001)
  assert.deepEqual(h.store.snapshot().typing, [])
  await h.orchestrator.humanMessage('continue', 'atlas')
  await until(() => calls === 2)
})

test('a response arriving after human interruption cannot run tools', async (t) => {
  const pending = deferred<LLMResult>()
  const h = harness(t, async () => pending.promise)
  await h.orchestrator.start()
  h.orchestrator.interrupt('atlas')
  pending.resolve(reply([assign()], 200))
  await settle()
  assert.equal(h.store.tasks().length, 0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.store.stats().costUsd, 0.001)
  assert.equal(h.store.snapshot().run.status, 'live')
})

test('pause stops subsequent requests and tool calls until resume', async (t) => {
  const pending = deferred<LLMResult>()
  let calls = 0
  const h = harness(t, async () => ++calls === 1 ? pending.promise : reply())
  await h.orchestrator.start()
  h.orchestrator.pause()
  pending.resolve(reply([assign()]))
  await settle()
  assert.equal(h.store.tasks().length, 0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.store.snapshot().run.status, 'paused')
  h.orchestrator.resume()
  await until(() => h.store.tasks().length === 1)
  assert.equal(h.store.snapshot().run.status, 'live')
})

for (const tokens of [200_000, 200_001]) {
  for (const withTools of [false, true]) {
    test(`budget ${tokens === 200_000 ? 'at' : 'above'} ceiling stops ${withTools ? 'tool' : 'text-only'} response immediately`, async (t) => {
      const h = harness(t, async () => reply(withTools ? [assign()] : [], tokens, 'final'), { env: { RUN_BUDGET_USD: '1' } })
      await h.orchestrator.start()
      await until(() => h.store.snapshot().run.status === 'failed')
      assert.match(h.store.snapshot().run.error!, /budget/)
      assert.equal(h.requests.length, 1)
      assert.equal(h.store.tasks().length, 0)
    })
  }
}

for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
  test(`validated ${effort} effort reaches the model request`, async (t) => {
    const h = harness(t, async () => reply(), { env: { EFFORT: effort } })
    await h.orchestrator.start()
    assert.equal(h.requests[0].effort, effort)
  })
}

test('invalid effort is rejected by config', () => assert.throws(() => loadConfig({ EFFORT: 'invalid' }), /EFFORT/))

for (const gate of [true, false]) {
  test(`canonical mock workflow succeeds with gate ${gate ? 'on' : 'off'}`, async (t) => {
    const config = loadConfig({ MOCK_LLM: '1', MOCK_SPEED: '0' })
    const h = harness(t, async () => reply(), { llm: createMockLLM(config) })
    h.orchestrator.setGate(gate)
    await h.orchestrator.start()
    await until(() => ['needs_approval', 'done', 'failed'].includes(h.store.snapshot().run.status), 'mock merge gate')
    assert.equal(h.store.snapshot().run.status, gate ? 'needs_approval' : 'done')
    assert.equal(h.workspace.lastTests()?.passed, 24)
    assert.equal(h.workspace.pr.state().review, 'approved')
    assert.equal(h.workspace.pr.state().comments.filter((c) => c.blocking && !c.resolved).length, 0)
    if (gate) {
      assert.equal(h.workspace.pr.state().merged, false)
      h.orchestrator.approve()
    }
    await until(() => h.store.snapshot().run.status === 'done')
    assert.equal(h.workspace.pr.state().merged, true)
    assert.deepEqual(h.store.snapshot().typing, [])
    const before = h.store.snapshot()
    await settle()
    assert.deepEqual(h.store.snapshot(), before, 'terminal state is stable')
  })
}

test('interrupt during an awaited tool drops its effects and the rest of the tool batch', async (t) => {
  const tools = createToolRegistry()
  const pending = deferred<{ ok: boolean; result: string; effect: { kind: 'assign'; agent: 'forge'; phase: 'build'; title: string; subtask: string } }>()
  tools.byApiName('run_assign')!.execute = async () => pending.promise
  const h = harness(t, async () => reply([assign(), assign('probe')]), { tools })
  await h.orchestrator.start()
  await until(() => h.store.snapshot().thread.some((item) => item.kind === 'tool'))
  h.orchestrator.interrupt('atlas')
  pending.resolve({ ok: true, result: 'late', effect: { kind: 'assign', agent: 'forge', phase: 'build', title: 'late', subtask: 'late' } })
  await settle()
  assert.equal(h.store.tasks().length, 0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.store.snapshot().run.status, 'live')
})

test('terminal failure releases a paused queue without activating queued assignments', async (t) => {
  const pending = deferred<LLMResult>()
  const h = harness(t, async () => pending.promise, { env: { RUN_BUDGET_USD: '1' } })
  await h.orchestrator.start()
  h.orchestrator.pause()
  await h.orchestrator.humanMessage('queued', 'forge')
  pending.resolve(reply([assign()], 200_000))
  await until(() => h.store.snapshot().run.status === 'failed')
  await settle()
  assert.equal(h.requests.length, 1)
  assert.equal(h.store.tasks().length, 0)
})

test('dispose cancels work and does not allow a later start to resurrect requests', async (t) => {
  const pending = deferred<LLMResult>()
  const h = harness(t, async () => pending.promise)
  await h.orchestrator.start()
  h.orchestrator.dispose()
  const before = h.store.snapshot()
  pending.resolve(reply([assign()], 200))
  await h.orchestrator.start()
  await settle()
  assert.equal(h.requests.length, 1)
  assert.equal(h.store.tasks().length, 0)
  assert.deepEqual(h.store.snapshot().thread, before.thread)
  assert.equal(h.store.lifetimeCostUsd(), 0.001)
})
