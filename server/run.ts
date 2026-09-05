/**
 * RunStore: the single source of truth the UI subscribes to.
 *
 * Every mutation bumps `seq` and emits exactly one RunEvent carrying that seq,
 * so a client that applies events in order ends up with the same state as
 * `snapshot()`.
 */

import { randomUUID } from 'node:crypto'
import type {
  Agent,
  AgentId,
  LogLevel,
  LogLine,
  Pipeline,
  RunEvent,
  RunInfo,
  RunSnapshot,
  RunStats,
  ThreadItem,
  ToolCall,
} from '../shared/protocol.js'
import { modelLabel } from './contracts.js'
import type { LLMUsage, Persona, RunStore, TaskRecord } from './contracts.js'
import { costUsd } from './llm/pricing.js'
import { derivePipeline } from './pipeline.js'

const LOG_CAP = 200
const TOOL_CAP = 100

/**
 * `RunStats.budgetUsd` comes from config, which `createRunStore` never sees;
 * the composition root (or the orchestrator) sets it through this extra method.
 */
export interface RunStoreWithBudget extends RunStore {
  setBudget(usd: number): void
}

const RUN_DEFAULTS: Omit<RunInfo, 'id' | 'startedAt'> = {
  label: 'RUN 04',
  status: 'idle',
  approvalGate: true,
  channel: '#feature-passkey-auth',
  repo: 'helios/api',
  branch: 'feat/passkey-auth',
  goal: 'Ship passkey sign-in behind the auth.passkeys flag',
  toolServers: 3,
  llm: 'mock',
}

const EMPTY_PIPELINE: Pipeline = { phase: 'spec', lanes: [], steps: [], pr: 'PR #482' }

const pad = (n: number): string => String(n).padStart(2, '0')

function clock(withSeconds: boolean): string {
  const d = new Date()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withSeconds ? `${hm}:${pad(d.getSeconds())}` : hm
}

function runId(): string {
  return `run_${randomUUID()}`
}

function agentFrom(p: Persona, model: string): Agent {
  return {
    id: p.id,
    name: p.name,
    initials: p.initials,
    role: p.role,
    model: modelLabel(model),
    color: p.color,
    status: 'idle',
    pct: 0,
    subtask: '—',
    subtaskTitle: '—',
    eta: '—',
    io: [],
    queueCount: 0,
    queue: [],
    log: [],
    tools: [],
  }
}

export function createRunStore(personas: Persona[], models: Record<AgentId, string>): RunStoreWithBudget {
  let seq = 0
  let run: RunInfo = { ...RUN_DEFAULTS, id: runId(), startedAt: clock(false) }
  let startedAtMs = Date.now()
  let endedAtMs: number | null = null
  let budgetUsd = 0
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let lifetimeCost = 0
  let agents: Agent[] = []
  let thread: ThreadItem[] = []
  let threadSeq = new Map<string, number>()
  let tasks: TaskRecord[] = []
  let pipeline: Pipeline = EMPTY_PIPELINE
  let typing: AgentId[] = []
  const subscribers = new Set<(e: RunEvent) => void>()

  function publish(e: RunEvent): void {
    for (const fn of subscribers) fn(e)
  }

  function agent(id: AgentId): Agent {
    const a = agents.find((x) => x.id === id)
    if (!a) throw new Error(`unknown agent ${id}`)
    return a
  }

  function elapsedSec(): number {
    if (run.status === 'idle') return 0
    return Math.max(0, Math.floor(((endedAtMs ?? Date.now()) - startedAtMs) / 1000))
  }

  function stats(): RunStats {
    let messages = 0
    let toolCalls = 0
    let handoffs = 0
    let decisions = 0
    for (const item of thread) {
      if (item.kind === 'message' || item.kind === 'human') messages++
      if (item.kind === 'tool') toolCalls++
      if (item.kind === 'handoff') handoffs++
      if (item.kind === 'divider' || item.kind === 'human' || (item.kind === 'message' && item.badge)) decisions++
    }
    return {
      elapsedSec: elapsedSec(),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
      costUsd: tokens.cost,
      budgetUsd,
      messages,
      toolCalls,
      handoffs,
      decisions,
    }
  }

  function snapshot(): RunSnapshot {
    return structuredClone({ seq, run, stats: stats(), agents, thread, pipeline, typing })
  }

  function rebuild(patch: Partial<RunInfo>): void {
    run = {
      ...RUN_DEFAULTS,
      approvalGate: run.approvalGate,
      llm: run.llm,
      id: runId(),
      startedAt: clock(false),
      ...patch,
    }
    delete run.error
    if (patch.error) run.error = patch.error
    startedAtMs = Date.now()
    endedAtMs = null
    tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    agents = personas.map((p) => agentFrom(p, models[p.id]))
    thread = []
    threadSeq = new Map()
    tasks = []
    typing = []
    pipeline = EMPTY_PIPELINE
  }

  const store: RunStoreWithBudget = {
    snapshot,
    seq: () => seq,
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },

    setRun(patch) {
      const s = ++seq
      run = { ...run, ...patch }
      if (patch.status === 'done' || patch.status === 'failed') endedAtMs ??= Date.now()
      else if (patch.status) endedAtMs = null
      publish({ type: 'run', seq: s, run: patch })
    },

    setAgent(id, patch) {
      const s = ++seq
      const a = agent(id)
      Object.assign(a, patch)
      publish({ type: 'agent', seq: s, id, patch })
    },

    agentLog(id, level: LogLevel, msg): LogLine {
      const s = ++seq
      const a = agent(id)
      const line: LogLine = { t: clock(true), level, msg }
      a.log.push(line)
      if (a.log.length > LOG_CAP) a.log.splice(0, a.log.length - LOG_CAP)
      publish({ type: 'agent.log', seq: s, id, line })
      return line
    },

    agentTool(id, call: ToolCall) {
      const s = ++seq
      const a = agent(id)
      const i = a.tools.findIndex((t) => t.id === call.id)
      if (i >= 0) a.tools[i] = { ...call }
      else a.tools.push({ ...call })
      if (a.tools.length > TOOL_CAP) a.tools.splice(0, a.tools.length - TOOL_CAP)
      publish({ type: 'agent.tool', seq: s, id, call })
    },

    appendThread(item) {
      const s = ++seq
      const full = { ...item, id: item.id ?? `t${s}`, time: clock(false) } as ThreadItem
      thread.push(full)
      threadSeq.set(full.id, s)
      publish({ type: 'thread.append', seq: s, item: full })
      return full
    },

    patchThread(id, patch) {
      const item = thread.find((t) => t.id === id)
      if (!item) return
      const s = ++seq
      Object.assign(item, patch)
      publish({ type: 'thread.patch', seq: s, id, patch: patch as Extract<RunEvent, { type: 'thread.patch' }>['patch'] })
    },

    threadSince(since) {
      const items = thread.filter((t) => (threadSeq.get(t.id) ?? 0) > since)
      return { items: structuredClone(items), seq }
    },

    tasks: () => tasks.map((t) => ({ ...t })),

    upsertTask(t) {
      const i = tasks.findIndex((x) => x.id === t.id)
      if (i >= 0) tasks[i] = { ...t }
      else tasks.push({ ...t })
      // Tasks only reach the UI through the pipeline; the caller recomputes it.
    },

    setPipeline(p) {
      const s = ++seq
      pipeline = p
      publish({ type: 'pipeline', seq: s, pipeline: p })
    },

    setTyping(ids) {
      const s = ++seq
      typing = [...ids]
      publish({ type: 'typing', seq: s, typing })
    },

    addUsage(u: LLMUsage, usageRunId = run.id) {
      const cost = costUsd(u)
      lifetimeCost += cost
      if (usageRunId !== run.id) return
      const s = ++seq
      tokens.input += u.inputTokens
      tokens.output += u.outputTokens
      tokens.cacheRead += u.cacheReadTokens
      tokens.cacheWrite += u.cacheWriteTokens
      tokens.cost += cost
      publish({ type: 'stats', seq: s, stats: stats() })
    },

    stats,
    lifetimeCostUsd: () => lifetimeCost,

    tick() {
      const s = ++seq
      publish({ type: 'stats', seq: s, stats: stats() })
    },

    now: () => clock(false),

    reset(patch) {
      rebuild(patch)
      pipeline = derivePipeline(store)
      const s = ++seq
      publish({ type: 'snapshot', seq: s, snapshot: snapshot() })
    },

    setBudget(usd) {
      budgetUsd = usd
    },
  }

  rebuild({})
  pipeline = derivePipeline(store)
  return store
}
