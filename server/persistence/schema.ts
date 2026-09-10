import { z, type ZodType } from 'zod'
import type { RunEvent, RunSnapshot } from '../../shared/protocol.js'
import {
  AGENT_IDS,
  AGENT_STATUSES,
  LLM_PROVIDERS,
  LOG_LEVELS,
  PHASES,
  RUN_STATUSES,
  STEP_STATES,
  TOOL_STATUSES,
} from '../../shared/protocol.js'
import {
  PERSISTENCE_SCHEMA_VERSION,
  PersistenceValidationError,
  type DurableCommit,
  type JsonValue,
  type OperationRecord,
  type PrivateCheckpointV1,
  type UsageRecord,
} from './contracts.js'

const SafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const NullableSafeInteger = SafeInteger.nullable()
const FiniteNonnegative = z.number().finite().nonnegative()
const Identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)

export const JsonValueSchema: ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
)

// Closed vocabularies come from the wire contract so the durable store cannot
// drift from what the server emits and the console renders.
const AgentIdSchema = z.enum(AGENT_IDS)
const RunStatusSchema = z.enum(RUN_STATUSES)
const ToolStatusSchema = z.enum(TOOL_STATUSES)

const LogLineSchema = z.object({
  t: z.string().max(32),
  level: z.enum(LOG_LEVELS),
  msg: z.string(),
}).strict()

const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arg: z.string(),
  dur: z.string(),
  status: ToolStatusSchema,
}).strict()

const AgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string(),
  initials: z.string(),
  role: z.string(),
  model: z.string(),
  color: z.string(),
  status: z.enum(AGENT_STATUSES),
  pct: z.number().int().min(0).max(100),
  subtask: z.string(),
  subtaskTitle: z.string(),
  eta: z.string(),
  io: z.array(z.string()),
  queueCount: SafeInteger,
  queue: z.array(z.object({ title: z.string(), meta: z.string() }).strict()),
  log: z.array(LogLineSchema),
  tools: z.array(ToolCallSchema),
}).strict()

const ThreadBase = { id: z.string().min(1), time: z.string().max(32) }
const ThreadItemSchema = z.discriminatedUnion('kind', [
  z.object({ ...ThreadBase, kind: z.literal('divider'), body: z.string() }).strict(),
  z.object({
    ...ThreadBase,
    kind: z.literal('message'),
    who: AgentIdSchema,
    badge: z.string().optional(),
    body: z.string(),
    chips: z.array(z.string()).optional(),
    streaming: z.boolean().optional(),
  }).strict(),
  z.object({
    ...ThreadBase,
    kind: z.literal('tool'),
    who: AgentIdSchema,
    tool: z.string(),
    body: z.string(),
    dur: z.string(),
    status: ToolStatusSchema,
    lines: z.array(z.object({ text: z.string(), color: z.string() }).strict()),
  }).strict(),
  z.object({ ...ThreadBase, kind: z.literal('handoff'), body: z.string() }).strict(),
  z.object({
    ...ThreadBase,
    kind: z.literal('human'),
    body: z.string(),
    target: z.union([z.literal('all'), AgentIdSchema]),
  }).strict(),
])

const PipelineSchema = z.object({
  phase: z.enum(PHASES),
  lanes: z.array(z.object({
    name: z.string(),
    color: z.string(),
    state: z.string(),
    tasks: z.array(z.object({ title: z.string(), owner: AgentIdSchema, meta: z.string() }).strict()),
  }).strict()),
  steps: z.array(z.object({
    title: z.string(),
    state: z.enum(STEP_STATES),
    detail: z.string(),
    meta: z.string(),
    pct: z.number().int().min(0).max(100),
  }).strict()),
  pr: z.string(),
}).strict()

const RunInfoSchema = z.object({
  id: Identifier,
  label: z.string(),
  status: RunStatusSchema,
  approvalGate: z.boolean(),
  channel: z.string(),
  repo: z.string(),
  branch: z.string(),
  goal: z.string(),
  startedAt: z.string(),
  toolServers: SafeInteger,
  llm: z.enum(LLM_PROVIDERS),
  error: z.string().optional(),
}).strict()

const RunStatsSchema = z.object({
  elapsedSec: SafeInteger,
  inputTokens: SafeInteger,
  outputTokens: SafeInteger,
  cacheReadTokens: SafeInteger,
  cacheWriteTokens: SafeInteger,
  costUsd: FiniteNonnegative,
  unreportedRequests: SafeInteger,
  lifetimeUnreportedRequests: SafeInteger,
  budgetUsd: FiniteNonnegative,
  messages: SafeInteger,
  toolCalls: SafeInteger,
  handoffs: SafeInteger,
  decisions: SafeInteger,
}).strict()

export const RunSnapshotSchema = z.object({
  seq: SafeInteger,
  run: RunInfoSchema,
  stats: RunStatsSchema,
  agents: z.array(AgentSchema),
  thread: z.array(ThreadItemSchema),
  pipeline: PipelineSchema,
  typing: z.array(AgentIdSchema),
}).strict()

const MessagePatchSchema = z.object({
  badge: z.string().optional(),
  body: z.string().optional(),
  chips: z.array(z.string()).optional(),
  streaming: z.boolean().optional(),
}).strict()

const ToolPatchSchema = z.object({
  body: z.string().optional(),
  dur: z.string().optional(),
  status: ToolStatusSchema.optional(),
  lines: z.array(z.object({ text: z.string(), color: z.string() }).strict()).optional(),
}).strict()

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), seq: SafeInteger, snapshot: RunSnapshotSchema }).strict(),
  z.object({ type: z.literal('run'), seq: SafeInteger, run: RunInfoSchema.partial().strict() }).strict(),
  z.object({ type: z.literal('stats'), seq: SafeInteger, stats: RunStatsSchema }).strict(),
  z.object({ type: z.literal('agent'), seq: SafeInteger, id: AgentIdSchema, patch: AgentSchema.omit({ id: true }).partial().strict() }).strict(),
  z.object({ type: z.literal('agent.log'), seq: SafeInteger, id: AgentIdSchema, line: LogLineSchema }).strict(),
  z.object({ type: z.literal('agent.tool'), seq: SafeInteger, id: AgentIdSchema, call: ToolCallSchema }).strict(),
  z.object({ type: z.literal('thread.append'), seq: SafeInteger, item: ThreadItemSchema }).strict(),
  z.object({ type: z.literal('thread.patch'), seq: SafeInteger, id: z.string().min(1), patch: z.union([MessagePatchSchema, ToolPatchSchema]) }).strict(),
  z.object({ type: z.literal('pipeline'), seq: SafeInteger, pipeline: PipelineSchema }).strict(),
  z.object({ type: z.literal('typing'), seq: SafeInteger, typing: z.array(AgentIdSchema) }).strict(),
]).superRefine((value, ctx) => {
  if (value.type === 'snapshot' && value.snapshot.seq !== value.seq) {
    ctx.addIssue({ code: 'custom', message: 'snapshot event sequence mismatch' })
  }
})

export const PrivateCheckpointSchema = z.object({
  schemaVersion: z.literal(PERSISTENCE_SCHEMA_VERSION),
  runId: Identifier,
  seq: SafeInteger,
  capturedAtMs: SafeInteger,
  capabilities: z.object({
    publicSnapshot: z.literal('complete'),
    runnerState: z.literal('unsupported'),
    workspaceState: z.literal('unsupported'),
    providerContinuation: z.literal('unsupported'),
    automaticResume: z.literal('unsupported'),
  }).strict(),
  note: z.string().max(1000).optional(),
}).strict()

export const OperationRecordSchema = z.object({
  operationId: Identifier,
  runId: Identifier,
  agentId: Identifier.nullable(),
  kind: z.enum(['provider', 'tool', 'external']),
  replayClass: z.enum(['pure', 'local_idempotent', 'external_reconcilable', 'external_ambiguous']),
  state: z.enum(['prepared', 'started', 'completed']),
  requestHash: Hash,
  intent: JsonValueSchema,
  outcome: JsonValueSchema.optional(),
  createdAtMs: SafeInteger,
  startedAtMs: NullableSafeInteger,
  completedAtMs: NullableSafeInteger,
}).strict().superRefine((value, ctx) => {
  if (value.state === 'prepared' && (value.startedAtMs !== null || value.completedAtMs !== null || value.outcome !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'prepared operation cannot have start/completion data' })
  }
  if (value.state === 'started' && (value.startedAtMs === null || value.completedAtMs !== null || value.outcome !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'started operation requires only startedAtMs' })
  }
  if (value.state === 'completed' && (value.startedAtMs === null || value.completedAtMs === null || value.outcome === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'completed operation requires timestamps and outcome' })
  }
  if (value.startedAtMs !== null && value.startedAtMs < value.createdAtMs) {
    ctx.addIssue({ code: 'custom', message: 'startedAtMs precedes createdAtMs' })
  }
  if (value.completedAtMs !== null && value.startedAtMs !== null && value.completedAtMs < value.startedAtMs) {
    ctx.addIssue({ code: 'custom', message: 'completedAtMs precedes startedAtMs' })
  }
})

export const UsageRecordSchema = z.object({
  operationId: Identifier,
  runId: Identifier,
  provider: z.enum(LLM_PROVIDERS),
  model: Identifier,
  state: z.enum(['reported', 'unknown']),
  inputTokens: NullableSafeInteger,
  outputTokens: NullableSafeInteger,
  cacheReadTokens: NullableSafeInteger,
  cacheWriteTokens: NullableSafeInteger,
  costUsd: FiniteNonnegative.nullable(),
  recordedAtMs: SafeInteger,
}).strict().superRefine((value, ctx) => {
  const counters = [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.costUsd]
  if (value.state === 'reported' && counters.some((item) => item === null)) {
    ctx.addIssue({ code: 'custom', message: 'reported usage requires all counters and cost' })
  }
  if (value.state === 'unknown' && counters.some((item) => item !== null)) {
    ctx.addIssue({ code: 'custom', message: 'unknown usage cannot contain invented counters or cost' })
  }
})

export const DurableCommitSchema = z.object({
  runId: Identifier,
  snapshot: RunSnapshotSchema,
  checkpoint: PrivateCheckpointSchema,
  committedAtMs: SafeInteger,
  event: RunEventSchema.optional(),
  operation: OperationRecordSchema.optional(),
  usage: UsageRecordSchema.optional(),
}).strict().superRefine((value, ctx) => {
  const ids = [value.snapshot.run.id, value.checkpoint.runId, value.operation?.runId, value.usage?.runId].filter(Boolean)
  if (ids.some((id) => id !== value.runId)) ctx.addIssue({ code: 'custom', message: 'run identity mismatch' })
  const eventRunId = value.event?.type === 'snapshot'
    ? value.event.snapshot.run.id
    : value.event?.type === 'run'
      ? value.event.run.id
      : undefined
  if (eventRunId !== undefined && eventRunId !== value.runId) ctx.addIssue({ code: 'custom', message: 'event run identity mismatch' })
  if (value.checkpoint.seq !== value.snapshot.seq) ctx.addIssue({ code: 'custom', message: 'checkpoint/snapshot sequence mismatch' })
  if (value.event && value.event.seq !== value.snapshot.seq) ctx.addIssue({ code: 'custom', message: 'event/snapshot sequence mismatch' })
  if (value.event?.type === 'snapshot' && stableJson(value.event.snapshot) !== stableJson(value.snapshot)) {
    ctx.addIssue({ code: 'custom', message: 'snapshot event content mismatch' })
  }
  if (value.usage && value.operation && value.usage.operationId !== value.operation.operationId) {
    ctx.addIssue({ code: 'custom', message: 'usage/operation identity mismatch' })
  }
  if (value.checkpoint.capturedAtMs > value.committedAtMs) {
    ctx.addIssue({ code: 'custom', message: 'checkpoint capture time is after commit time' })
  }
  const operationTimes = value.operation
    ? [value.operation.createdAtMs, value.operation.startedAtMs, value.operation.completedAtMs].filter((item): item is number => item !== null)
    : []
  if (operationTimes.some((item) => item > value.committedAtMs)) {
    ctx.addIssue({ code: 'custom', message: 'operation time is after commit time' })
  }
  if (value.usage && value.usage.recordedAtMs > value.committedAtMs) {
    ctx.addIssue({ code: 'custom', message: 'usage time is after commit time' })
  }
})

function issueSummary(error: z.ZodError): string {
  return error.issues.slice(0, 4).map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')
}

function parse<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new PersistenceValidationError(`${label} failed validation: ${issueSummary(result.error)}`)
  return result.data
}

/**
 * Every parser output must be assignable to the shared contract type. The
 * `satisfies` checks below make a schema that drifts from `shared/protocol.ts`
 * (a field or vocabulary added there but not here) a typecheck failure rather
 * than a runtime rejection of valid snapshots.
 */
const CommitParser = DurableCommitSchema satisfies ZodType<DurableCommit>
const SnapshotParser = RunSnapshotSchema satisfies ZodType<RunSnapshot>
const CheckpointParser = PrivateCheckpointSchema satisfies ZodType<PrivateCheckpointV1>
const EventParser = RunEventSchema satisfies ZodType<RunEvent>
const OperationParser = OperationRecordSchema satisfies ZodType<OperationRecord>
const UsageParser = UsageRecordSchema satisfies ZodType<UsageRecord>

export const parseCommit = (value: unknown): DurableCommit => parse(CommitParser, value, 'commit')
export const parseSnapshot = (value: unknown): RunSnapshot => parse(SnapshotParser, value, 'public snapshot')
export const parseCheckpoint = (value: unknown): PrivateCheckpointV1 => parse(CheckpointParser, value, 'private checkpoint')
export const parseEvent = (value: unknown): RunEvent => parse(EventParser, value, 'event')
export const parseOperation = (value: unknown): OperationRecord => parse(OperationParser, value, 'operation')
export const parseUsage = (value: unknown): UsageRecord => parse(UsageParser, value, 'usage')

export function parseStoredJson<T>(text: string, parser: (value: unknown) => T, label: string): T {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PersistenceValidationError(`${label} contains invalid JSON`)
  }
  return parser(value)
}

export function stableJson(value: JsonValue | object): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]))
    }
    return item
  }
  return JSON.stringify(sort(value))
}
