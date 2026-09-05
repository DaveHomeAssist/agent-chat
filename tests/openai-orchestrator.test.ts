import test from 'node:test'
import assert from 'node:assert/strict'
import type { LLM, LLMRequest, LLMResult } from '../server/contracts.js'
import { loadConfig } from '../server/config.js'
import { createOpenAILLM } from '../server/llm/openai.js'
import { createToolRegistry } from '../server/tools.js'
import { harness, deferred, ready, settle, until } from './helpers.js'
import { call, clientWith, completed, message, sse, scriptedOpenAI } from './openai-fixtures.js'

const env = { MOCK_LLM: '0', LLM_PROVIDER: 'openai', MOCK_SPEED: '0' }
const config = loadConfig(env)
const never = async (): Promise<LLMResult> => { throw new Error('unexpected non-OpenAI driver') }

for (const gate of [true, false]) {
  test(`real OpenAI SDK adapter drives complete simulated story with gate ${gate}`, async (t) => {
    const payloads: Record<string, unknown>[] = []
    const h = harness(t, never, { env, llm: scriptedOpenAI(config, payloads) })
    h.orchestrator.setGate(gate)
    await h.orchestrator.start()
    await until(() => ['needs_approval', 'done', 'failed'].includes(h.store.snapshot().run.status), 'story approval gate')
    assert.equal(h.store.snapshot().run.error, undefined)
    assert.deepEqual(h.workspace.pr.checkMerge(), gate ? { ok: true } : { ok: false, reason: 'PR #482 is already merged' })
    if (gate) {
      assert.equal(h.store.snapshot().run.status, 'needs_approval')
      assert.equal(h.workspace.pr.state().merged, false)
      assert.equal(h.workspace.pr.state().review, 'approved')
      h.orchestrator.approve()
    }
    await until(() => h.store.snapshot().run.status === 'done')
    const count = payloads.length
    await settle()
    assert.equal(payloads.length, count, 'terminal state causes no more requests')
    assert.equal(h.workspace.pr.state().merged, true)
    assert.equal(h.store.snapshot().run.llm, 'openai')
    assert.ok(h.store.snapshot().agents.every((a) => a.model === 'gpt-5.6-sol'))
    assert.ok(!JSON.stringify(h.store.snapshot()).includes('opaque-reasoning'))
    assert.ok(payloads.some((p) => JSON.stringify(p.input).includes('opaque-reasoning')))
    assert.equal(h.store.stats().unreportedRequests, 0)
  })
}

test('OpenAI unauthorized tools are rejected by orchestration before execution', async (t) => {
  const tools = createToolRegistry()
  let ran = false
  tools.byApiName('repo_write')!.execute = async () => { ran = true; return { ok: true, result: 'bad' } }
  const payloads: Record<string, unknown>[] = []
  const llm = createOpenAILLM(config, clientWith(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)))
    return sse([completed(payloads.length === 1 ? [call('repo_write', '{"path":"bad","content":"bad"}')] : [message()])])
  }))
  const h = harness(t, never, { env, llm, tools })
  await h.orchestrator.start()
  await until(() => payloads.length === 2)
  assert.equal(ran, false)
  assert.equal(h.workspace.read('bad'), null)
  assert.match(JSON.stringify(payloads[1].input), /not authorized/)
})

test('OpenAI run.finish and premature merge cannot bypass revision evidence or human approval', async (t) => {
  let n = 0
  const llm = createOpenAILLM(config, clientWith(async () => sse([completed(++n === 1 ? [call('run_finish', '{"summary":"done"}', 'finish'), call('run_request_merge', '{"summary":"merge"}', 'merge')] : [message()])])) )
  const h = harness(t, never, { env, llm })
  await h.orchestrator.start()
  await until(() => n === 2)
  assert.equal(h.store.snapshot().run.status, 'live')
  assert.equal(h.workspace.pr.state().merged, false)
})

test('OpenAI restart isolates conversation and banks delayed adapter usage to lifetime only', async (t) => {
  const pending = deferred<LLMResult>()
  const release = deferred<void>()
  const requests: LLMRequest[] = []
  const adapter = createOpenAILLM(config, clientWith(async () => sse([completed([call('run_assign', '{"agent":"forge","phase":"build","title":"stale","subtask":"stale","eta":"soon"}')])])))
  const llm: LLM = { ...adapter, async complete(req) {
    requests.push(req)
    if (requests.length > 1) return createOpenAILLM(config, clientWith(async () => sse([completed([message('new run')])]))).complete(req)
    const result = await adapter.complete(req)
    pending.resolve(result)
    await release.promise
    return result
  } }
  const h = harness(t, never, { env, llm })
  await h.orchestrator.start()
  await pending.promise
  await h.orchestrator.start()
  await until(() => requests.length === 2 && h.store.stats().costUsd > 0)
  const newCost = h.store.stats().costUsd
  release.resolve()
  await until(() => h.store.lifetimeCostUsd() > newCost)
  assert.equal(h.store.stats().costUsd, newCost)
  assert.equal(h.store.tasks().length, 0)
  assert.equal(requests[1].messages.length, 2, 'only new wake and new response')
  assert.ok(!JSON.stringify(requests[1].messages).includes('stale'))
})

for (const terminal of ['done', 'failed'] as const) {
  test(`OpenAI ${terminal} suppresses later tool calls and records reported cost`, async (t) => {
    let merge = false
    let n = 0
    const llm = createOpenAILLM(config, clientWith(async () => {
      n++
      return sse([completed(merge ? [call('run_request_merge', '{"summary":"ready"}', 'merge'), call('run_assign', '{"agent":"forge","phase":"build","title":"late","subtask":"late","eta":"soon"}', 'late')] : [message()], undefined, merge && terminal === 'failed' ? 'failed' : 'completed')])
    }))
    const h = harness(t, never, { env, llm })
    await h.orchestrator.start()
    await until(() => h.store.stats().costUsd > 0)
    await ready(h.workspace)
    h.orchestrator.setGate(false)
    merge = true
    await h.orchestrator.humanMessage('merge now', 'atlas')
    await until(() => h.store.snapshot().run.status === terminal)
    await settle()
    assert.equal(n, 2)
    assert.equal(h.store.tasks().length, 0)
    assert.ok(h.store.stats().costUsd > .01)
  })
}

test('OpenAI missing usage is disclosed on interruption and survives lifetime reset', async (t) => {
  const called = deferred<void>()
  const llm = createOpenAILLM(config, clientWith(async (_url, init) => {
    called.resolve()
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
  }))
  const h = harness(t, never, { env, llm })
  await h.orchestrator.start()
  await called.promise
  h.orchestrator.interrupt('atlas')
  await until(() => h.store.stats().unreportedRequests === 1)
  assert.equal(h.store.snapshot().run.status, 'live')
  assert.equal(h.store.stats().lifetimeUnreportedRequests, 1)
  h.store.reset({})
  assert.equal(h.store.stats().unreportedRequests, 0)
  assert.equal(h.store.stats().lifetimeUnreportedRequests, 1)
})

test('OpenAI pause holds tool dispatch and resume releases it', async (t) => {
  let n = 0
  const adapter = createOpenAILLM(config, clientWith(async () => sse([completed(++n === 1 ? [call('run_assign', '{"agent":"forge","phase":"build","title":"paused","subtask":"held","eta":"soon"}')] : [message()])])))
  const got = deferred<void>()
  const release = deferred<void>()
  const llm: LLM = { ...adapter, async complete(req) { const result = await adapter.complete(req); if (n === 1) { got.resolve(); await release.promise } return result } }
  const h = harness(t, never, { env, llm })
  await h.orchestrator.start()
  await got.promise
  h.orchestrator.pause()
  release.resolve()
  await settle()
  assert.equal(h.store.tasks().length, 0)
  assert.equal(n, 1)
  h.orchestrator.resume()
  await until(() => h.store.tasks().length === 1)
})


test('OpenAI reported usage enforces the run budget before a tool executes', async (t) => {
  const llm = createOpenAILLM(config, clientWith(async () => sse([completed([call('run_assign', '{"agent":"forge","phase":"build","title":"over budget","subtask":"bad","eta":"soon"}')])])))
  const h = harness(t, never, { env: { ...env, RUN_BUDGET_USD: '.001' }, llm })
  await h.orchestrator.start()
  await until(() => h.store.snapshot().run.status === 'failed')
  assert.match(h.store.snapshot().run.error!, /budget/)
  assert.equal(h.store.tasks().length, 0)
  assert.ok(h.store.stats().costUsd > .005)
})
