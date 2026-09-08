import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { RunEvent, RunSnapshot } from '../shared/protocol.js'
import {
  PersistenceConflictError,
  PersistenceCorruptError,
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

test('writer ownership blocks a live peer, releases cleanly and preserves a crashed lock', (t) => {
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

  const restarted = openSqliteRunRepository({ databasePath: crashPath, writerId: 'after-crash' })
  t.after(() => restarted.close())
  assert.equal(preservedWriterLocks(crashPath).length, 1)
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

  const lockTarget = join(directory, 'lock-target.json')
  const lockDatabase = join(directory, 'lock.sqlite3')
  writeFileSync(lockTarget, 'private lock target\n', { mode: 0o600 })
  symlinkSync(lockTarget, `${lockDatabase}.writer.lock`)
  assert.throws(() => openSqliteRunRepository({ databasePath: lockDatabase, writerId: 'lock-symlink' }), PersistenceLockError)
  assert.equal(readFileSync(lockTarget, 'utf8'), 'private lock target\n')
  assert.equal(existsSync(lockDatabase), false)
})
