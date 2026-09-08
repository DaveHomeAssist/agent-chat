import type { RunEvent, RunSnapshot } from '../../shared/protocol.js'

export const PERSISTENCE_SCHEMA_VERSION = 1 as const
export const MINIMUM_NODE_VERSION = '22.13.0' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/**
 * Version 1 deliberately stores no executable runner/workspace continuation.
 * Integration can add a new schema version only after those serializers and
 * their resume policy are reviewed together.
 */
export interface PrivateCheckpointV1 {
  schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION
  runId: string
  seq: number
  capturedAtMs: number
  capabilities: {
    publicSnapshot: 'complete'
    runnerState: 'unsupported'
    workspaceState: 'unsupported'
    providerContinuation: 'unsupported'
    automaticResume: 'unsupported'
  }
  note?: string
}

export type OperationKind = 'provider' | 'tool' | 'external'
export type ReplayClass = 'pure' | 'local_idempotent' | 'external_reconcilable' | 'external_ambiguous'
export type OperationState = 'prepared' | 'started' | 'completed'

export interface OperationRecord {
  operationId: string
  runId: string
  agentId: string | null
  kind: OperationKind
  replayClass: ReplayClass
  state: OperationState
  requestHash: string
  intent: JsonValue
  outcome?: JsonValue
  createdAtMs: number
  startedAtMs: number | null
  completedAtMs: number | null
}

export type UsageState = 'reported' | 'unknown'

export interface UsageRecord {
  operationId: string
  runId: string
  provider: 'anthropic' | 'openai' | 'mock'
  model: string
  state: UsageState
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number | null
  recordedAtMs: number
}

export interface DurableCommit {
  runId: string
  snapshot: RunSnapshot
  checkpoint: PrivateCheckpointV1
  committedAtMs: number
  event?: RunEvent
  operation?: OperationRecord
  usage?: UsageRecord
}

/** Deliberate public allowlist. No private payload is reachable from this type. */
export interface PublicRunSummary {
  runId: string
  label: string
  status: RunSnapshot['run']['status']
  provider: RunSnapshot['run']['llm']
  repo: string
  branch: string
  goal: string
  startedAt: string
  endedAtMs: number | null
  seq: number
  /** Null when the stored public payload is unavailable; never substitute zero. */
  costUsd: number | null
  unreportedRequests: number | null
  available: boolean
  unavailableReason?: 'corrupt_public_snapshot'
}

export interface UsageTotals {
  reportedCostUsd: number
  reportedRequests: number
  unknownRequests: number
}

export interface PrivateRunRecord {
  runId: string
  snapshot: RunSnapshot | null
  checkpoint: PrivateCheckpointV1 | null
  events: RunEvent[]
  operations: OperationRecord[]
  usage: UsageRecord[]
  corrupt: Array<'public_snapshot' | 'private_checkpoint' | 'event' | 'operation' | 'usage'>
}

export interface UnknownOperation {
  operationId: string
  runId: string
  agentId: string | null
  kind: OperationKind
  replayClass: ReplayClass
  state: 'started'
  createdAtMs: number
  startedAtMs: number
}

export type RecoveryClassification =
  | { kind: 'none' }
  | { kind: 'readable_only'; runId: string; snapshot: RunSnapshot }
  | { kind: 'held_incomplete'; runId: string; snapshot: RunSnapshot; reason: 'private_resume_unsupported' }
  | { kind: 'held_unknown'; runId: string; snapshot: RunSnapshot; operations: UnknownOperation[] }
  | { kind: 'held_corrupt'; runId: string; corrupt: PrivateRunRecord['corrupt'] }

export interface SqliteRepositoryOptions {
  /** Explicit absolute path. Configuration/default selection belongs to integration. */
  databasePath: string
  /** Stable only for the lifetime of this repository handle. */
  writerId?: string
  /** SQL lock wait, implemented with PRAGMA for Node 22.13 compatibility. */
  busyTimeoutMs?: number
}

export interface DurableRunRepository {
  readonly databasePath: string
  readonly writerId: string

  commit(input: DurableCommit): void

  listPublic(limit?: number): PublicRunSummary[]
  readPublic(runId: string): RunSnapshot | null

  /** Private integration/audit surface; never return it from public HTTP methods. */
  inspectPrivate(runId: string): PrivateRunRecord | null
  readEvents(runId: string): RunEvent[]
  usageTotals(runId?: string): UsageTotals
  classifyRecovery(): RecoveryClassification

  /** Releases this handle's verified writer lock. Idempotent. */
  close(): void
}

export class PersistenceError extends Error {
  override name = 'PersistenceError'
}

export class PersistenceValidationError extends PersistenceError {
  override name = 'PersistenceValidationError'
}

export class PersistenceConflictError extends PersistenceError {
  override name = 'PersistenceConflictError'
}

export class PersistenceLockError extends PersistenceError {
  override name = 'PersistenceLockError'
}

export class PersistenceCorruptError extends PersistenceError {
  override name = 'PersistenceCorruptError'
}

export class PersistenceSchemaError extends PersistenceError {
  override name = 'PersistenceSchemaError'
}
