/**
 * Server module contracts.
 *
 * Five modules implement these interfaces and are wired together in
 * `server/index.ts`:
 *
 *   workspace.ts   — Workspace          the virtual `helios/api` repo the agents act on
 *   tools.ts       — ToolRegistry       executes TOOL_CATALOGUE entries against a Workspace
 *   llm/           — LLM                Anthropic-backed, or the scripted mock
 *   run.ts         — RunStore           state + event log the UI subscribes to
 *   orchestrator.ts — Orchestrator      agent runners, wake queue, gate, budget
 *
 * Nothing here is runtime code except the tool catalogue and a few constants.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type {
  Agent,
  AgentId,
  LogLevel,
  LogLine,
  MessageTarget,
  Phase,
  Pipeline,
  RunEvent,
  RunInfo,
  RunSnapshot,
  RunStats,
  ThreadItem,
  ToolCall,
  ToolOutputLine,
} from '../shared/protocol.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Config {
  port: number
  /** `mock` when MOCK_LLM=1 — the scripted driver, no API key needed. */
  llm: 'anthropic' | 'mock'
  /** Per-agent model id. Default every agent to `claude-opus-5`; env AGENT_MODEL_<ID> overrides. */
  models: Record<AgentId, string>
  effort: Effort
  /** RUN_BUDGET_USD — the run stops (status `failed`, error set) when cost reaches this. */
  budgetUsd: number
  /** Cap on model calls per agent per wake; guards against tool loops. */
  maxIterationsPerTurn: number
  /** Cap on wakes per agent per run. */
  maxTurnsPerAgent: number
  /** Multiplier on the mock driver's artificial delays (1 = designed pacing, 0 = instant). */
  mockSpeed: number
  /** Start the run as soon as the server boots. Default: true in mock, false with a real key. */
  autoStart: boolean
  /** Serve the built client from here when it exists (single-process production). */
  staticDir: string | null
}

// ---------------------------------------------------------------------------
// Workspace — the world the agents act on
// ---------------------------------------------------------------------------

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /** Present for test commands: parsed summary so the UI and Atlas get numbers, not prose. */
  tests?: { passed: number; failed: number; total: number; failures: string[] }
}

export interface DiffStat {
  files: number
  additions: number
  deletions: number
  /** Per-file summary lines, e.g. "services/auth/webauthn/register.ts   +96". */
  lines: string[]
}

export interface PrComment {
  id: string
  author: AgentId
  body: string
  blocking: boolean
  resolved: boolean
}

export interface PrState {
  number: number
  title: string
  branch: string
  comments: PrComment[]
  review: 'none' | 'approved' | 'changes_requested'
  reviewRevision: number | null
  merged: boolean
  /** Commit shas pushed to the branch, oldest first. */
  commits: string[]
}

export interface SecFinding {
  level: LogLevel
  path: string
  msg: string
}

/**
 * In-memory repository with a simulated toolchain. Deterministic: the same
 * file contents always produce the same command output, so the run is
 * reproducible and the mock driver can be scripted against it.
 *
 * `run()` accepts only allow-listed commands; anything else exits 127.
 */
export interface Workspace {
  readonly repo: string
  readonly branch: string
  /** Changes on edits, pushes and rollback; evidence must match this revision. */
  revision(): number

  list(): string[]
  read(path: string): string | null
  /** Whole-file write. Returns whether the path was new. */
  write(path: string, content: string): { created: boolean }
  /** Exact-substring replacement. Missing `find` strings are reported, not silently ignored. */
  patch(path: string, edits: { find: string; replace: string }[]): { applied: number; missing: string[] }
  remove(path: string): boolean

  /** Working tree vs last push. */
  diff(): DiffStat
  /** Records a commit on the branch; returns its short sha. */
  push(message: string): { sha: string; stat: DiffStat }
  /** Restore the working tree to the last push. */
  rollback(): { sha: string | null }

  run(command: string): Promise<CommandResult>

  docs: {
    write(name: string, content: string): { created: boolean }
    read(name: string): string | null
    list(): string[]
  }
  migrations: {
    apply(name: string, sql: string): { ok: boolean; message: string }
    list(): string[]
  }
  pr: {
    state(): PrState
    comment(author: AgentId, body: string, blocking: boolean): PrComment
    resolve(id: string): boolean
    review(author: AgentId, verdict: 'approve' | 'request_changes', summary: string): void
    checkMerge(): { ok: boolean; reason?: string }
    merge(): { ok: boolean; reason?: string }
  }
  /** Simulated dependency + secret scan over the working tree. */
  secScan(): SecFinding[]
  /** Last stored test trace, for `artifact_get`. */
  artifact(name: string): string | null

  /** Compact tree listing for a system prompt. */
  describe(): string
  /** Back to the seed state. */
  reset(): void
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** JSON Schema subset the API accepts for strict tools. */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: false
}

export interface ToolContext {
  agent: AgentId
  /** Revision observed when the request producing this tool call began. */
  revision?: number
  workspace: Workspace
  run: RunStore
  /** Aborted when the human interrupts the agent. */
  signal: AbortSignal
}

export interface ToolOutcome {
  ok: boolean
  /** Returned to the model as the tool result. Keep it compact — it is context. */
  result: string
  /** Rendered inside the expanded tool card on the thread. */
  lines?: ToolOutputLine[]
  /** Written to the agent's output log; defaults to INFO + a one-line summary. */
  log?: { level: LogLevel; msg: string }
  /**
   * Side channel for the orchestrator. Tools never mutate run state directly;
   * they return an effect and the orchestrator applies it (so wake-ups, phase
   * changes and the gate all live in one place).
   */
  effect?: ToolEffect
}

export type ToolEffect =
  | { kind: 'assign'; agent: AgentId; phase: Phase; title: string; subtask: string; eta?: string }
  | { kind: 'handoff'; from: AgentId; to: AgentId; note: string }
  | { kind: 'set_phase'; phase: Phase }
  | { kind: 'request_merge'; summary: string }
  | { kind: 'finish_run'; summary: string }
  | { kind: 'progress'; pct: number; subtask?: string; eta?: string; io?: string[] }
  | { kind: 'done'; summary: string; io?: string[] }
  | { kind: 'blocked'; reason: string; waitingOn?: AgentId }
  | { kind: 'queue_add'; title: string; meta?: string }
  | { kind: 'tests'; passed: number; failed: number; total: number }
  | { kind: 'risk'; msg: string }
  | { kind: 'pr_review'; verdict: 'approve' | 'request_changes' }
  | { kind: 'pushed'; sha: string }

export interface ToolSpec {
  /** Display name, dotted — what the thread card and output log show. */
  name: string
  /** API name — `^[a-zA-Z0-9_-]{1,64}$`, so dots become underscores. */
  apiName: string
  description: string
  inputSchema: ToolInputSchema
  /** One-line argument summary for the tool card, e.g. "7 files · +318 −24". */
  summarize(input: Record<string, unknown>): string
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>
}

export interface ToolRegistry {
  /** Specs for the names an agent is allowed to call, in catalogue order. */
  forAgent(agent: AgentId): ToolSpec[]
  /** API-shaped definitions (strict) for the same set. */
  definitionsFor(agent: AgentId): Anthropic.Beta.BetaTool[]
  byApiName(apiName: string): ToolSpec | undefined
}

/**
 * The complete tool surface. Names, schemas and per-agent access are fixed here
 * so the mock driver, the tool executor and the orchestrator agree.
 *
 * Every agent also gets the `common` set. Atlas gets `orchestration` and nothing
 * from the workspace beyond `read_status`.
 */
export const TOOL_CATALOGUE: Record<
  string,
  { apiName: string; description: string; inputSchema: ToolInputSchema; agents: AgentId[] | 'all' | 'workers' }
> = {
  // --- orchestration (Atlas) -------------------------------------------------
  'run.assign': {
    apiName: 'run_assign',
    description:
      'Assign a subtask to an agent and wake them. The agent sees the title and subtask as their instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['vector', 'forge', 'probe', 'sentry'] },
        phase: { type: 'string', enum: ['spec', 'build', 'test', 'review', 'ship'] },
        title: { type: 'string', description: 'Short task title for the board, under 40 chars.' },
        subtask: { type: 'string', description: 'What to do and what done looks like, 1–3 sentences.' },
        eta: { type: 'string', description: 'Rough estimate like "~5 min".' },
      },
      required: ['agent', 'phase', 'title', 'subtask', 'eta'],
      additionalProperties: false,
    },
    agents: ['atlas'],
  },
  'run.handoff': {
    apiName: 'run_handoff',
    description: 'Record a handoff from one agent to another and wake the receiver with the note.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: ['atlas', 'vector', 'forge', 'probe', 'sentry'] },
        to: { type: 'string', enum: ['vector', 'forge', 'probe', 'sentry'] },
        note: { type: 'string', description: 'What is being handed over, under 80 chars.' },
      },
      required: ['from', 'to', 'note'],
      additionalProperties: false,
    },
    agents: ['atlas'],
  },
  'run.set_phase': {
    apiName: 'run_set_phase',
    description: 'Advance the run to a new phase. Posts a phase divider to the room.',
    inputSchema: {
      type: 'object',
      properties: { phase: { type: 'string', enum: ['spec', 'build', 'test', 'review', 'ship'] } },
      required: ['phase'],
      additionalProperties: false,
    },
    agents: ['atlas'],
  },
  'run.read_status': {
    apiName: 'run_read_status',
    description:
      'Current status of every agent, the working-tree diff, the last test result and open PR comments. Call this before deciding what to do next.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    agents: ['atlas'],
  },
  'run.request_merge': {
    apiName: 'run_request_merge',
    description:
      'Ask to merge the PR. If the human approval gate is on, the run pauses until a human approves; otherwise the PR merges immediately.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Merge summary for the PR body.' } },
      required: ['summary'],
      additionalProperties: false,
    },
    agents: ['atlas'],
  },
  'run.finish': {
    apiName: 'run_finish',
    description: 'End the run after the PR is merged, with a closing summary.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    agents: ['atlas'],
  },

  // --- common (every worker) -------------------------------------------------
  'agent.progress': {
    apiName: 'agent_progress',
    description: 'Update your progress on the current subtask. Call it whenever your status materially changes.',
    inputSchema: {
      type: 'object',
      properties: {
        pct: { type: 'integer', minimum: 0, maximum: 100 },
        subtask: { type: 'string', description: 'One line, under 50 chars, for the sidebar.' },
        eta: { type: 'string' },
        io: { type: 'array', items: { type: 'string' }, description: 'Files and artifacts you are working across.' },
      },
      required: ['pct', 'subtask', 'eta', 'io'],
      additionalProperties: false,
    },
    agents: 'workers',
  },
  'agent.done': {
    apiName: 'agent_done',
    description: 'Report the current subtask complete. Atlas is woken with your summary.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        io: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'io'],
      additionalProperties: false,
    },
    agents: 'workers',
  },
  'agent.blocked': {
    apiName: 'agent_blocked',
    description: 'Report that you cannot continue and why. Atlas is woken.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        waiting_on: { type: 'string', enum: ['atlas', 'vector', 'forge', 'probe', 'sentry', 'human'] },
      },
      required: ['reason', 'waiting_on'],
      additionalProperties: false,
    },
    agents: 'workers',
  },
  'agent.queue': {
    apiName: 'agent_queue',
    description: 'Note a follow-up item in your queue.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, meta: { type: 'string', enum: ['next', 'queued', 'watching', 'drafting'] } },
      required: ['title', 'meta'],
      additionalProperties: false,
    },
    agents: 'workers',
  },

  // --- repository ------------------------------------------------------------
  'repo.list': {
    apiName: 'repo_list',
    description: 'List every file in the repository.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    agents: 'workers',
  },
  'repo.read': {
    apiName: 'repo_read',
    description: 'Read a file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    agents: 'workers',
  },
  'repo.write': {
    apiName: 'repo_write',
    description: 'Create or replace a file with the given content.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    agents: ['forge', 'probe'],
  },
  'repo.patch': {
    apiName: 'repo_patch',
    description: 'Apply exact find/replace edits to a file. Each `find` must appear verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
    agents: ['forge', 'probe'],
  },
  'repo.diff': {
    apiName: 'repo_diff',
    description: 'Working tree vs the last push: files changed with line counts.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    agents: 'workers',
  },
  'repo.push': {
    apiName: 'repo_push',
    description: 'Commit the working tree to the branch.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
    agents: ['forge'],
  },
  'repo.rollback': {
    apiName: 'repo_rollback',
    description: 'Discard working-tree changes back to the last push.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    agents: ['forge'],
  },
  'shell.run': {
    apiName: 'shell_run',
    description:
      'Run a project command. Allowed: "pnpm typecheck", "pnpm lint", "pnpm test", "pnpm e2e" (optionally with "--grep <pattern>").',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
    agents: ['forge', 'probe'],
  },
  'db.migrate': {
    apiName: 'db_migrate',
    description: 'Write a SQL migration under db/migrations and apply it to the dev database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "0043_credentials"' },
        sql: { type: 'string' },
      },
      required: ['name', 'sql'],
      additionalProperties: false,
    },
    agents: ['forge'],
  },
  'docs.write': {
    apiName: 'docs_write',
    description: 'Write a design document (ADR, threat model) under docs/.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'e.g. "ADR-0142-passkey-auth.md"' }, content: { type: 'string' } },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    agents: ['vector'],
  },
  'docs.read': {
    apiName: 'docs_read',
    description: 'Read a design document.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    agents: 'workers',
  },
  'web.fetch': {
    apiName: 'web_fetch',
    description: 'Look up a reference (simulated: returns a curated summary for WebAuthn / passkey topics).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    agents: ['vector', 'sentry'],
  },
  'artifact.get': {
    apiName: 'artifact_get',
    description: 'Fetch a stored artifact such as the last failing-test trace.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'e.g. "trace-latest.zip"' } },
      required: ['name'],
      additionalProperties: false,
    },
    agents: ['probe'],
  },
  'sec.scan': {
    apiName: 'sec_scan',
    description: 'Dependency and secret scan plus storage-safety heuristics over the working tree.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    agents: ['sentry'],
  },
  'pr.comment': {
    apiName: 'pr_comment',
    description: 'Leave a review comment on the PR. Blocking comments hold the merge until resolved.',
    inputSchema: {
      type: 'object',
      properties: { body: { type: 'string' }, blocking: { type: 'boolean' } },
      required: ['body', 'blocking'],
      additionalProperties: false,
    },
    agents: ['sentry'],
  },
  'pr.resolve': {
    apiName: 'pr_resolve',
    description: 'Resolve one of your PR comments once it has been addressed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    agents: ['sentry'],
  },
  'pr.review': {
    apiName: 'pr_review',
    description: 'Submit the review verdict for the PR.',
    inputSchema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['approve', 'request_changes'] },
        summary: { type: 'string' },
      },
      required: ['verdict', 'summary'],
      additionalProperties: false,
    },
    agents: ['sentry'],
  },
}

export const WORKER_IDS: readonly AgentId[] = ['vector', 'forge', 'probe', 'sentry']

/** Resolve the catalogue's access shorthand for one agent. */
export function toolNamesFor(agent: AgentId): string[] {
  if (agent !== 'atlas' && !WORKER_IDS.includes(agent)) return []
  return Object.entries(TOOL_CATALOGUE)
    .filter(([, t]) => t.agents === 'all' || (t.agents === 'workers' ? agent !== 'atlas' : t.agents.includes(agent)))
    .map(([name]) => name)
}

/** Commands `shell.run` accepts. Anything else exits 127. */
export const ALLOWED_COMMANDS = ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm e2e'] as const

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface LLMUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface LLMRequest {
  agent: AgentId
  model: string
  system: string
  tools: Anthropic.Beta.BetaTool[]
  messages: Anthropic.Beta.BetaMessageParam[]
  maxTokens: number
  effort: Effort
  signal: AbortSignal
  /** Streaming text deltas — the orchestrator mirrors them into the thread. */
  onText?: (delta: string) => void
}

export interface LLMResult {
  /** The full assistant turn, to append to `messages` verbatim. */
  content: Anthropic.Beta.BetaContentBlock[]
  toolUses: Anthropic.Beta.BetaToolUseBlock[]
  /** Concatenated text blocks. */
  text: string
  stopReason: Anthropic.Beta.BetaStopReason | null
  usage: LLMUsage
  /** Set when `stopReason === 'refusal'`. */
  refusal?: { category: string | null; explanation: string | null }
}

export interface LLM {
  readonly kind: 'anthropic' | 'mock'
  /** One model call. Throws `LLMAbortedError` when `signal` fires. */
  complete(req: LLMRequest): Promise<LLMResult>
  /** Cheap reachability/credential check at boot; resolves with a human-readable problem or null. */
  healthcheck(model: string): Promise<string | null>
}

export class LLMRequestError extends Error {
  constructor(message: string, public readonly usage?: LLMUsage) {
    super(message)
    this.name = 'LLMRequestError'
  }
}

export class LLMAbortedError extends LLMRequestError {
  constructor(usage?: LLMUsage) {
    super('model call aborted', usage)
    this.name = 'LLMAbortedError'
  }
}

// ---------------------------------------------------------------------------
// RunStore — state + event log
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string
  title: string
  owner: AgentId
  phase: Phase
  state: 'queued' | 'active' | 'done' | 'blocked'
  /** Free-form status for the board cell, e.g. "72%" or "18/24". */
  meta: string
}

export interface RunStore {
  snapshot(): RunSnapshot
  /** Latest event sequence number. */
  seq(): number
  subscribe(fn: (e: RunEvent) => void): () => void

  setRun(patch: Partial<RunInfo>): void
  setAgent(id: AgentId, patch: Partial<Omit<Agent, 'id'>>): void
  agentLog(id: AgentId, level: LogLevel, msg: string): LogLine
  /** Upsert by `call.id`. */
  agentTool(id: AgentId, call: ToolCall): void

  appendThread(item: Omit<ThreadItem, 'id' | 'time'> & { id?: string }): ThreadItem
  patchThread(id: string, patch: Record<string, unknown>): void
  /** Thread items appended after `seq`, for building an agent's room context. */
  threadSince(seq: number): { items: ThreadItem[]; seq: number }

  tasks(): TaskRecord[]
  upsertTask(t: TaskRecord): void
  setPipeline(p: Pipeline): void
  setTyping(ids: AgentId[]): void

  /** Late usage from an old run counts toward lifetime spend only. */
  addUsage(u: LLMUsage, runId?: string): void
  lifetimeCostUsd(): number
  stats(): RunStats
  /** Recompute elapsed and emit `stats`. Called on a 1s ticker while live. */
  tick(): void

  /** HH:MM, server-local. */
  now(): string
  /** Reset everything to the roster + empty thread; emits a snapshot. */
  reset(run: Partial<RunInfo>): void
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface Orchestrator {
  start(): Promise<void>
  pause(): void
  resume(): void
  setGate(enabled: boolean): void
  approve(): void
  /** Parses slash commands; otherwise posts the message and wakes the target. */
  humanMessage(body: string, target: MessageTarget): Promise<void>
  /** Abort the agent's in-flight model call and mark them idle. */
  interrupt(agent: AgentId): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export interface Persona {
  id: AgentId
  name: string
  initials: string
  role: string
  color: string
  /** Frozen system prompt — stable byte-for-byte across turns so it caches. */
  system: string
  effort: Effort
}

/** Design colours per agent; the client's tints derive from these. */
export const AGENT_COLORS: Record<AgentId, string> = {
  atlas: '#7C9BFF',
  vector: '#A78BFA',
  forge: '#3ED8C4',
  probe: '#F2B457',
  sentry: '#F472B6',
}

/** Short model label for the sidebar: "claude-opus-5" → "opus". */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)/.exec(model)
  return m ? m[1] : model
}
