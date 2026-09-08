import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandController, DraftBuffer, type Command, type AdmissionToken } from '../src/api/commandState.js'
import { isSequence, parseJson, validateAcknowledgement, validateEvent, validateSnapshot } from '../src/api/runValidation.js'
import { createRunStore } from '../server/run.js'
import { PERSONAS } from '../server/agents.js'
import { loadConfig } from '../server/config.js'
import type { CommandResult, RunSnapshot } from '../shared/protocol.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function baseline(sequence = 9, id = 'run-a'): RunSnapshot {
  const config = loadConfig({ MOCK_LLM: '1', LLM_PROVIDER: 'mock', AUTO_START: '0' })
  const s = createRunStore(PERSONAS, config.models).snapshot()
  return { ...s, seq: sequence, run: { ...s.run, id, status: 'live', approvalGate: false } }
}
function harness(initial = true) {
  let time = 0
  const timers = new Set<{ at: number; fn: () => void }>()
  const requests: Array<ReturnType<typeof deferred<CommandResult>> & { command: Command; signal: AbortSignal }> = []
  const reads: Array<ReturnType<typeof deferred<unknown>> & { signal: AbortSignal }> = []
  const refreshes: AbortSignal[] = []
  const controller = new CommandController(7, {
    execute(command, signal) { const request = { ...deferred<CommandResult>(), command, signal }; requests.push(request); return request.promise },
    fetchState(signal) { const read = { ...deferred<unknown>(), signal }; reads.push(read); return read.promise },
    refresh(signal) { refreshes.push(signal); controller.streamStarted(controller.diagnostics().epoch + 1) },
  }, {
    now: () => time,
    schedule(fn, ms) { const timer = { at: time + ms, fn }; timers.add(timer); return () => { timers.delete(timer) } },
  })
  function advance(to: number, fire = true) {
    time = to
    if (fire) for (const timer of [...timers].sort((a, b) => a.at - b.at)) if (timer.at <= time && timers.delete(timer)) timer.fn()
  }
  const snapshot = (full: RunSnapshot, epoch = controller.diagnostics().epoch) => controller.ingest({ type: 'snapshot', seq: full.seq, snapshot: full }, epoch)
  const event = (value: unknown, bytes?: number) => controller.ingest(value, controller.diagnostics().epoch, bytes)
  controller.streamStarted(1)
  controller.streamOpened(1)
  if (initial) snapshot(baseline())
  return { controller, requests, reads, refreshes, advance, snapshot, event, token: () => controller.getView().admission }
}
const message: Command = { kind: 'send', body: 'A deliberate instruction', target: 'all' }

test('01 strict ACK table separates valid JSON shapes, numeric overflow and parsing failures', () => {
  for (const seq of [0, 1, Number.MAX_SAFE_INTEGER]) assert.deepEqual(validateAcknowledgement(true, { parsed: true, value: { ok: true, seq, extra: true } }, 'bad'), { ok: true, seq })
  const invalid: unknown[] = [null, false, 1, 'yes', [], [{ ok: true, seq: 1 }], {}, { ok: 1, seq: 1 }, { ok: false, seq: 1 }, { ok: true }, ...['1', -1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].map((seq) => ({ ok: true, seq }))]
  for (const value of invalid) assert.throws(() => validateAcknowledgement(true, { parsed: true, value }, 'bad'), /invalid command response/)
  assert.equal(isSequence(NaN), false); assert.equal(isSequence(Infinity), false)
  assert.deepEqual(parseJson('NaN'), { parsed: false }); assert.deepEqual(parseJson('Infinity'), { parsed: false })
  assert.equal(parseJson('{"ok":true,"seq":1e400}').parsed, true)
  assert.throws(() => validateAcknowledgement(true, parseJson('{"ok":true,"seq":1e400}'), 'bad'))
  assert.throws(() => validateAcknowledgement(true, parseJson('{'), 'bad'), /invalid command response/)
})

test('02 rejection envelopes are bounded and never converted to acceptance by HTTP or truthiness', async () => {
  assert.throws(() => validateAcknowledgement(false, parseJson('{"ok":true,"seq":9}'), '409 rejected'), /409 rejected/)
  assert.throws(() => validateAcknowledgement(true, { parsed: true, value: { ok: false, error: 42 } }, 'bad'), /invalid command/)
  try { validateAcknowledgement(false, { parsed: true, value: { ok: false, error: 'x'.repeat(500) } }, 'bad') } catch (error) { assert.equal((error as Error).message.length, 240) }
  const h = harness()
  const first = h.controller.perform(message, h.token())
  h.requests[0].resolve({ ok: true, seq: '9' } as unknown as CommandResult)
  assert.equal((await first).kind, 'rejected')
  assert.equal(h.controller.diagnostics().ackFloor, 0)
  assert.equal(h.controller.getView().pending.length, 0)
  const next = h.controller.perform(message, h.token()); assert.equal(h.requests.length, 2)
  h.requests[1].resolve({ ok: true, seq: 9 }); assert.equal((await next).kind, 'accepted')
  h.controller.dispose()
})

test('03 ACK transfers to synchronization before acceptance; reverse settlement preserves newest error', async () => {
  const h = harness()
  const send = h.controller.perform(message, h.token())
  const interrupt = h.controller.perform({ kind: 'interrupt', id: 'forge' }, h.token())
  h.requests[1].reject(new Error('Newest interrupt failure')); await interrupt
  h.requests[0].resolve({ ok: true, seq: 11 })
  assert.equal((await send).kind, 'accepted')
  assert.equal(h.controller.getView().lastError, 'Newest interrupt failure')
  assert.equal(h.controller.getView().pending[0].phase, 'synchronizing')
  assert.equal((await h.controller.perform({ kind: 'interrupt', id: 'atlas' }, h.token())).kind, 'blocked')
  assert.equal(h.requests.length, 2); assert.equal(h.reads.length, 1)
  h.controller.dispose()
})

test('04 lost control10 then stats11 freezes baseline9 until a full snapshot through11', async () => {
  const h = harness()
  const send = h.controller.perform(message, h.token())
  h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  h.requests[0].resolve({ ok: true, seq: 10 }); await send
  assert.equal(h.controller.diagnostics().appliedSeq, 9); assert.equal(h.controller.diagnostics().observedHighWater, 11)
  for (const seq of [9, 10]) { h.snapshot(baseline(seq)); assert.equal(h.controller.diagnostics().appliedSeq, 9); assert.equal(h.controller.getView().mutationAvailable, false) }
  h.event({ type: 'run', seq: 10, run: { approvalGate: true } })
  assert.equal(h.controller.diagnostics().appliedSeq, 9)
  const full = baseline(11); full.run.approvalGate = true
  h.snapshot(full)
  assert.equal(h.controller.getView().snapshot?.run.approvalGate, true)
  assert.equal(h.controller.getView().mutationAvailable, true)
  assert.equal(h.reads.length, 1); assert.equal(h.reads[0].signal.aborted, true); assert.equal(h.requests.length, 1)
  h.controller.dispose()
})

test('05 ACK-only continuity heals and aborts obsolete read; replay is harmless; full snapshot can jump', async () => {
  const h = harness(); const old = h.token()
  const send = h.controller.perform(message, old)
  h.requests[0].resolve({ ok: true, seq: 11 }); await send
  h.event({ type: 'run', seq: 10, run: { approvalGate: true } })
  assert.equal(h.controller.getView().mutationAvailable, false)
  h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  assert.equal(h.controller.getView().mutationAvailable, true); assert.equal(h.reads[0].signal.aborted, true)
  const revision = h.token().gateRevision
  h.event({ type: 'run', seq: 10, run: { approvalGate: false } })
  assert.equal(h.token().gateRevision, revision)
  h.snapshot(baseline(80)); assert.equal(h.controller.diagnostics().appliedSeq, 80)
  h.reads[0].resolve(baseline(9)); await flush(); assert.equal(h.controller.diagnostics().appliedSeq, 80)
  h.controller.dispose()
})

test('06 full validation rejects malformed shape, mismatched envelopes and unknown/incompatible patches', () => {
  const full = baseline()
  assert.equal(validateSnapshot({ ...full, run: { ...full.run, approvalGate: 'yes' } }), null)
  assert.equal(validateSnapshot({ ...full, agents: null }), null)
  assert.equal(validateEvent({ type: 'snapshot', seq: 10, snapshot: full }), null)
  for (const event of [
    { type: 'thread.patch', seq: 10, id: 'missing', patch: { body: 'bad' } },
    { type: 'agent', seq: 10, id: 'unknown', patch: { status: 'working' } },
    { type: 'run', seq: 10, run: { id: 'another-run' } },
    { type: 'stats', seq: 10, stats: {} },
  ]) {
    const h = harness(); h.event(event)
    assert.equal(h.controller.diagnostics().appliedSeq, 9); assert.equal(h.controller.getView().mutationAvailable, false)
    assert.equal(h.reads.length, 1); h.controller.dispose()
  }
  const h = harness()
  h.event({ type: 'thread.append', seq: 10, item: { kind: 'message', id: 'msg', time: '12:00', who: 'forge', body: 'first' } })
  h.event({ type: 'thread.patch', seq: 11, id: 'msg', patch: { kind: 'tool', tool: 'bad' } })
  assert.equal(h.controller.diagnostics().appliedSeq, 10); h.controller.dispose()
})

test('06 quarantine requires a full floor then contiguous suffix and bounds both event count and bytes', () => {
  const h = harness()
  h.event({ type: 'run', seq: 11, run: { approvalGate: true } })
  h.event({ type: 'run', seq: 12, run: { status: 'paused' } })
  h.snapshot({ ...baseline(11), run: { ...baseline().run, approvalGate: true } })
  assert.equal(h.controller.diagnostics().appliedSeq, 12); assert.equal(h.controller.getView().snapshot?.run.status, 'paused')
  h.controller.dispose()
  for (const overflowBytes of [false, true]) {
    const h = harness()
    for (let seq = 11; seq < 270; seq++) h.event({ type: 'stats', seq, stats: baseline().stats }, overflowBytes ? 1_048_577 : 100)
    assert.ok(h.controller.diagnostics().bufferedEvents <= 256); assert.ok(h.controller.diagnostics().bufferedBytes <= 1_048_576)
    h.snapshot(baseline(268)); assert.equal(h.controller.getView().mutationAvailable, false)
    h.snapshot(baseline(269)); assert.equal(h.controller.getView().mutationAvailable, true)
    h.controller.dispose()
  }
})

test('06 a GET started before a later malformed frame cannot erase it or start a second read', async () => {
  const h = harness(); h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  h.event(null)
  h.reads[0].resolve(baseline(11)); await flush()
  assert.equal(h.controller.diagnostics().appliedSeq, 9); assert.equal(h.reads.length, 1)
  h.snapshot(baseline(11)); assert.equal(h.controller.getView().mutationAvailable, true)
  h.controller.dispose()
})

test('07 stale read success and rejection cannot regress, resurrect, or release a newer episode', async () => {
  for (const oldFailure of [false, true]) {
    const h = harness()
    h.event({ type: 'stats', seq: 11, stats: baseline().stats }); h.snapshot(baseline(11))
    h.event({ type: 'stats', seq: 13, stats: baseline().stats })
    assert.equal(h.reads.length, 2)
    if (oldFailure) h.reads[0].reject(new Error('Old GET failed')); else h.reads[0].resolve(baseline(9))
    await flush()
    assert.equal(h.controller.diagnostics().appliedSeq, 11); assert.equal(h.reads[1].signal.aborted, false)
    assert.equal(h.controller.getView().lastError, null); assert.ok(h.controller.getView().synchronization)
    h.reads[1].resolve(baseline(13)); await flush(); assert.equal(h.controller.getView().mutationAvailable, true)
    h.controller.dispose()
  }
})

test('08 one absolute network/sync deadline survives ACK at14s and delayed timer completion', async () => {
  const h = harness(); const send = h.controller.perform(message, h.token())
  h.advance(14_000); h.requests[0].resolve({ ok: true, seq: 11 }); assert.equal((await send).kind, 'accepted')
  assert.equal(h.controller.getView().synchronization?.deadline, 15_000)
  h.controller.streamError(1); h.controller.streamStarted(2); h.controller.streamOpened(2)
  assert.equal(h.controller.getView().synchronization?.deadline, 15_000)
  h.advance(15_000)
  assert.equal(h.controller.getView().coherence, 'needs_refresh'); assert.equal(h.controller.getView().pending.length, 0)
  assert.equal(h.controller.getView().synchronization, null); assert.equal(h.reads[0].signal.aborted, true)
  h.snapshot(baseline(9)); assert.equal(h.controller.getView().mutationAvailable, false)
  h.snapshot(baseline(11)); assert.equal(h.controller.getView().mutationAvailable, true)
  h.controller.dispose()
  const late = harness(); const outcome = late.controller.perform(message, late.token())
  late.advance(15_001, false); late.requests[0].resolve({ ok: true, seq: 9 })
  assert.equal((await outcome).kind, 'rejected'); assert.equal(late.controller.diagnostics().ackFloor, 0)
  assert.equal(late.controller.getView().coherence, 'coherent'); assert.equal(late.requests.length, 1)
  late.controller.dispose()
})

test('09 explicit refresh is bounded, single-flight, initial-snapshot gated and old-source fenced', async () => {
  const h = harness(false); h.advance(15_000)
  const old = h.token(); const refresh = h.controller.refreshState(old)
  assert.equal(await h.controller.refreshState(old), 'unavailable'); assert.equal(h.refreshes.length, 1)
  h.controller.streamOpened(2); assert.equal(h.controller.getView().mutationAvailable, false)
  h.snapshot(baseline(), 1); assert.equal(h.controller.getView().snapshot, null)
  h.snapshot(baseline(), 2); assert.equal(await refresh, 'refreshed'); assert.equal(h.controller.getView().mutationAvailable, true)
  h.controller.streamError(2); h.advance(30_000)
  const failed = h.controller.refreshState(h.token()); h.controller.streamError(3)
  assert.equal(await failed, 'unavailable'); assert.equal(h.refreshes[1].aborted, true)
  const timed = h.controller.refreshState(h.token()); h.advance(45_000)
  assert.equal(await timed, 'unavailable'); assert.equal(h.controller.getView().refreshPending, false)
  assert.equal(h.refreshes.length, 3); h.controller.dispose()
})

test('09 only a new active stream initial snapshot may rebase a lower different-run seq', async () => {
  const h = harness(); const send = h.controller.perform(message, h.token())
  h.requests[0].resolve({ ok: true, seq: 11 }); await send
  h.reads[0].resolve(baseline(1, 'new-server')); await flush()
  assert.equal(h.controller.getView().snapshot?.run.id, 'run-a')
  h.controller.streamStarted(2); h.controller.streamOpened(2)
  h.snapshot(baseline(9)); assert.equal(h.controller.getView().mutationAvailable, false)
  h.snapshot(baseline(1, 'new-server'))
  assert.equal(h.controller.getView().snapshot?.run.id, 'new-server'); assert.equal(h.controller.diagnostics().ackFloor, 0)
  assert.equal(h.controller.getView().mutationAvailable, true)
  h.controller.dispose()
})

test('10 gap coalesces concurrent send/interrupt, expiry clears all tickets; cleanup fences reads', async () => {
  const h = harness(); const a = h.controller.perform(message, h.token()); const b = h.controller.perform({ kind: 'interrupt', id: 'forge' }, h.token())
  h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  h.requests[1].resolve({ ok: true, seq: 10 }); assert.equal((await b).kind, 'accepted')
  assert.equal(h.controller.getView().pending.length, 2)
  h.advance(15_000); assert.equal((await a).kind, 'rejected')
  assert.equal(h.controller.getView().pending.length, 0); assert.equal(h.reads.length, 1)
  assert.ok(h.requests.every((r) => r.signal.aborted)); assert.equal(h.controller.getView().coherence, 'needs_refresh')
  h.controller.dispose(); h.reads[0].resolve(baseline(11)); await flush(); assert.equal(h.controller.getView().snapshot, null)
})

test('11 old rendered callbacks cannot bind a replacement run before the next React commit', async () => {
  const h = harness(); const rendered = h.token()
  const oldGate = () => h.controller.perform({ kind: 'gate', enabled: true }, rendered)
  h.snapshot(baseline(12, 'run-b')) // Ref ingestion; intentionally do not obtain a new render token yet.
  assert.equal((await oldGate()).kind, 'obsolete'); assert.equal(h.requests.length, 0)
  const committed = h.token(); const current = h.controller.perform({ kind: 'gate', enabled: true }, committed)
  assert.equal(h.requests.length, 1); h.requests[0].resolve({ ok: true, seq: 12 }); assert.equal((await current).kind, 'accepted')
  h.controller.dispose()
})

test('12 status/gate ABA and PR/phase revisions fence intent while stats leave it usable', async () => {
  const h = harness(); const old = h.token()
  h.event({ type: 'run', seq: 10, run: { status: 'paused', approvalGate: true } })
  h.event({ type: 'run', seq: 11, run: { status: 'live', approvalGate: false } })
  assert.equal((await h.controller.perform({ kind: 'pause' }, old)).kind, 'blocked')
  assert.equal((await h.controller.perform({ kind: 'gate', enabled: true }, old)).kind, 'blocked')
  const current = h.token(); h.event({ type: 'stats', seq: 12, stats: baseline().stats })
  const pause = h.controller.perform({ kind: 'pause' }, current); assert.equal(h.requests.length, 1)
  h.requests[0].resolve({ ok: true, seq: 12 }); await pause
  h.event({ type: 'run', seq: 13, run: { status: 'needs_approval' } }); const approval = h.token()
  h.event({ type: 'pipeline', seq: 14, pipeline: { ...baseline().pipeline, pr: 'PR #900', phase: 'ship' } })
  assert.equal((await h.controller.perform({ kind: 'approve' }, approval)).kind, 'blocked'); assert.equal(h.requests.length, 1)
  h.controller.dispose()
})

test('13 missing/initial/readiness ABA and StrictMode/auth lifetime tokens never issue POSTs', async () => {
  const h = harness(false)
  assert.equal((await h.controller.perform({ kind: 'start' }, undefined as unknown as AdmissionToken)).kind, 'blocked')
  assert.equal((await h.controller.perform({ kind: 'start' }, h.token())).kind, 'blocked')
  h.snapshot(baseline()); const old = h.token()
  h.event({ type: 'stats', seq: 11, stats: baseline().stats }); h.snapshot(baseline(11))
  assert.equal((await h.controller.perform(message, old)).kind, 'blocked')
  const beforeCleanup = h.token(); h.controller.dispose()
  assert.equal((await h.controller.perform(message, beforeCleanup)).kind, 'obsolete')
  const next = harness(); assert.equal((await next.controller.perform(message, beforeCleanup)).kind, 'obsolete')
  assert.equal(h.requests.length + next.requests.length, 0); next.controller.dispose()
})

test('14 draft transactions protect raw edits, target edits, edit-and-revert and replacement context', () => {
  const draft = new DraftBuffer(); const h = harness()
  const accepted = { kind: 'accepted' as const, contextGeneration: h.token().contextGeneration, attemptId: 1, seq: 9 }
  const capture = draft.edit('  original  ', 'forge')
  assert.equal(draft.clearAccepted(capture, accepted, h.controller.isCurrentContext), true)
  assert.equal(draft.clearAccepted(capture, accepted, h.controller.isCurrentContext), false)
  for (const edit of [() => draft.edit('new'), () => draft.edit('  original  ', 'atlas'), () => { draft.edit('different'); draft.edit('  original  ', 'forge') }]) {
    const capture = draft.edit('  original  ', 'forge'); edit()
    const current = draft.read(); assert.equal(draft.clearAccepted(capture, accepted, h.controller.isCurrentContext), false); assert.deepEqual(draft.read(), current)
  }
  const current = draft.read(); h.snapshot(baseline(10, 'new-run'))
  assert.equal(draft.clearAccepted(current, accepted, h.controller.isCurrentContext), false); assert.deepEqual(draft.read(), current)
  h.controller.dispose()
})

test('15 synchronous lane matrix blocks duplicates/global/slash and permits different-agent interrupts', async () => {
  const h = harness(); const token = h.token()
  const first = h.controller.perform(message, token)
  assert.equal((await h.controller.perform(message, token)).kind, 'blocked')
  assert.equal((await h.controller.perform({ kind: 'send', body: '/anything', target: 'all' }, token)).kind, 'blocked')
  assert.equal((await h.controller.perform({ kind: 'pause' }, token)).kind, 'blocked')
  const forge = h.controller.perform({ kind: 'interrupt', id: 'forge' }, token)
  assert.equal((await h.controller.perform({ kind: 'interrupt', id: 'forge' }, token)).kind, 'blocked')
  const atlas = h.controller.perform({ kind: 'interrupt', id: 'atlas' }, token)
  assert.deepEqual(h.requests.map((r) => r.command), [message, { kind: 'interrupt', id: 'forge' }, { kind: 'interrupt', id: 'atlas' }])
  h.requests[2].reject(new Error('latest')); await atlas
  h.requests[0].reject(new Error('old')); await first
  h.requests[1].resolve({ ok: true, seq: 9 }); await forge
  assert.equal(h.controller.getView().lastError, 'latest'); assert.equal(h.controller.getView().pending.length, 0)
  const slash = h.controller.perform({ kind: 'send', body: '/pause', target: 'all' }, h.token())
  assert.equal((await h.controller.perform({ kind: 'interrupt', id: 'forge' }, h.token())).kind, 'blocked')
  h.requests[3].resolve({ ok: true, seq: 9 }); await slash
  assert.equal(h.controller.getView().lastError, null); h.controller.dispose()
})

test('09 forward replacement snapshot invalidates old ACK obligations before coverage comparison', async () => {
  const h = harness(); const draft = new DraftBuffer(); const capture = draft.edit('Keep this for the next run')
  const send = h.controller.perform(message, h.token())
  h.requests[0].resolve({ ok: true, seq: 100 }); const outcome = await send
  h.reads[0].resolve(baseline(20, 'new-run')); await flush()
  assert.equal(h.controller.getView().snapshot?.run.id, 'new-run')
  assert.equal(h.controller.diagnostics().ackFloor, 0); assert.equal(h.controller.getView().mutationAvailable, true)
  assert.equal(draft.clearAccepted(capture, outcome, h.controller.isCurrentContext), false)
  assert.equal(draft.read().raw, capture.raw); h.controller.dispose()
})

test('08 late read and manual completions cannot defeat a delayed timer or invent a second automatic read', async () => {
  const h = harness(); h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  h.advance(15_001, false); h.reads[0].resolve(baseline(11)); await flush()
  assert.equal(h.controller.getView().coherence, 'needs_refresh'); assert.equal(h.controller.diagnostics().appliedSeq, 9)
  const attempt = h.controller.refreshState(h.token()); h.controller.streamOpened(2)
  h.advance(30_002, false); h.snapshot(baseline(11))
  assert.equal(await attempt, 'unavailable'); assert.equal(h.controller.diagnostics().appliedSeq, 9)
  assert.equal(h.reads.length, 1); assert.equal(h.controller.getView().refreshPending, false)
  h.controller.dispose()
})

test('11 idle Start callback is obsolete after reset; an admitted old command settles obsolete without draft loss', async () => {
  const h = harness(); const idle = baseline(); idle.run.status = 'idle'; h.snapshot(idle)
  const rendered = h.token(); const oldStart = () => h.controller.perform({ kind: 'start' }, rendered)
  const first = oldStart(); assert.equal(h.requests.length, 1)
  h.snapshot(baseline(10, 'replacement'))
  assert.equal((await first).kind, 'obsolete')
  assert.equal((await oldStart()).kind, 'obsolete')
  h.requests[0].resolve({ ok: true, seq: 10 }); await flush()
  assert.equal(h.controller.getView().pending.length, 0); assert.equal(h.requests.length, 1)
  h.controller.dispose()
})

test('14 slash intent and literal payload/target are captured once, ordinary target remains explicit', async () => {
  const h = harness(); const rendered = h.token()
  h.event({ type: 'run', seq: 10, run: { approvalGate: true } })
  assert.equal((await h.controller.perform({ kind: 'send', body: '/pause', target: 'forge' }, rendered)).kind, 'blocked')
  assert.equal((await h.controller.perform(message, { ...h.token(), authVersion: 8 })).kind, 'obsolete')
  const draft = new DraftBuffer(); const captured = draft.edit('  ordinary message  ', 'forge')
  const send = h.controller.perform({ kind: 'send', body: captured.raw.trim(), target: captured.target }, h.token())
  draft.edit('/pause', 'atlas')
  assert.deepEqual(h.requests[0].command, { kind: 'send', body: 'ordinary message', target: 'forge' })
  const interrupt = h.controller.perform({ kind: 'interrupt', id: 'probe' }, h.token())
  assert.deepEqual(h.requests[1].command, { kind: 'interrupt', id: 'probe' })
  h.requests[1].resolve({ ok: true, seq: 10 }); await interrupt
  h.requests[0].resolve({ ok: true, seq: 10 }); const outcome = await send
  assert.equal(draft.clearAccepted(captured, outcome, h.controller.isCurrentContext), false)
  assert.equal(draft.read().raw, '/pause'); h.controller.dispose()
})

test('06 consumed but unpublished sequence repairs conservatively; no event does not manufacture a gap', () => {
  const h = harness()
  // Private task/budget/no-seq changes publish nothing: the client has no gap to infer.
  assert.equal(h.reads.length, 0); assert.equal(h.controller.getView().mutationAvailable, true)
  // An exceptional consumed sequence10 is observationally indistinguishable from a dropped frame.
  h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  assert.equal(h.controller.diagnostics().appliedSeq, 9); assert.equal(h.reads.length, 1)
  h.snapshot(baseline(11)); assert.equal(h.controller.getView().mutationAvailable, true)
  // Normal reset is a full snapshot that continues the store counter.
  h.snapshot(baseline(12, 'reset-run')); assert.equal(h.controller.diagnostics().appliedSeq, 12)
  h.controller.dispose()
})

test('09 an equal-sequence different-run GET is not forward replacement authority', async () => {
  const h = harness(); h.event({ type: 'stats', seq: 11, stats: baseline().stats })
  h.reads[0].resolve(baseline(9, 'unproven-server')); await flush()
  assert.equal(h.controller.getView().snapshot?.run.id, 'run-a')
  assert.equal(h.controller.getView().mutationAvailable, false)
  h.controller.streamStarted(2); h.controller.streamOpened(2); h.snapshot(baseline(9, 'proven-new-server'))
  assert.equal(h.controller.getView().snapshot?.run.id, 'proven-new-server')
  assert.equal(h.controller.getView().mutationAvailable, true); h.controller.dispose()
})
