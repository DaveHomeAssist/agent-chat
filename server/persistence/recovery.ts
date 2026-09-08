import type {
  PrivateRunRecord,
  RecoveryClassification,
  UnknownOperation,
} from './contracts.js'

/**
 * Pure classification only. It performs no replay, repair, mutation or effect.
 * Version 1 checkpoints explicitly cannot authorize executable resume.
 */
export function classifyRunRecovery(record: PrivateRunRecord | null): RecoveryClassification {
  if (!record) return { kind: 'none' }
  if (record.corrupt.length || !record.snapshot || !record.checkpoint) {
    return { kind: 'held_corrupt', runId: record.runId, corrupt: [...record.corrupt] }
  }

  const snapshot = structuredClone(record.snapshot)
  if (snapshot.run.status === 'done' || snapshot.run.status === 'failed') {
    return { kind: 'readable_only', runId: record.runId, snapshot }
  }

  const unknown: UnknownOperation[] = record.operations
    .filter((operation): operation is typeof operation & { state: 'started'; startedAtMs: number } =>
      operation.state === 'started' && operation.startedAtMs !== null)
    .map((operation) => ({
      operationId: operation.operationId,
      runId: operation.runId,
      agentId: operation.agentId,
      kind: operation.kind,
      replayClass: operation.replayClass,
      state: 'started',
      createdAtMs: operation.createdAtMs,
      startedAtMs: operation.startedAtMs,
    }))

  if (unknown.length) return { kind: 'held_unknown', runId: record.runId, snapshot, operations: unknown }
  return { kind: 'held_incomplete', runId: record.runId, snapshot, reason: 'private_resume_unsupported' }
}
