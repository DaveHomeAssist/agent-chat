/**
 * Wire contract between the run server and the dashboard.
 *
 * Everything the UI renders is derived from `RunSnapshot`; everything that
 * changes it arrives as a `RunEvent` over SSE. Both sides import this file —
 * the server via a relative path, the client via the `@shared/*` alias.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentId = 'atlas' | 'vector' | 'forge' | 'probe' | 'sentry'

export const AGENT_IDS: readonly AgentId[] = ['atlas', 'vector', 'forge', 'probe', 'sentry']

export type AgentStatus = 'working' | 'thinking' | 'idle' | 'blocked'

export type LogLevel = 'INFO' | 'WARN' | 'FAIL' | 'RISK'

export type ToolStatus = 'ok' | 'queued' | 'drafting' | 'running' | 'error'

export interface QueueItem {
  title: string
  meta: string
}

export interface LogLine {
  t: string
  level: LogLevel
  msg: string
}

export interface ToolCall {
  /** Server-assigned, stable — the UI keys on it. */
  id: string
  name: string
  arg: string
  dur: string
  status: ToolStatus
}

export interface Agent {
  id: AgentId
  name: string
  initials: string
  role: string
  /** Short label shown in the sidebar, e.g. "opus" — derived from the model id. */
  model: string
  color: string
  status: AgentStatus
  /** Completion of the agent's current subtask, 0–100. */
  pct: number
  /** One-line summary shown in the sidebar row. */
  subtask: string
  /** Full sentence shown in the detail pane. */
  subtaskTitle: string
  eta: string
  /** Inputs and outputs the subtask is working across. */
  io: string[]
  queueCount: number
  queue: QueueItem[]
  log: LogLine[]
  tools: ToolCall[]
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

/** A syntax-highlighted line inside an expanded tool card. */
export interface ToolOutputLine {
  text: string
  color: string
}

interface ThreadItemBase {
  /** Stable across filtering and streaming updates. */
  id: string
  /** HH:MM wall-clock, server-local. */
  time: string
}

export type ThreadItem = ThreadItemBase &
  (
    | { kind: 'divider'; body: string }
    | {
        kind: 'message'
        who: AgentId
        badge?: string
        body: string
        chips?: string[]
        /** True while the model is still streaming this message. */
        streaming?: boolean
      }
    | {
        kind: 'tool'
        who: AgentId
        tool: string
        body: string
        dur: string
        status: ToolStatus
        lines: ToolOutputLine[]
      }
    | { kind: 'handoff'; body: string }
    | {
        kind: 'human'
        body: string
        /** Who the human addressed — the room, or one agent. */
        target: MessageTarget
      }
  )

export type ThreadFilter = 'all' | 'decisions' | 'tools' | 'handoffs'

/** Broadcast to the room, or a direct message to one agent. */
export type MessageTarget = 'all' | AgentId

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type Phase = 'spec' | 'build' | 'test' | 'review' | 'ship' | 'done'

export const PHASES: readonly Phase[] = ['spec', 'build', 'test', 'review', 'ship', 'done']

export interface LaneTask {
  title: string
  owner: AgentId
  meta: string
}

export interface Lane {
  name: string
  color: string
  state: string
  tasks: LaneTask[]
}

export type StepState = 'done' | 'active' | 'wait'

export interface Step {
  title: string
  state: StepState
  detail: string
  meta: string
  pct: number
}

export interface Pipeline {
  phase: Phase
  lanes: Lane[]
  steps: Step[]
  /** The pull request the run is driving toward. */
  pr: string
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunStatus = 'idle' | 'live' | 'paused' | 'needs_approval' | 'done' | 'failed'

export interface RunStats {
  /** Seconds since the run started. */
  elapsedSec: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  /** Calls whose final usage was not reported; spend is a lower bound. */
  unreportedRequests: number
  lifetimeUnreportedRequests: number
  /** Hard ceiling from RUN_BUDGET_USD; the run stops when reached. */
  budgetUsd: number
  messages: number
  toolCalls: number
  handoffs: number
  /** Decisions = phase dividers + human messages + badged agent messages. */
  decisions: number
}

export interface RunInfo {
  id: string
  /** e.g. "RUN 04" */
  label: string
  status: RunStatus
  /** Merge is held for a human when true. */
  approvalGate: boolean
  channel: string
  repo: string
  branch: string
  goal: string
  startedAt: string
  /** Number of tool servers the agents have access to. */
  toolServers: number
  /** "mock" when the scripted LLM is driving the run. */
  llm: 'anthropic' | 'openai' | 'mock'
  /** Non-empty when status is `failed`. */
  error?: string
}

export interface RunSnapshot {
  seq: number
  run: RunInfo
  stats: RunStats
  agents: Agent[]
  thread: ThreadItem[]
  pipeline: Pipeline
  /** Agents currently mid-model-call, in roster order. */
  typing: AgentId[]
}

// ---------------------------------------------------------------------------
// Events (server → client, over SSE)
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: 'snapshot'; seq: number; snapshot: RunSnapshot }
  | { type: 'run'; seq: number; run: Partial<RunInfo> }
  | { type: 'stats'; seq: number; stats: RunStats }
  | { type: 'agent'; seq: number; id: AgentId; patch: Partial<Omit<Agent, 'id'>> }
  | { type: 'agent.log'; seq: number; id: AgentId; line: LogLine }
  | { type: 'agent.tool'; seq: number; id: AgentId; call: ToolCall }
  | { type: 'thread.append'; seq: number; item: ThreadItem }
  | {
      type: 'thread.patch'
      seq: number
      id: string
      patch: Partial<Extract<ThreadItem, { kind: 'message' }>> | Partial<Extract<ThreadItem, { kind: 'tool' }>>
    }
  | { type: 'pipeline'; seq: number; pipeline: Pipeline }
  | { type: 'typing'; seq: number; typing: AgentId[] }

export type RunEventType = RunEvent['type']

// ---------------------------------------------------------------------------
// Commands (client → server, JSON over HTTP)
// ---------------------------------------------------------------------------

export interface SendMessageRequest {
  body: string
  target: MessageTarget
}

export interface SetGateRequest {
  enabled: boolean
}

export interface CommandResult {
  ok: true
  seq: number
}

export interface CommandError {
  ok: false
  error: string
}

export type CommandResponse = CommandResult | CommandError

/**
 * HTTP surface. Every POST returns `CommandResponse`.
 *
 *   GET  /api/events            SSE stream of `RunEvent` (first event is a snapshot)
 *   GET  /api/state             RunSnapshot
 *   POST /api/message           SendMessageRequest
 *   POST /api/run/start         (re)start the run from a clean workspace
 *   POST /api/run/pause
 *   POST /api/run/resume
 *   POST /api/run/gate          SetGateRequest
 *   POST /api/run/approve       release a held merge gate
 *   POST /api/agents/:id/interrupt   abort the agent's in-flight model call
 */
export const API = {
  events: '/api/events',
  state: '/api/state',
  message: '/api/message',
  start: '/api/run/start',
  pause: '/api/run/pause',
  resume: '/api/run/resume',
  gate: '/api/run/gate',
  approve: '/api/run/approve',
  interrupt: (id: AgentId) => `/api/agents/${id}/interrupt`,
} as const

/**
 * Slash commands the composer understands. The server parses them out of a
 * human message body; anything else is plain text for the agents.
 *
 *   /approve merge            → release the gate (same as POST /api/run/approve)
 *   /assign <agent> <task…>   → Atlas assigns the task to that agent
 *   /rollback build           → Forge reverts the workspace to the last push
 *   /pause  /resume
 */
export const SLASH_COMMANDS = ['/approve', '/assign', '/rollback', '/pause', '/resume'] as const
