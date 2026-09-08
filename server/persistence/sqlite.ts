import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RunEvent, RunSnapshot } from '../../shared/protocol.js'
import {
  MINIMUM_NODE_VERSION,
  PERSISTENCE_SCHEMA_VERSION,
  PersistenceConflictError,
  PersistenceCorruptError,
  PersistenceError,
  PersistenceLockError,
  PersistenceSchemaError,
  PersistenceValidationError,
  type DurableCommit,
  type DurableRunRepository,
  type OperationRecord,
  type PrivateRunRecord,
  type PublicRunSummary,
  type RecoveryClassification,
  type SqliteRepositoryOptions,
  type UsageRecord,
  type UsageTotals,
} from './contracts.js'
import { classifyRunRecovery } from './recovery.js'
import {
  parseCheckpoint,
  parseCommit,
  parseEvent,
  parseOperation,
  parseSnapshot,
  parseStoredJson,
  parseUsage,
  stableJson,
} from './schema.js'

const DEFAULT_BUSY_TIMEOUT_MS = 250
const MAX_BUSY_TIMEOUT_MS = 5_000
const LOCK_VERSION = 1

interface LockRecord {
  version: typeof LOCK_VERSION
  writerId: string
  pid: number
  host: string
  createdAtMs: number
}

interface RunRow extends Record<string, unknown> {
  run_id: string
  label: string
  status: RunSnapshot['run']['status']
  provider: RunSnapshot['run']['llm']
  repo: string
  branch: string
  goal: string
  started_at: string
  ended_at_ms: number | null
  last_seq: number
  public_snapshot_json: string
  private_checkpoint_json: string
  created_at_ms: number
  updated_at_ms: number
}

interface EventRow extends Record<string, unknown> { event_json: string }
interface OperationRow extends Record<string, unknown> {
  operation_id: string
  run_id: string
  agent_id: string | null
  kind: OperationRecord['kind']
  replay_class: OperationRecord['replayClass']
  state: OperationRecord['state']
  request_hash: string
  intent_json: string
  outcome_json: string | null
  created_at_ms: number
  started_at_ms: number | null
  completed_at_ms: number | null
}

interface UsageRow extends Record<string, unknown> {
  operation_id: string
  run_id: string
  provider: UsageRecord['provider']
  model: string
  usage_state: UsageRecord['state']
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  cost_usd: number | null
  recorded_at_ms: number
}

const SCHEMA_SQL = `
  CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    goal TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at_ms INTEGER,
    last_seq INTEGER NOT NULL,
    public_snapshot_json TEXT NOT NULL,
    private_checkpoint_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE events (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  ) STRICT;

  CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    agent_id TEXT,
    kind TEXT NOT NULL,
    replay_class TEXT NOT NULL,
    state TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    outcome_json TEXT,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    completed_at_ms INTEGER
  ) STRICT;

  CREATE TABLE usage_ledger (
    operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    usage_state TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost_usd REAL,
    recorded_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX runs_updated_idx ON runs(updated_at_ms DESC, run_id DESC);
  CREATE INDEX operations_run_idx ON operations(run_id, created_at_ms, operation_id);
  CREATE INDEX usage_run_idx ON usage_ledger(run_id, recorded_at_ms, operation_id);
`

function sqliteValue<T>(value: unknown): T {
  return value as T
}

function assertNodeFloor(): void {
  const actual = process.versions.node.split('.').map(Number)
  const minimum = MINIMUM_NODE_VERSION.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (actual[index] > minimum[index]) return
    if (actual[index] < minimum[index]) {
      throw new PersistenceSchemaError(`persistence requires Node ${MINIMUM_NODE_VERSION} or newer`)
    }
  }
}

function validateOptions(options: SqliteRepositoryOptions): Required<SqliteRepositoryOptions> {
  if (!isAbsolute(options.databasePath)) throw new PersistenceValidationError('databasePath must be absolute')
  const databasePath = resolve(options.databasePath)
  const writerId = options.writerId ?? `writer_${randomUUID()}`
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(writerId)) throw new PersistenceValidationError('writerId is invalid')
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new PersistenceValidationError(`busyTimeoutMs must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}`)
  }
  return { databasePath, writerId, busyTimeoutMs }
}

function containsGitMetadata(path: string): boolean {
  let current = path
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function prepareDirectory(databasePath: string): string {
  const directory = dirname(databasePath)
  const nearest = (() => {
    let current = directory
    while (!existsSync(current)) current = dirname(current)
    return current
  })()
  if (containsGitMetadata(nearest)) throw new PersistenceValidationError('live persistence storage cannot be inside a Git checkout')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PersistenceValidationError('database parent must be a real directory')
  if (containsGitMetadata(directory)) throw new PersistenceValidationError('live persistence storage cannot be inside a Git checkout')
  chmodSync(directory, 0o700)
  return directory
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function ensurePrivateRegularFile(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PersistenceValidationError(`${basename(path)} must be a regular file`)
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | noFollowFlag(), 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new PersistenceValidationError(`${basename(path)} must be a regular file`)
    fchmodSync(fd, 0o600)
  } finally {
    closeSync(fd)
  }
}

function hardenSidecars(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PersistenceValidationError(`${basename(path)} must be a regular file`)
    chmodSync(path, 0o600)
  }
}

function lockJson(lock: LockRecord): string {
  return `${stableJson(lock)}\n`
}

function parseLock(raw: string): LockRecord {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new PersistenceLockError('writer lock is malformed and was preserved')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PersistenceLockError('writer lock is malformed and was preserved')
  const item = value as Partial<LockRecord>
  if (item.version !== LOCK_VERSION || typeof item.writerId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(item.writerId)
    || !Number.isSafeInteger(item.pid) || Number(item.pid) <= 0 || typeof item.host !== 'string'
    || !Number.isSafeInteger(item.createdAtMs) || Number(item.createdAtMs) < 0) {
    throw new PersistenceLockError('writer lock is malformed and was preserved')
  }
  return item as LockRecord
}

function processState(pid: number): 'alive' | 'dead' | 'ambiguous' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM') return 'alive'
    return 'ambiguous'
  }
}

function createLock(path: string, lock: LockRecord): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
  try {
    writeFileSync(fd, lockJson(lock), 'utf8')
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function acquireWriterLock(databasePath: string, writerId: string): { path: string; lock: LockRecord } {
  const path = `${databasePath}.writer.lock`
  const lock: LockRecord = { version: LOCK_VERSION, writerId, pid: process.pid, host: hostname(), createdAtMs: Date.now() }
  try {
    createLock(path, lock)
    return { path, lock }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code !== 'EEXIST') throw error
  }

  const lockStat = lstatSync(path)
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    throw new PersistenceLockError('writer lock is not a regular file and was preserved')
  }
  const raw = readFileSync(path, 'utf8')
  const previous = parseLock(raw)
  if (previous.host !== hostname()) throw new PersistenceLockError('writer lock belongs to another host and was preserved')
  const state = processState(previous.pid)
  if (state !== 'dead') throw new PersistenceLockError(`writer lock owner is ${state}; lock was preserved`)

  // A dead same-host PID is the only automatic takeover. Preserve the old lock
  // as evidence; PID reuse produces a conservative false-positive, never a steal.
  if (readFileSync(path, 'utf8') !== raw) throw new PersistenceLockError('writer lock changed during inspection and was preserved')
  const archived = `${path}.stale-${Date.now()}-${previous.writerId}-${randomUUID()}`
  renameSync(path, archived)
  try {
    createLock(path, lock)
  } catch (error) {
    throw new PersistenceLockError(`writer lock could not be acquired after preserving ${basename(archived)}`, { cause: error })
  }
  return { path, lock }
}

function releaseWriterLock(handle: { path: string; lock: LockRecord }): void {
  if (!existsSync(handle.path)) return
  const stat = lstatSync(handle.path)
  if (!stat.isFile() || stat.isSymbolicLink()) return
  let current: LockRecord
  try {
    current = parseLock(readFileSync(handle.path, 'utf8'))
  } catch {
    return
  }
  if (current.writerId !== handle.lock.writerId || current.pid !== handle.lock.pid || current.host !== handle.lock.host) return
  unlinkSync(handle.path)
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
  const value = row ? Object.values(row)[0] : undefined
  return Number(value)
}

function quickCheck(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[]
  if (!rows.length || rows.some((row) => Object.values(row)[0] !== 'ok')) {
    throw new PersistenceCorruptError('SQLite quick_check failed; database was preserved')
  }
}

function initializeSchema(db: DatabaseSync): void {
  const version = userVersion(db)
  if (version === PERSISTENCE_SCHEMA_VERSION) return
  if (version !== 0) throw new PersistenceSchemaError(`unsupported persistence schema version ${version}`)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
  if (tables.length) throw new PersistenceSchemaError('unversioned non-empty persistence database was preserved')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA_SQL)
    db.exec(`PRAGMA user_version = ${PERSISTENCE_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  }
}

function asRunRow(row: unknown): RunRow {
  return sqliteValue<RunRow>(row)
}

function rowToOperation(row: OperationRow): OperationRecord {
  return parseOperation({
    operationId: row.operation_id,
    runId: row.run_id,
    agentId: row.agent_id,
    kind: row.kind,
    replayClass: row.replay_class,
    state: row.state,
    requestHash: row.request_hash,
    intent: JSON.parse(row.intent_json),
    ...(row.outcome_json === null ? {} : { outcome: JSON.parse(row.outcome_json) }),
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
  })
}

function rowToUsage(row: UsageRow): UsageRecord {
  return parseUsage({
    operationId: row.operation_id,
    runId: row.run_id,
    provider: row.provider,
    model: row.model,
    state: row.usage_state,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costUsd: row.cost_usd,
    recordedAtMs: row.recorded_at_ms,
  })
}

function operationBase(operation: OperationRecord): object {
  return {
    operationId: operation.operationId,
    runId: operation.runId,
    agentId: operation.agentId,
    kind: operation.kind,
    replayClass: operation.replayClass,
    requestHash: operation.requestHash,
    intent: operation.intent,
    createdAtMs: operation.createdAtMs,
  }
}

class SqliteRunRepository implements DurableRunRepository {
  readonly databasePath: string
  readonly writerId: string
  readonly #directory: string
  readonly #lock: { path: string; lock: LockRecord }
  readonly #db: DatabaseSync
  #closed = false

  constructor(options: Required<SqliteRepositoryOptions>) {
    this.databasePath = options.databasePath
    this.writerId = options.writerId
    this.#directory = prepareDirectory(this.databasePath)
    this.#lock = acquireWriterLock(this.databasePath, this.writerId)
    let db: DatabaseSync | null = null
    try {
      ensurePrivateRegularFile(this.databasePath)
      db = new DatabaseSync(this.databasePath)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL')
      quickCheck(db)
      initializeSchema(db)
      quickCheck(db)
      hardenSidecars(this.databasePath)
      this.#db = db
    } catch (error) {
      try { db?.close() } catch { /* preserve the original error */ }
      releaseWriterLock(this.#lock)
      if (error instanceof PersistenceError) throw error
      throw new PersistenceCorruptError('SQLite database could not be opened or validated; existing files were preserved', { cause: error })
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new PersistenceError('persistence repository is closed')
  }

  commit(value: DurableCommit): void {
    this.#assertOpen()
    const input = parseCommit(value)
    const snapshotJson = stableJson(input.snapshot)
    const checkpointJson = stableJson(input.checkpoint)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const priorValue = this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(input.runId)
      const prior = priorValue ? asRunRow(priorValue) : null
      this.#validateSequence(input, prior, snapshotJson)
      this.#upsertRun(input, prior, snapshotJson, checkpointJson)
      if (input.event) this.#applyEvent(input.runId, input.event, input.committedAtMs)
      if (input.operation) this.#applyOperation(input.operation)
      if (input.usage) this.#applyUsage(input.usage)
      this.#db.exec('COMMIT')
    } catch (error) {
      try { this.#db.exec('ROLLBACK') } catch { /* preserve the original error */ }
      if (error instanceof PersistenceError) throw error
      throw new PersistenceError('durable commit failed with no partial write', { cause: error })
    }
    try {
      chmodSync(this.#directory, 0o700)
      hardenSidecars(this.databasePath)
    } catch (error) {
      throw new PersistenceError('durable commit completed but private file permissions could not be verified', { cause: error })
    }
  }

  #validateSequence(input: DurableCommit, prior: RunRow | null, snapshotJson: string): void {
    if (input.event && input.event.seq !== input.snapshot.seq) throw new PersistenceConflictError('event/snapshot sequence mismatch')
    if (!prior) return
    if (input.committedAtMs < prior.updated_at_ms) throw new PersistenceConflictError('commit time regressed')
    if (input.snapshot.seq < prior.last_seq) throw new PersistenceConflictError('snapshot sequence regressed')
    if (input.snapshot.seq > prior.last_seq && !input.event) {
      throw new PersistenceConflictError('an advancing public snapshot requires its event')
    }
    if (input.snapshot.seq === prior.last_seq && stableJson(JSON.parse(prior.public_snapshot_json)) !== snapshotJson) {
      throw new PersistenceConflictError('public snapshot conflicts at an existing sequence')
    }
  }

  #upsertRun(input: DurableCommit, prior: RunRow | null, snapshotJson: string, checkpointJson: string): void {
    const endedAtMs = input.snapshot.run.status === 'done' || input.snapshot.run.status === 'failed'
      ? prior?.ended_at_ms ?? input.committedAtMs
      : null
    this.#db.prepare(`
      INSERT INTO runs (
        run_id, label, status, provider, repo, branch, goal, started_at, ended_at_ms,
        last_seq, public_snapshot_json, private_checkpoint_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        label = excluded.label,
        status = excluded.status,
        provider = excluded.provider,
        repo = excluded.repo,
        branch = excluded.branch,
        goal = excluded.goal,
        started_at = excluded.started_at,
        ended_at_ms = excluded.ended_at_ms,
        last_seq = excluded.last_seq,
        public_snapshot_json = excluded.public_snapshot_json,
        private_checkpoint_json = excluded.private_checkpoint_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      input.runId,
      input.snapshot.run.label,
      input.snapshot.run.status,
      input.snapshot.run.llm,
      input.snapshot.run.repo,
      input.snapshot.run.branch,
      input.snapshot.run.goal,
      input.snapshot.run.startedAt,
      endedAtMs,
      input.snapshot.seq,
      snapshotJson,
      checkpointJson,
      prior?.created_at_ms ?? input.committedAtMs,
      input.committedAtMs,
    )
  }

  #applyEvent(runId: string, event: RunEvent, committedAtMs: number): void {
    const json = stableJson(event)
    const existing = this.#db.prepare('SELECT event_json FROM events WHERE run_id = ? AND seq = ?').get(runId, event.seq) as EventRow | undefined
    if (existing) {
      if (stableJson(JSON.parse(existing.event_json)) !== json) throw new PersistenceConflictError('event sequence was reused with different content')
      return
    }
    this.#db.prepare('INSERT INTO events (run_id, seq, type, event_json, created_at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(runId, event.seq, event.type, json, committedAtMs)
  }

  #applyOperation(operation: OperationRecord): void {
    const existingValue = this.#db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(operation.operationId)
    if (!existingValue) {
      if (operation.state !== 'prepared') throw new PersistenceConflictError('new operation must begin prepared')
      this.#db.prepare(`
        INSERT INTO operations (
          operation_id, run_id, agent_id, kind, replay_class, state, request_hash,
          intent_json, outcome_json, created_at_ms, started_at_ms, completed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId,
        operation.runId,
        operation.agentId,
        operation.kind,
        operation.replayClass,
        operation.state,
        operation.requestHash,
        stableJson(operation.intent),
        null,
        operation.createdAtMs,
        null,
        null,
      )
      return
    }

    const existing = rowToOperation(existingValue as OperationRow)
    if (stableJson(operationBase(existing)) !== stableJson(operationBase(operation))) {
      throw new PersistenceConflictError('operation identity was reused with conflicting intent')
    }
    if (existing.state === operation.state) {
      if (stableJson(existing) !== stableJson(operation)) throw new PersistenceConflictError('operation state was reused with conflicting content')
      return
    }
    const order = { prepared: 0, started: 1, completed: 2 } as const
    if (order[operation.state] !== order[existing.state] + 1) throw new PersistenceConflictError('illegal operation transition')
    this.#db.prepare(`
      UPDATE operations SET state = ?, outcome_json = ?, started_at_ms = ?, completed_at_ms = ?
      WHERE operation_id = ?
    `).run(
      operation.state,
      operation.outcome === undefined ? null : stableJson(operation.outcome),
      operation.startedAtMs,
      operation.completedAtMs,
      operation.operationId,
    )
  }

  #applyUsage(usage: UsageRecord): void {
    const operationValue = this.#db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(usage.operationId)
    if (!operationValue) throw new PersistenceConflictError('usage requires an existing operation')
    const operation = rowToOperation(operationValue as OperationRow)
    if (operation.runId !== usage.runId || operation.kind !== 'provider') {
      throw new PersistenceConflictError('usage must match a provider operation in the same run')
    }
    if (operation.state === 'prepared') throw new PersistenceConflictError('usage cannot be recorded before a provider operation starts')
    const existingValue = this.#db.prepare('SELECT * FROM usage_ledger WHERE operation_id = ?').get(usage.operationId)
    if (existingValue) {
      const existing = rowToUsage(existingValue as UsageRow)
      if (stableJson(existing) !== stableJson(usage)) throw new PersistenceConflictError('usage identity was reused with conflicting content')
      return
    }
    this.#db.prepare(`
      INSERT INTO usage_ledger (
        operation_id, run_id, provider, model, usage_state, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_usd, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usage.operationId,
      usage.runId,
      usage.provider,
      usage.model,
      usage.state,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.costUsd,
      usage.recordedAtMs,
    )
  }

  listPublic(limit = 50): PublicRunSummary[] {
    this.#assertOpen()
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new PersistenceValidationError('public history limit must be from 1 to 200')
    const rows = this.#db.prepare('SELECT * FROM runs ORDER BY updated_at_ms DESC, run_id DESC LIMIT ?').all(limit) as RunRow[]
    return rows.map((row) => this.#publicSummary(row))
  }

  #publicSummary(row: RunRow): PublicRunSummary {
    try {
      const snapshot = parseStoredJson(row.public_snapshot_json, parseSnapshot, 'stored public snapshot')
      return {
        runId: snapshot.run.id,
        label: snapshot.run.label,
        status: snapshot.run.status,
        provider: snapshot.run.llm,
        repo: snapshot.run.repo,
        branch: snapshot.run.branch,
        goal: snapshot.run.goal,
        startedAt: snapshot.run.startedAt,
        endedAtMs: row.ended_at_ms,
        seq: snapshot.seq,
        costUsd: snapshot.stats.costUsd,
        unreportedRequests: snapshot.stats.unreportedRequests,
        available: true,
      }
    } catch {
      return {
        runId: row.run_id,
        label: row.label,
        status: row.status,
        provider: row.provider,
        repo: row.repo,
        branch: row.branch,
        goal: row.goal,
        startedAt: row.started_at,
        endedAtMs: row.ended_at_ms,
        seq: row.last_seq,
        costUsd: null,
        unreportedRequests: null,
        available: false,
        unavailableReason: 'corrupt_public_snapshot',
      }
    }
  }

  readPublic(runId: string): RunSnapshot | null {
    this.#assertOpen()
    if (!runId) throw new PersistenceValidationError('runId is required')
    const row = this.#db.prepare('SELECT public_snapshot_json FROM runs WHERE run_id = ?').get(runId) as { public_snapshot_json: string } | undefined
    if (!row) return null
    try {
      return structuredClone(parseStoredJson(row.public_snapshot_json, parseSnapshot, 'stored public snapshot'))
    } catch {
      return null
    }
  }

  inspectPrivate(runId: string): PrivateRunRecord | null {
    this.#assertOpen()
    const value = this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (!value) return null
    const row = asRunRow(value)
    const corrupt: PrivateRunRecord['corrupt'] = []
    let snapshot: RunSnapshot | null = null
    let checkpoint: PrivateRunRecord['checkpoint'] = null
    try { snapshot = parseStoredJson(row.public_snapshot_json, parseSnapshot, 'stored public snapshot') } catch { corrupt.push('public_snapshot') }
    try { checkpoint = parseStoredJson(row.private_checkpoint_json, parseCheckpoint, 'stored private checkpoint') } catch { corrupt.push('private_checkpoint') }

    const events: RunEvent[] = []
    for (const event of this.#db.prepare('SELECT event_json FROM events WHERE run_id = ? ORDER BY seq').all(runId) as EventRow[]) {
      try { events.push(parseStoredJson(event.event_json, parseEvent, 'stored event')) } catch { if (!corrupt.includes('event')) corrupt.push('event') }
    }
    const operations: OperationRecord[] = []
    for (const operation of this.#db.prepare('SELECT * FROM operations WHERE run_id = ? ORDER BY created_at_ms, operation_id').all(runId) as OperationRow[]) {
      try { operations.push(rowToOperation(operation)) } catch { if (!corrupt.includes('operation')) corrupt.push('operation') }
    }
    const usage: UsageRecord[] = []
    for (const item of this.#db.prepare('SELECT * FROM usage_ledger WHERE run_id = ? ORDER BY recorded_at_ms, operation_id').all(runId) as UsageRow[]) {
      try { usage.push(rowToUsage(item)) } catch { if (!corrupt.includes('usage')) corrupt.push('usage') }
    }
    return { runId, snapshot: snapshot ? structuredClone(snapshot) : null, checkpoint: checkpoint ? structuredClone(checkpoint) : null, events, operations, usage, corrupt }
  }

  readEvents(runId: string): RunEvent[] {
    const record = this.inspectPrivate(runId)
    return record ? structuredClone(record.events) : []
  }

  usageTotals(runId?: string): UsageTotals {
    this.#assertOpen()
    const whereUsage = runId ? 'WHERE run_id = ?' : ''
    const usageArgs = runId ? [runId] : []
    const usage = this.#db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN usage_state = 'reported' THEN cost_usd ELSE 0 END), 0) AS reported_cost,
        COALESCE(SUM(CASE WHEN usage_state = 'reported' THEN 1 ELSE 0 END), 0) AS reported_requests,
        COALESCE(SUM(CASE WHEN usage_state = 'unknown' THEN 1 ELSE 0 END), 0) AS explicit_unknown
      FROM usage_ledger ${whereUsage}
    `).get(...usageArgs) as Record<string, unknown>
    const missingArgs = runId ? [runId] : []
    const missing = this.#db.prepare(`
      SELECT COUNT(*) AS derived_unknown
      FROM operations o
      LEFT JOIN usage_ledger u ON u.operation_id = o.operation_id
      WHERE o.kind = 'provider' AND o.state = 'started' AND u.operation_id IS NULL
      ${runId ? 'AND o.run_id = ?' : ''}
    `).get(...missingArgs) as Record<string, unknown>
    return {
      reportedCostUsd: Number(usage.reported_cost),
      reportedRequests: Number(usage.reported_requests),
      unknownRequests: Number(usage.explicit_unknown) + Number(missing.derived_unknown),
    }
  }

  classifyRecovery(): RecoveryClassification {
    this.#assertOpen()
    // A later terminal run must not hide an older unfinished run. Runtime
    // integration may enforce a single current run; the repository stays safe
    // when imported or partially migrated data contains more than one.
    const row = this.#db.prepare(`
      SELECT run_id FROM runs
      ORDER BY CASE WHEN status IN ('done', 'failed') THEN 1 ELSE 0 END,
        updated_at_ms DESC, run_id DESC
      LIMIT 1
    `).get() as { run_id: string } | undefined
    return classifyRunRecovery(row ? this.inspectPrivate(row.run_id) : null)
  }

  close(): void {
    if (this.#closed) return
    let closed = false
    try {
      hardenSidecars(this.databasePath)
      this.#db.close()
      closed = true
      this.#closed = true
    } finally {
      if (closed) releaseWriterLock(this.#lock)
    }
  }
}

export function openSqliteRunRepository(rawOptions: SqliteRepositoryOptions): DurableRunRepository {
  assertNodeFloor()
  const options = validateOptions(rawOptions)
  return new SqliteRunRepository(options)
}

/** Test/audit helper: names only, never file contents. */
export function preservedWriterLocks(databasePath: string): string[] {
  const directory = dirname(databasePath)
  const prefix = `${basename(databasePath)}.writer.lock.stale-`
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith(prefix)).sort() : []
}
