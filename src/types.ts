export type AgentId = 'atlas' | 'vector' | 'forge' | 'probe' | 'sentry'

export type AgentStatus = 'working' | 'thinking' | 'idle' | 'blocked'

export type LogLevel = 'INFO' | 'WARN' | 'FAIL' | 'RISK'

export type ToolStatus = 'ok' | 'queued' | 'drafting' | 'error'

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

/** A syntax-highlighted line inside an expanded tool card. */
export interface ToolOutputLine {
  text: string
  color: string
}

interface ThreadItemBase {
  /** Stable across filtering, so expanded tool cards stay expanded. */
  id: string
}

export type ThreadItem = ThreadItemBase &
  (
    | { kind: 'divider'; body: string; time: string }
    | { kind: 'message'; who: AgentId; badge?: string; body: string; time: string; chips?: string[] }
    | {
        kind: 'tool'
        who: AgentId
        tool: string
        body: string
        dur: string
        status: ToolStatus
        lines: ToolOutputLine[]
      }
    | { kind: 'handoff'; body: string; time: string }
    | { kind: 'human'; body: string; time: string }
  )

export type ThreadFilter = 'all' | 'decisions' | 'tools' | 'handoffs'

export type TrackerMode = 'board' | 'steps'

export type DetailTab = 'subtask' | 'output' | 'tools'

/** Broadcast to the room, or a direct message to one agent. */
export type MessageTarget = 'all' | AgentId

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
