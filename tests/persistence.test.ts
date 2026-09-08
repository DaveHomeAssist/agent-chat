import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { RunEvent, RunSnapshot } from '../shared/protocol.js'
import {
  PersistenceConflictError,
  PersistenceCorruptError,
  PersistenceError,
  PersistenceLockError,
  PersistenceSchemaError,
  PersistenceValidationError,
  type DurableRunRepository,
  type OperationRecord,
  type PrivateCheckpointV1,
  type UsageRecord,
} from '../server/persistence/contracts.js'
import { openSqliteRunRepository, preservedWriterLocks } from '../server/persistence/sqlite.js'

let fixtureSequence = 0

function fixture(t: TestContext, name: string): { directory: string; databasePath: string } {
  const directory = join(tmpdir(), `agent-chat-persistence-${process.pid}-${++fixtureSequence}-${name}`)
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o700)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, databasePath: join(directory, 'runs.sqlite3') }
}

function snapshot(runId: string, seq: number, status: RunSnapshot['run']['status'] = 'live', costUsd = 0): RunSnapshot {
  return {
    seq,
    run: {
      id: runId,
      label: runId.toUpperCase(),
      status,
      approvalGate: true,
      channel: '#test',
      repo: 'example/repo',
      branch: 'worker/test',
      goal: 'Synthetic persistence test',
      startedAt: '09:00',
      toolServers: 0,
      llm: 'mock',
    },
    stats: {
      elapsedSec: seq,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      unreportedRequests: 0,
      lifetimeUnreportedRequests: 0,
      budgetUsd: 5,
      messages: 0,
      toolCalls: 0,
      handoffs: 0,
      decisions: 0,
    },
    agents: [],
    thread: [],
    pipeline: { phase: status === 'done' ? 'done' : 'spec', lanes: [], steps: [], pr: 'PR #1' },
    typing: [],
  }
}

function checkpoint(runId: string, seq: number, capturedAtMs = 100, note?: string): PrivateCheckpointV1 {
  return {
    schemaVersion: 1,
    runId,
    seq,
    capturedAtMs,
    capabilities: {
      publicSnapshot: 'complete',
      runnerState: 'unsupported',
      workspaceState: 'unsupported',
      providerContinuation: 'unsupported',
      automaticResume: 'unsupported',
    },
    ...(note ? { note } : {}),
  }
}

function event(value: RunSnapshot): RunEvent {
  return { type: 'run', seq: value.seq, run: { status: value.run.status } }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function operation(runId: string, state: OperationRecord['state'], intent = 'same-intent'): OperationRecord {
  return {
    operationId: `${runId}/provider/1`,
    runId,
    agentId: 'atlas',
    kind: 'provider',
    replayClass: 'external_ambiguous',
    state,
    requestHash: hash(intent),
    intent: { prompt: intent, private: 'provider-continuation-sentinel' },
    ...(state === 'completed' ? { outcome: { response: 'complete' } } : {}),
    createdAtMs: 100,
    startedAtMs: state === 'prepared' ? null : 110,
    completedAtMs: state === 'completed' ? 120 : null,
  }
}

function usage(runId: string, costUsd = 0.25): UsageRecord {
  return {
    operationId: `${runId}/provider/1`,
    runId,
    provider: 'mock',
    model: 'mock-model',
    state: 'reported',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    recordedAtMs: 120,
  }
}

function unknownUsage(runId: string): UsageRecord {
  return {
    operationId: `${runId}/provider/1`,
    runId,
    provider: 'mock',
    model: 'mock-model',
    state: 'unknown',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    recordedAtMs: 120,
  }
}

function commit(
  repository: DurableRunRepository,
  value: RunSnapshot,
  extra: { event?: RunEvent; operation?: OperationRecord; usage?: UsageRecord; note?: string; at?: number } = {},
): void {
  repository.commit({
    runId: value.run.id,
    snapshot: value,
    checkpoint: checkpoint(value.run.id, value.seq, extra.at ?? 100, extra.note),
    committedAtMs: extra.at ?? 100,
    ...(extra.event ? { event: extra.event } : {}),
    ...(extra.operation ? { operation: extra.operation } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
  })
}

test('rolls back public state and event when an operation transition fails', (t) => {
  const { databasePath } = fixture(t, 'rollback')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'rollback' })
  t.after(() => repository.close())
  const first = snapshot('run_rollback', 1)
  commit(repository, first)
  commit(repository, first, { operation: operation(first.run.id, 'prepared') })

  const second = snapshot(first.run.id, 2)
  assert.throws(
    () => commit(repository, second, { event: event(second), operation: operation(first.run.id, 'completed'), at: 200 }),
    PersistenceConflictError,
  )
  assert.deepEqual(repository.readPublic(first.run.id), first)
  assert.deepEqual(repository.readEvents(first.run.id), [])
  assert.equal(repository.inspectPrivate(first.run.id)?.operations[0]?.state, 'prepared')
})

test('reopens committed snapshots, ordered events, operations and usage exactly', (t) => {
  const { databasePath } = fixture(t, 'reopen')
  const runId = 'run_reopen'
  const first = snapshot(runId, 1)
  const second = snapshot(runId, 2, 'done', 0.25)
  const repository = openSqliteRunRepository({ databasePath, writerId: 'first' })
  commit(repository, first, { event: event(first), operation: operation(runId, 'prepared') })
  commit(repository, first, { operation: operation(runId, 'started'), at: 110 })
  commit(repository, second, { event: event(second), operation: operation(runId, 'completed'), usage: usage(runId), at: 120 })
  repository.close()

  const reopened = openSqliteRunRepository({ databasePath, writerId: 'second' })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.readPublic(runId), second)
  assert.deepEqual(reopened.readEvents(runId).map((item) => item.seq), [1, 2])
  assert.deepEqual(reopened.usageTotals(runId), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 0 })
  assert.deepEqual(reopened.usageTotals(), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 0 })
  assert.equal(reopened.classifyRecovery().kind, 'readable_only')
})

test('rejects schema, run identity and sequence mismatches without changing history', (t) => {
  const { databasePath } = fixture(t, 'validation')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'validation' })
  t.after(() => repository.close())
  const current = snapshot('run_validation', 2)
  commit(repository, current, { event: event(current) })

  assert.throws(() => repository.commit({
    runId: current.run.id,
    snapshot: current,
    checkpoint: checkpoint('run_other', current.seq),
    committedAtMs: 200,
  }), PersistenceValidationError)
  assert.throws(() => repository.commit({
    runId: current.run.id,
    snapshot: current,
    checkpoint: checkpoint(current.run.id, current.seq + 1),
    committedAtMs: 200,
  }), PersistenceValidationError)
  assert.throws(() => commit(repository, current, {
    event: { type: 'snapshot', seq: current.seq, snapshot: snapshot(current.run.id, current.seq, 'paused') },
    at: 200,
  }), PersistenceValidationError)
  const old = snapshot(current.run.id, 1)
  assert.throws(() => commit(repository, old, { event: event(old), at: 200 }), PersistenceConflictError)
  assert.throws(() => commit(repository, current, { at: 99 }), PersistenceConflictError)
  assert.deepEqual(repository.readPublic(current.run.id), current)
})

test('rejects unsupported database schemas and preserves their version', (t) => {
  const { databasePath } = fixture(t, 'schema')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'schema-one' })
  repository.close()
  const raw = new DatabaseSync(databasePath)
  raw.exec('PRAGMA user_version = 99')
  raw.close()
  assert.throws(() => openSqliteRunRepository({ databasePath, writerId: 'schema-two' }), PersistenceSchemaError)
  const inspect = new DatabaseSync(databasePath, { readOnly: true })
  const row = inspect.prepare('PRAGMA user_version').get() as Record<string, unknown>
  inspect.close()
  assert.equal(Number(Object.values(row)[0]), 99)
})

test('idempotent operation and usage submissions do not double count while conflicts fail', (t) => {
  const { databasePath } = fixture(t, 'idempotency')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'idempotency' })
  t.after(() => repository.close())
  const value = snapshot('run_idempotency', 1)
  commit(repository, value)

  const prepared = operation(value.run.id, 'prepared')
  commit(repository, value, { operation: prepared })
  commit(repository, value, { operation: prepared })
  assert.throws(
    () => commit(repository, value, { usage: usage(value.run.id), at: 120 }),
    PersistenceConflictError,
  )
  assert.throws(() => commit(repository, value, { operation: operation(value.run.id, 'prepared', 'different') }), PersistenceConflictError)

  const started = operation(value.run.id, 'started')
  commit(repository, value, { operation: started, at: 110 })
  commit(repository, value, { operation: started, at: 110 })
  const completed = operation(value.run.id, 'completed')
  const reported = usage(value.run.id)
  commit(repository, value, { operation: completed, usage: reported, at: 120 })
  commit(repository, value, { operation: completed, usage: reported, at: 120 })
  assert.equal(repository.inspectPrivate(value.run.id)?.operations.length, 1)
  assert.equal(repository.inspectPrivate(value.run.id)?.usage.length, 1)
  assert.deepEqual(repository.usageTotals(), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 0 })
  assert.throws(() => commit(repository, value, { usage: usage(value.run.id, 0.5), at: 130 }), PersistenceConflictError)
  assert.deepEqual(repository.usageTotals(), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 0 })
})

test('completed provider operations stay unknown until one idempotent usage record exists', (t) => {
  const { databasePath } = fixture(t, 'completed-missing-usage')
  let repository = openSqliteRunRepository({ databasePath, writerId: 'completed-one' })
  const first = snapshot('run_completed_unknown', 1, 'done')
  commit(repository, first, { operation: operation(first.run.id, 'prepared'), at: 100 })
  commit(repository, first, { operation: operation(first.run.id, 'started'), at: 110 })
  assert.deepEqual(repository.usageTotals(first.run.id), { reportedCostUsd: 0, reportedRequests: 0, unknownRequests: 1 })

  const completed = operation(first.run.id, 'completed')
  commit(repository, first, { operation: completed, at: 120 })
  commit(repository, first, { operation: completed, at: 120 })
  assert.deepEqual(repository.usageTotals(first.run.id), { reportedCostUsd: 0, reportedRequests: 0, unknownRequests: 1 })

  const explicitUnknown = unknownUsage(first.run.id)
  commit(repository, first, { usage: explicitUnknown, at: 130 })
  commit(repository, first, { usage: explicitUnknown, at: 130 })
  assert.deepEqual(repository.usageTotals(first.run.id), { reportedCostUsd: 0, reportedRequests: 0, unknownRequests: 1 })
  assert.throws(() => commit(repository, first, { usage: usage(first.run.id), at: 130 }), PersistenceConflictError)

  const second = snapshot('run_completed_reported', 1, 'done', 0.25)
  commit(repository, second, { operation: operation(second.run.id, 'prepared'), at: 200 })
  commit(repository, second, { operation: operation(second.run.id, 'started'), at: 210 })
  commit(repository, second, { operation: operation(second.run.id, 'completed'), usage: usage(second.run.id), at: 220 })
  assert.deepEqual(repository.usageTotals(), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 1 })
  repository.close()

  repository = openSqliteRunRepository({ databasePath, writerId: 'completed-two' })
  t.after(() => repository.close())
  assert.deepEqual(repository.usageTotals(), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 1 })
})

test('started provider operations remain held and count unknown once across repeated restarts', (t) => {
  const { databasePath } = fixture(t, 'unknown')
  const runId = 'run_unknown'
  const value = snapshot(runId, 1)
  let repository = openSqliteRunRepository({ databasePath, writerId: 'unknown-one' })
  commit(repository, value, { operation: operation(runId, 'prepared'), note: 'private-checkpoint-sentinel' })
  commit(repository, value, { operation: operation(runId, 'started'), note: 'private-checkpoint-sentinel', at: 110 })
  repository.close()

  repository = openSqliteRunRepository({ databasePath, writerId: 'unknown-two' })
  assert.equal(repository.classifyRecovery().kind, 'held_unknown')
  assert.deepEqual(repository.usageTotals(), { reportedCostUsd: 0, reportedRequests: 0, unknownRequests: 1 })
  const publicJson = JSON.stringify({ list: repository.listPublic(), snapshot: repository.readPublic(runId) })
  assert.doesNotMatch(publicJson, /private-checkpoint-sentinel|provider-continuation-sentinel/)
  assert.match(JSON.stringify(repository.inspectPrivate(runId)), /provider-continuation-sentinel/)
  repository.close()

  repository = openSqliteRunRepository({ databasePath, writerId: 'unknown-three' })
  t.after(() => repository.close())
  assert.equal(repository.classifyRecovery().kind, 'held_unknown')
  assert.equal(repository.usageTotals().unknownRequests, 1)
})

test('nonterminal incomplete checkpoints never imply resume capability', (t) => {
  const { databasePath } = fixture(t, 'incomplete')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'incomplete' })
  t.after(() => repository.close())
  commit(repository, snapshot('run_incomplete', 1))
  assert.deepEqual(repository.classifyRecovery(), {
    kind: 'held_incomplete',
    runId: 'run_incomplete',
    snapshot: snapshot('run_incomplete', 1),
    reason: 'private_resume_unsupported',
  })
})

test('one corrupt run stays unavailable while unrelated public history remains readable', (t) => {
  const { databasePath } = fixture(t, 'payload-corruption')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'corrupt-one' })
  const valid = snapshot('run_valid', 1, 'done')
  const damaged = snapshot('run_damaged', 1)
  commit(repository, valid, { at: 100 })
  commit(repository, damaged, { at: 200 })
  repository.close()

  const raw = new DatabaseSync(databasePath)
  raw.prepare('UPDATE runs SET public_snapshot_json = ? WHERE run_id = ?').run('{not-json', damaged.run.id)
  raw.close()

  const reopened = openSqliteRunRepository({ databasePath, writerId: 'corrupt-two' })
  t.after(() => reopened.close())
  assert.deepEqual(reopened.readPublic(valid.run.id), valid)
  assert.equal(reopened.readPublic(damaged.run.id), null)
  const summaries = reopened.listPublic()
  assert.equal(summaries.find((item) => item.runId === damaged.run.id)?.available, false)
  assert.equal(reopened.classifyRecovery().kind, 'held_corrupt')
  assert.ok(reopened.inspectPrivate(damaged.run.id)?.corrupt.includes('public_snapshot'))
})

test('schema-valid swapped identities and sequences are corrupt while unrelated history remains readable', (t) => {
  const { databasePath } = fixture(t, 'relational-readback')
  let repository = openSqliteRunRepository({ databasePath, writerId: 'readback-one' })
  const first = snapshot('run_readback_one', 1)
  const second = snapshot('run_readback_two', 1)
  const checkpointMismatch = snapshot('run_checkpoint_mismatch', 1)
  const valid = snapshot('run_readback_valid', 1, 'done')
  commit(repository, first, { event: { type: 'snapshot', seq: first.seq, snapshot: first }, at: 100 })
  commit(repository, second, { event: { type: 'snapshot', seq: second.seq, snapshot: second }, at: 200 })
  commit(repository, checkpointMismatch, { at: 300 })
  commit(repository, valid, { at: 400 })
  repository.close()

  let raw = new DatabaseSync(databasePath)
  const secondRow = raw.prepare('SELECT public_snapshot_json FROM runs WHERE run_id = ?').get(second.run.id) as { public_snapshot_json: string }
  const secondEvent = raw.prepare('SELECT event_json FROM events WHERE run_id = ?').get(second.run.id) as { event_json: string }
  const checkpointRow = raw.prepare('SELECT private_checkpoint_json FROM runs WHERE run_id = ?').get(checkpointMismatch.run.id) as { private_checkpoint_json: string }
  const wrongSequence = JSON.parse(checkpointRow.private_checkpoint_json) as PrivateCheckpointV1
  wrongSequence.seq++
  raw.prepare('UPDATE runs SET public_snapshot_json = ? WHERE run_id = ?').run(secondRow.public_snapshot_json, first.run.id)
  raw.prepare('UPDATE events SET event_json = ? WHERE run_id = ?').run(secondEvent.event_json, first.run.id)
  raw.prepare('UPDATE runs SET private_checkpoint_json = ? WHERE run_id = ?').run(JSON.stringify(wrongSequence), checkpointMismatch.run.id)
  const damagedEvidence = raw.prepare(`
    SELECT run_id, public_snapshot_json, private_checkpoint_json FROM runs
    WHERE run_id IN (?, ?) ORDER BY run_id
  `).all(first.run.id, checkpointMismatch.run.id)
  const damagedEventEvidence = raw.prepare('SELECT event_json FROM events WHERE run_id = ?').get(first.run.id)
  raw.close()

  repository = openSqliteRunRepository({ databasePath, writerId: 'readback-two' })
  assert.equal(repository.readPublic(first.run.id), null)
  assert.equal(repository.listPublic().find((item) => item.runId === first.run.id)?.available, false)
  assert.ok(repository.inspectPrivate(first.run.id)?.corrupt.includes('public_snapshot'))
  assert.ok(repository.inspectPrivate(first.run.id)?.corrupt.includes('event'))
  assert.throws(() => repository.readEvents(first.run.id), PersistenceCorruptError)
  assert.ok(repository.inspectPrivate(checkpointMismatch.run.id)?.corrupt.includes('private_checkpoint'))
  assert.deepEqual(repository.readPublic(valid.run.id), valid)
  repository.close()

  raw = new DatabaseSync(databasePath, { readOnly: true })
  const preservedEvidence = raw.prepare(`
    SELECT run_id, public_snapshot_json, private_checkpoint_json FROM runs
    WHERE run_id IN (?, ?) ORDER BY run_id
  `).all(first.run.id, checkpointMismatch.run.id)
  const preservedEventEvidence = raw.prepare('SELECT event_json FROM events WHERE run_id = ?').get(first.run.id)
  raw.close()
  assert.deepEqual(preservedEvidence, damagedEvidence)
  assert.deepEqual(preservedEventEvidence, damagedEventEvidence)
})

const accountingCorruptions: Array<{
  name: string
  mutate: (database: DatabaseSync, operationId: string, otherRunId: string) => void
}> = [
  {
    name: 'invalid usage state',
    mutate: (database, operationId) => { database.prepare("UPDATE usage_ledger SET usage_state = 'invalid' WHERE operation_id = ?").run(operationId) },
  },
  {
    name: 'negative cost',
    mutate: (database, operationId) => { database.prepare('UPDATE usage_ledger SET cost_usd = -1 WHERE operation_id = ?').run(operationId) },
  },
  {
    name: 'nonfinite cost',
    mutate: (database, operationId) => { database.prepare('UPDATE usage_ledger SET cost_usd = 1e999 WHERE operation_id = ?').run(operationId) },
  },
  {
    name: 'invalid model',
    mutate: (database, operationId) => { database.prepare("UPDATE usage_ledger SET model = 'bad model!' WHERE operation_id = ?").run(operationId) },
  },
  {
    name: 'provider mismatch',
    mutate: (database, operationId) => { database.prepare("UPDATE usage_ledger SET provider = 'openai' WHERE operation_id = ?").run(operationId) },
  },
  {
    name: 'non-provider operation relationship',
    mutate: (database, operationId) => { database.prepare("UPDATE operations SET kind = 'tool' WHERE operation_id = ?").run(operationId) },
  },
  {
    name: 'run ownership mismatch',
    mutate: (database, operationId, otherRunId) => { database.prepare('UPDATE usage_ledger SET run_id = ? WHERE operation_id = ?').run(otherRunId, operationId) },
  },
]

for (const accountingCorruption of accountingCorruptions) {
  test(`stored accounting rejects ${accountingCorruption.name} without repairing evidence`, (t) => {
    const slug = accountingCorruption.name.replaceAll(' ', '-')
    const { databasePath } = fixture(t, `accounting-${slug}`)
    let repository = openSqliteRunRepository({ databasePath, writerId: `accounting-${slug}-one` })
    const primary = snapshot(`run_accounting_${slug}`, 1, 'done', 0.25)
    const other = snapshot(`run_accounting_other_${slug}`, 1, 'done')
    commit(repository, primary, { operation: operation(primary.run.id, 'prepared'), at: 100 })
    commit(repository, primary, { operation: operation(primary.run.id, 'started'), at: 110 })
    commit(repository, primary, { operation: operation(primary.run.id, 'completed'), usage: usage(primary.run.id), at: 120 })
    commit(repository, other, { at: 200 })
    repository.close()

    let raw = new DatabaseSync(databasePath)
    accountingCorruption.mutate(raw, `${primary.run.id}/provider/1`, other.run.id)
    assert.equal(Object.values(raw.prepare('PRAGMA quick_check').get() as Record<string, unknown>)[0], 'ok')
    const damagedEvidence = raw.prepare(`
      SELECT u.operation_id, u.run_id, u.provider, u.model, u.usage_state, u.cost_usd, o.kind
      FROM usage_ledger u JOIN operations o ON o.operation_id = u.operation_id
    `).all()
    raw.close()

    repository = openSqliteRunRepository({ databasePath, writerId: `accounting-${slug}-two` })
    assert.throws(() => repository.usageTotals(), PersistenceCorruptError)
    assert.throws(() => repository.usageTotals(primary.run.id), PersistenceCorruptError)
    const records = [repository.inspectPrivate(primary.run.id), repository.inspectPrivate(other.run.id)]
    assert.equal(records.some((record) => record?.corrupt.includes('usage')), true)
    repository.close()

    raw = new DatabaseSync(databasePath, { readOnly: true })
    const preservedEvidence = raw.prepare(`
      SELECT u.operation_id, u.run_id, u.provider, u.model, u.usage_state, u.cost_usd, o.kind
      FROM usage_ledger u JOIN operations o ON o.operation_id = u.operation_id
    `).all()
    raw.close()
    assert.deepEqual(preservedEvidence, damagedEvidence)
  })
}

test('structurally corrupt database bytes are preserved and never replaced', (t) => {
  const { databasePath } = fixture(t, 'database-corruption')
  const original = Buffer.from('not a sqlite database\nprivate evidence\n')
  writeFileSync(databasePath, original, { mode: 0o600 })
  assert.throws(() => openSqliteRunRepository({ databasePath, writerId: 'corrupt-database' }), PersistenceCorruptError)
  assert.deepEqual(readFileSync(databasePath), original)
})

test('multiple run history keeps lifetime totals after later runs become terminal', (t) => {
  const { databasePath } = fixture(t, 'history')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'history' })
  t.after(() => repository.close())
  const first = snapshot('run_history_one', 1, 'done', 0.25)
  commit(repository, first, { operation: operation(first.run.id, 'prepared'), at: 100 })
  commit(repository, first, { operation: operation(first.run.id, 'started'), at: 110 })
  commit(repository, first, { operation: operation(first.run.id, 'completed'), usage: usage(first.run.id), at: 120 })
  const second = snapshot('run_history_two', 1, 'failed')
  commit(repository, second, { operation: operation(second.run.id, 'prepared'), at: 200 })
  commit(repository, second, { operation: operation(second.run.id, 'started'), at: 210 })

  assert.deepEqual(repository.listPublic().map((item) => item.runId), [second.run.id, first.run.id])
  assert.deepEqual(repository.usageTotals(), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 1 })
  assert.deepEqual(repository.usageTotals(first.run.id), { reportedCostUsd: 0.25, reportedRequests: 1, unknownRequests: 0 })
  assert.deepEqual(repository.usageTotals(second.run.id), { reportedCostUsd: 0, reportedRequests: 0, unknownRequests: 1 })
})

test('recovery classification does not hide an older unfinished run behind newer terminal history', (t) => {
  const { databasePath } = fixture(t, 'recovery-order')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'recovery-order' })
  t.after(() => repository.close())
  commit(repository, snapshot('run_unfinished', 1), { at: 100 })
  commit(repository, snapshot('run_newer_terminal', 1, 'done'), { at: 200 })
  const recovery = repository.classifyRecovery()
  assert.equal(recovery.kind, 'held_incomplete')
  assert.equal('runId' in recovery ? recovery.runId : null, 'run_unfinished')
})

test('terminal labels and newer ordinary holds cannot hide an unresolved started effect', (t) => {
  const { databasePath } = fixture(t, 'terminal-unknown')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'terminal-unknown' })
  t.after(() => repository.close())
  const ambiguous = snapshot('run_terminal_unknown', 1, 'failed')
  commit(repository, ambiguous, { operation: operation(ambiguous.run.id, 'prepared'), at: 100 })
  commit(repository, ambiguous, { operation: operation(ambiguous.run.id, 'started'), at: 110 })
  commit(repository, snapshot('run_newer_ordinary_hold', 1), { at: 200 })

  const recovery = repository.classifyRecovery()
  assert.equal(recovery.kind, 'held_unknown')
  assert.equal('runId' in recovery ? recovery.runId : null, ambiguous.run.id)
  assert.deepEqual(recovery.kind === 'held_unknown' ? recovery.operations.map((item) => item.operationId) : [], [
    `${ambiguous.run.id}/provider/1`,
  ])
})

test('writer ownership serializes stale takeover, blocks a live peer and preserves a crashed lock', async (t) => {
  const { directory, databasePath } = fixture(t, 'writer')
  const first = openSqliteRunRepository({ databasePath, writerId: 'writer-one' })
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(statSync(databasePath).mode & 0o777, 0o600)
  assert.equal(statSync(`${databasePath}.writer.lock`).mode & 0o777, 0o600)
  assert.throws(() => openSqliteRunRepository({ databasePath, writerId: 'writer-two' }), PersistenceLockError)
  first.close()

  const second = openSqliteRunRepository({ databasePath, writerId: 'writer-two' })
  second.close()

  const crashPath = join(directory, 'crash.sqlite3')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'server/persistence/sqlite.ts')).href
  const child = spawnSync(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '-e',
    `import { openSqliteRunRepository } from ${JSON.stringify(moduleUrl)}; openSqliteRunRepository({ databasePath: ${JSON.stringify(crashPath)}, writerId: 'crashed-child' }); process.exit(0)`,
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(existsSync(`${crashPath}.writer.lock`), true)

  const guardPath = `${crashPath}.writer.guard`
  const guardHolder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { mkdirSync, rmdirSync } from 'node:fs'; const path = ${JSON.stringify(guardPath)}; mkdirSync(path, { mode: 0o700 }); process.stdout.write('ready\\n'); process.stdin.once('data', () => { rmdirSync(path); process.exit(0) }); process.stdin.resume()`,
  ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
  if (!guardHolder.stdout || !guardHolder.stdin || !guardHolder.stderr) throw new Error('guard holder pipes unavailable')
  let guardError = ''
  guardHolder.stderr.on('data', (chunk) => { guardError += String(chunk) })
  const [ready] = await once(guardHolder.stdout, 'data')
  assert.equal(String(ready), 'ready\n')
  const staleEvidence = readFileSync(`${crashPath}.writer.lock`)
  try {
    assert.throws(
      () => openSqliteRunRepository({ databasePath: crashPath, writerId: 'competing-takeover', busyTimeoutMs: 0 }),
      PersistenceLockError,
    )
    assert.deepEqual(readFileSync(`${crashPath}.writer.lock`), staleEvidence)
  } finally {
    guardHolder.stdin.write('release\n')
    const [exitCode] = await once(guardHolder, 'exit')
    assert.equal(exitCode, 0, guardError)
  }

  const restarted = openSqliteRunRepository({ databasePath: crashPath, writerId: 'after-crash' })
  t.after(() => restarted.close())
  assert.equal(preservedWriterLocks(crashPath).length, 1)
})

test('close retries only writer-lock cleanup after deterministic guard contention', async (t) => {
  const { databasePath } = fixture(t, 'close-retry')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'close-retry-one', busyTimeoutMs: 0 })
  const lockPath = `${databasePath}.writer.lock`
  const guardPath = `${databasePath}.writer.guard`
  const lockEvidence = readFileSync(lockPath)
  const guardHolder = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { mkdirSync, rmdirSync } from 'node:fs'; const path = ${JSON.stringify(guardPath)}; mkdirSync(path, { mode: 0o700 }); process.stdout.write('ready\\n'); process.stdin.once('data', () => { rmdirSync(path); process.exit(0) }); process.stdin.resume()`,
  ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })
  if (!guardHolder.stdout || !guardHolder.stdin || !guardHolder.stderr) throw new Error('guard holder pipes unavailable')
  let guardError = ''
  guardHolder.stderr.on('data', (chunk) => { guardError += String(chunk) })
  const [ready] = await once(guardHolder.stdout, 'data')
  assert.equal(String(ready), 'ready\n')

  try {
    assert.throws(() => repository.close(), PersistenceLockError)
    assert.deepEqual(readFileSync(lockPath), lockEvidence)
    assert.equal(existsSync(guardPath), true)
    assert.throws(() => repository.listPublic(), PersistenceError)
  } finally {
    guardHolder.stdin.write('release\n')
    const [exitCode] = await once(guardHolder, 'exit')
    assert.equal(exitCode, 0, guardError)
  }

  repository.close()
  assert.equal(existsSync(lockPath), false)
  assert.doesNotThrow(() => repository.close())

  const reopened = openSqliteRunRepository({ databasePath, writerId: 'close-retry-two', busyTimeoutMs: 0 })
  reopened.close()
  assert.doesNotThrow(() => reopened.close())
})

test('close never removes or hides a differently owned writer lock', (t) => {
  const { databasePath } = fixture(t, 'close-foreign-owner')
  const repository = openSqliteRunRepository({ databasePath, writerId: 'original-owner', busyTimeoutMs: 0 })
  const lockPath = `${databasePath}.writer.lock`
  const original = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>
  const foreign = {
    ...original,
    writerId: 'different-owner',
    pid: process.pid,
    host: hostname(),
  }
  writeFileSync(lockPath, `${JSON.stringify(foreign)}\n`, { mode: 0o600 })
  const foreignEvidence = readFileSync(lockPath)

  assert.throws(() => repository.close(), PersistenceLockError)
  assert.deepEqual(readFileSync(lockPath), foreignEvidence)
  assert.throws(() => repository.listPublic(), PersistenceError)
  assert.throws(() => repository.close(), PersistenceLockError)
  assert.deepEqual(readFileSync(lockPath), foreignEvidence)
})

test('rejects repository-contained and direct symlink storage paths without creating data', (t) => {
  const repositoryPath = join(process.cwd(), 'tests/persistence/live.sqlite3')
  assert.throws(() => openSqliteRunRepository({ databasePath: repositoryPath, writerId: 'inside-repo' }), PersistenceValidationError)
  assert.equal(existsSync(repositoryPath), false)

  const { directory } = fixture(t, 'symlink')
  const target = join(directory, 'target')
  const linked = join(directory, 'linked')
  mkdirSync(target, { mode: 0o700 })
  symlinkSync(target, linked)
  assert.throws(() => openSqliteRunRepository({ databasePath: join(linked, 'runs.sqlite3'), writerId: 'symlink' }), PersistenceValidationError)
  assert.equal(existsSync(join(target, 'runs.sqlite3')), false)

  const gitFixture = join(directory, 'git-fixture')
  const gitStorage = join(gitFixture, 'storage')
  const realNestedParent = join(gitStorage, 'existing')
  const outside = join(directory, 'outside')
  mkdirSync(join(gitFixture, '.git'), { recursive: true, mode: 0o700 })
  mkdirSync(realNestedParent, { recursive: true, mode: 0o755 })
  mkdirSync(outside, { mode: 0o700 })
  writeFileSync(join(realNestedParent, 'marker'), 'preserve ancestry target\n', { mode: 0o640 })
  const routedAncestor = join(outside, 'route')
  symlinkSync(gitStorage, routedAncestor)
  const targetMode = statSync(realNestedParent).mode & 0o777
  const routedDatabase = join(routedAncestor, 'existing', 'new-private-state', 'runs.sqlite3')
  assert.throws(
    () => openSqliteRunRepository({ databasePath: routedDatabase, writerId: 'routed-into-git' }),
    PersistenceValidationError,
  )
  assert.equal(existsSync(join(realNestedParent, 'new-private-state')), false)
  assert.equal(statSync(realNestedParent).mode & 0o777, targetMode)
  assert.equal(readFileSync(join(realNestedParent, 'marker'), 'utf8'), 'preserve ancestry target\n')

  const lockTarget = join(directory, 'lock-target.json')
  const lockDatabase = join(directory, 'lock.sqlite3')
  writeFileSync(lockTarget, 'private lock target\n', { mode: 0o600 })
  symlinkSync(lockTarget, `${lockDatabase}.writer.lock`)
  assert.throws(() => openSqliteRunRepository({ databasePath: lockDatabase, writerId: 'lock-symlink' }), PersistenceLockError)
  assert.equal(readFileSync(lockTarget, 'utf8'), 'private lock target\n')
  assert.equal(existsSync(lockDatabase), false)
})
