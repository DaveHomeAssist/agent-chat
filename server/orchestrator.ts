/**
 * The orchestrator: one runner per agent, a wake queue per runner, the tool
 * loop, the human gate and the budget.
 *
 * Runners process their own inbox serially and run concurrently with each
 * other. Every await is followed by a generation check so a runner from a
 * restarted or disposed run never writes into the new one.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { AgentId, AgentStatus, MessageTarget, Phase, RunInfo, ThreadItem, ToolCall } from '../shared/protocol.js'
import { AGENT_IDS, PHASES } from '../shared/protocol.js'
import { LLMAbortedError } from './contracts.js'
import type {
  Config,
  LLM,
  LLMResult,
  Orchestrator,
  Persona,
  RunStore,
  TaskRecord,
  ToolEffect,
  ToolOutcome,
  ToolRegistry,
  Workspace,
} from './contracts.js'
import { derivePipeline } from './pipeline.js'

type Tag = 'RUN_START' | 'ASSIGNMENT' | 'HANDOFF' | 'REPORT' | 'HUMAN' | 'GATE_APPROVED'

interface Wake {
  tag: Tag
  /** Attributes inside the tag brackets, e.g. " from=probe kind=blocked". */
  attrs?: string
  /** Text on the tag line after the closing bracket. */
  inline?: string
  /** Lines following the tag line. */
  body?: string
  /** Append the workspace tree. */
  tree?: boolean
}

/** What happened during one wake, for the badge on the agent's message. */
interface TurnCtx {
  human: boolean
  plan: boolean
  risk: boolean
  tests: string | null
  blocked: boolean
  messageIds: string[]
  /** Agents @-mentioned in this turn's messages, with the line that named them. */
  mentions: Map<AgentId, string>
}

interface Runner {
  id: AgentId
  persona: Persona
  inbox: Wake[]
  history: Anthropic.Beta.BetaMessageParam[]
  lastSeenSeq: number
  abort: AbortController | null
  turns: number
  busy: boolean
  taskId: string | null
  capWarned: boolean
}

/**
 * `RunStore.appendThread` takes `Omit<ThreadItem, 'id' | 'time'>`, which is not
 * distributive over the union and so drops every variant-specific key. This
 * is the distributive form; `post()` bridges the two.
 */
type ThreadDraft = { [K in ThreadItem['kind']]: Omit<Extract<ThreadItem, { kind: K }>, 'id' | 'time'> }[ThreadItem['kind']]

interface Deps {
  store: RunStore
  llm: LLM
  workspace: Workspace
  tools: ToolRegistry
  config: Config
  personas: Persona[]
}

const MAX_TOKENS = 16000
const STREAM_THROTTLE_MS = 60
const ROOM_MAX_LINES = 40
const ROOM_LINE_MAX = 240
const ACTIVE_STATUSES: readonly RunInfo['status'][] = ['live', 'paused', 'needs_approval']
const MENTION = /@([A-Za-z]+)/g

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const isRatio = (s: string): boolean => /^\d+\/\d+$/.test(s)
const fmtDur = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

export function createOrchestrator(deps: Deps): Orchestrator {
  const { store, llm, workspace, tools, config } = deps
  const personas = new Map(deps.personas.map((p) => [p.id, p]))
  const nameOf = (id: AgentId): string => personas.get(id)?.name ?? id

  let gen = 0
  let disposed = false
  let runners = new Map<AgentId, Runner>()
  let ticker: NodeJS.Timeout | null = null
  const inFlight = new Set<AgentId>()
  let approvedEarly = false
  let pauseGate: Promise<void> | null = null
  let releasePause: (() => void) | null = null

  const maybeBudget = store as RunStore & { setBudget?: (usd: number) => void }
  maybeBudget.setBudget?.(config.budgetUsd)

  // ---- state helpers ------------------------------------------------------

  const fresh = (g: number): boolean => g === gen && !disposed
  const post = (item: ThreadDraft): ThreadItem => store.appendThread(item as Parameters<RunStore['appendThread']>[0])
  const runInfo = (): RunInfo => store.snapshot().run
  const runActive = (): boolean => ACTIVE_STATUSES.includes(runInfo().status)
  const agentState = (id: AgentId) => store.snapshot().agents.find((a) => a.id === id)!

  function recompute(phase?: Phase): void {
    store.setPipeline(derivePipeline(store, phase))
  }

  function syncTyping(): void {
    store.setTyping(AGENT_IDS.filter((id) => inFlight.has(id)))
  }

  function currentTask(id: AgentId): TaskRecord | undefined {
    const tasks = store.tasks().filter((t) => t.owner === id)
    const r = runners.get(id)
    return (r?.taskId && tasks.find((t) => t.id === r.taskId)) || tasks.find((t) => t.state === 'active') || tasks[tasks.length - 1]
  }

  function patchTask(id: AgentId, patch: Partial<TaskRecord>): void {
    const t = currentTask(id)
    if (t) store.upsertTask({ ...t, ...patch })
  }

  /** Atlas's sidebar row summarises the board — real counts only. */
  function refreshAtlas(): void {
    const tasks = store.tasks()
    const done = tasks.filter((t) => t.state === 'done').length
    const blocked = tasks.filter((t) => t.state === 'blocked').length
    const gate = runInfo().approvalGate ? 'held' : 'off'
    const n = tasks.length
    store.setAgent('atlas', {
      subtask: n ? `coordinating ${n} subtask${n === 1 ? '' : 's'} · merge gate ${gate}` : `planning · merge gate ${gate}`,
      subtaskTitle: 'Keep the run on plan: sequence spec → build → test → review → ship, hold the merge until the human gate clears',
      pct: n ? Math.round((done / n) * 100) : 0,
      io: n ? [`${n} subtask${n === 1 ? '' : 's'}`, `${blocked} blocked`] : [],
    })
  }

  function newRunners(): Map<AgentId, Runner> {
    const seq = store.seq()
    return new Map(
      deps.personas.map((p) => [
        p.id,
        { id: p.id, persona: p, inbox: [], history: [], lastSeenSeq: seq, abort: null, turns: 0, busy: false, taskId: null, capWarned: false },
      ]),
    )
  }

  function abortAll(): void {
    for (const r of runners.values()) {
      r.abort?.abort()
      r.inbox.length = 0
    }
    inFlight.clear()
  }

  function release(): void {
    releasePause?.()
    releasePause = null
    pauseGate = null
  }

  function startTicker(): void {
    stopTicker()
    ticker = setInterval(() => store.tick(), 1000)
  }

  function stopTicker(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  function failRun(error: string): void {
    gen++
    abortAll()
    release()
    stopTicker()
    store.setRun({ status: 'failed', error })
    store.setTyping([])
    recompute()
  }

  // ---- wake queue -----------------------------------------------------------

  function enqueue(id: AgentId, wake: Wake, front = false): void {
    const r = runners.get(id)
    if (!r || !runActive()) return
    if (front) r.inbox.unshift(wake)
    else r.inbox.push(wake)
    void pump(r, gen)
  }

  async function pump(r: Runner, g: number): Promise<void> {
    if (r.busy) return
    r.busy = true
    try {
      while (fresh(g) && r.inbox.length) {
        if (!runActive()) {
          r.inbox.length = 0
          break
        }
        const wake = r.inbox.shift()!
        if (r.turns >= config.maxTurnsPerAgent) {
          if (!r.capWarned) store.agentLog(r.id, 'WARN', `turn cap ${config.maxTurnsPerAgent} reached · no further wakes`)
          r.capWarned = true
          continue
        }
        try {
          await runTurn(r, wake, g)
        } catch (e) {
          if (fresh(g)) store.agentLog(r.id, 'FAIL', clip(errMsg(e), 160))
        }
      }
    } finally {
      r.busy = false
    }
  }

  // ---- wake message ---------------------------------------------------------

  function roomLine(item: ThreadItem): string | null {
    switch (item.kind) {
      case 'message':
        return `${item.time} ${nameOf(item.who)}: ${clip(item.body, ROOM_LINE_MAX)}`
      case 'tool':
        return `${item.time} ${nameOf(item.who)} → ${item.tool} ${clip(item.body, 80)}`
      case 'human':
        return `${item.time} Human(${item.target === 'all' ? 'all' : nameOf(item.target)}): ${clip(item.body, ROOM_LINE_MAX)}`
      case 'handoff':
        return `${item.time} handoff: ${item.body}`
      case 'divider':
        return `${item.time} — ${item.body}`
    }
  }

  function wakeText(r: Runner, wake: Wake): string {
    const head = `[${wake.tag}${wake.attrs ?? ''}]${wake.inline ? ` ${wake.inline}` : ''}`
    const parts = [wake.body ? `${head}\n${wake.body}` : head]
    const { items, seq } = store.threadSince(r.lastSeenSeq)
    r.lastSeenSeq = seq
    const lines = items
      .filter((i) => !('who' in i && i.who === r.id))
      .map(roomLine)
      .filter((l): l is string => l !== null)
      .slice(-ROOM_MAX_LINES)
    if (lines.length) parts.push(`[ROOM]\n${lines.join('\n')}`)
    if (wake.tree) parts.push(`[TREE]\n${workspace.describe()}`)
    return parts.join('\n')
  }

  // ---- the turn -------------------------------------------------------------

  async function runTurn(r: Runner, wake: Wake, g: number): Promise<void> {
    const ctx: TurnCtx = { human: wake.tag === 'HUMAN', plan: false, risk: false, tests: null, blocked: false, messageIds: [], mentions: new Map() }
    r.history.push({ role: 'user', content: wakeText(r, wake) })
    r.turns++
    let iterations = 0

    while (true) {
      await pauseGate
      if (!fresh(g)) return
      if (store.stats().costUsd >= config.budgetUsd) {
        failRun(`Run budget of $${config.budgetUsd} reached`)
        return
      }
      if (iterations >= config.maxIterationsPerTurn) {
        store.agentLog(r.id, 'WARN', `stopped after ${iterations} model calls in one turn`)
        break
      }
      iterations++

      const ac = new AbortController()
      const outcome = await callModel(r, ac, ctx, g)
      if (!fresh(g)) return
      if (outcome === 'aborted') {
        finishTurn(r, ctx)
        return
      }
      if (outcome === 'error') break

      store.addUsage(outcome.usage)
      r.history.push({ role: 'assistant', content: outcome.content })
      if (outcome.stopReason === 'refusal') {
        handleRefusal(r, outcome, ctx)
        break
      }
      if (!outcome.toolUses.length) break

      store.setAgent(r.id, { status: 'working' })
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const tu of outcome.toolUses) {
        results.push(await execTool(r, tu, ac.signal, ctx, g))
        if (!fresh(g)) return
      }
      r.history.push({ role: 'user', content: results })
      if (ac.signal.aborted) break
    }
    finishTurn(r, ctx)
  }

  async function callModel(r: Runner, ac: AbortController, ctx: TurnCtx, g: number): Promise<LLMResult | 'aborted' | 'error'> {
    r.abort = ac
    store.setAgent(r.id, { status: r.id === 'atlas' ? 'working' : 'thinking' })
    inFlight.add(r.id)
    syncTyping()
    const stream = createStreamer(r, ctx, g)
    try {
      const result = await llm.complete({
        agent: r.id,
        model: config.models[r.id],
        system: r.persona.system,
        tools: tools.definitionsFor(r.id),
        messages: r.history,
        maxTokens: MAX_TOKENS,
        effort: r.persona.effort,
        signal: ac.signal,
        onText: stream.onText,
      })
      if (!fresh(g)) return 'aborted'
      stream.finish(result.text)
      return result
    } catch (e) {
      const partial = stream.finish(null)
      if (!fresh(g)) return 'aborted'
      if (e instanceof LLMAbortedError || ac.signal.aborted) {
        // Keep the transcript alternating so the next wake is a clean user turn.
        r.history.push({ role: 'assistant', content: [{ type: 'text', text: partial || '(interrupted by the human operator)' }] })
        return 'aborted'
      }
      store.agentLog(r.id, 'FAIL', `model call failed · ${clip(errMsg(e), 140)}`)
      return 'error'
    } finally {
      if (r.abort === ac) r.abort = null
      if (fresh(g)) {
        inFlight.delete(r.id)
        syncTyping()
      }
    }
  }

  /** Mirrors streamed text into one thread message per assistant turn. */
  function createStreamer(r: Runner, ctx: TurnCtx, g: number) {
    let id: string | null = null
    let buf = ''
    let timer: NodeJS.Timeout | null = null
    let lastFlush = 0

    const flush = (): void => {
      timer = null
      lastFlush = Date.now()
      if (id && fresh(g)) store.patchThread(id, { body: buf })
    }

    return {
      onText(delta: string): void {
        if (!fresh(g) || !delta) return
        buf += delta
        if (!id) {
          id = post({ kind: 'message', who: r.id, body: buf, streaming: true }).id
          ctx.messageIds.push(id)
          lastFlush = Date.now()
          return
        }
        if (!timer) timer = setTimeout(flush, Math.max(0, STREAM_THROTTLE_MS - (Date.now() - lastFlush)))
      },
      /** Returns the text that reached the room. */
      finish(finalText: string | null): string {
        if (timer) clearTimeout(timer)
        timer = null
        if (!fresh(g)) return buf
        const body = finalText?.trim() ? finalText : buf
        if (id) store.patchThread(id, { body, streaming: false })
        else if (body.trim()) ctx.messageIds.push(post({ kind: 'message', who: r.id, body }).id)
        for (const m of body.matchAll(MENTION)) {
          const who = resolveAgent(m[1])
          if (who && who !== r.id && !ctx.mentions.has(who)) ctx.mentions.set(who, body)
        }
        return body
      },
    }
  }

  function handleRefusal(r: Runner, result: LLMResult, ctx: TurnCtx): void {
    const category = result.refusal?.category ?? 'unspecified'
    store.agentLog(r.id, 'RISK', `model declined (${category})`)
    const why = result.refusal?.explanation?.trim()
    const item = post({ kind: 'message', who: r.id, body: `I can't proceed with this${why ? ` — ${why}` : ''}. Holding until the plan changes.` })
    ctx.messageIds.push(item.id)
    ctx.blocked = true
    store.setAgent(r.id, { status: 'blocked', eta: 'blocked' })
    if (r.id !== 'atlas') {
      patchTask(r.id, { state: 'blocked', meta: 'blocked' })
      recompute()
      enqueue('atlas', { tag: 'REPORT', attrs: ` from=${r.id} kind=blocked`, inline: `model declined the request (${category})` })
    }
  }

  function finishTurn(r: Runner, ctx: TurnCtx): void {
    const badge = ctx.human ? 'ACK' : ctx.plan ? 'PLAN' : ctx.risk ? 'RISK' : (ctx.tests ?? (ctx.blocked ? 'BLOCKED' : null))
    const last = ctx.messageIds[ctx.messageIds.length - 1]
    if (badge && last) store.patchThread(last, { badge })
    const status: AgentStatus = agentState(r.id).status === 'blocked' ? 'blocked' : 'idle'
    store.setAgent(r.id, { status })
    // "@Probe the suite is yours" is a handoff in all but the tool call; deliver it once the
    // speaker's tools (typically the push being referred to) have run.
    for (const [who, line] of ctx.mentions) {
      if (who !== 'atlas') enqueue(who, { tag: 'HANDOFF', attrs: ` from=${r.id}`, inline: clip(line, 160) })
    }
  }

  // ---- tools ----------------------------------------------------------------

  async function execTool(
    r: Runner,
    tu: Anthropic.Beta.BetaToolUseBlock,
    signal: AbortSignal,
    ctx: TurnCtx,
    g: number,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const spec = tools.byApiName(tu.name)
    if (!spec) {
      store.agentLog(r.id, 'WARN', `unknown tool ${tu.name}`)
      return { type: 'tool_result', tool_use_id: tu.id, content: `error: unknown tool ${tu.name}`, is_error: true }
    }
    const input = (tu.input && typeof tu.input === 'object' ? tu.input : {}) as Record<string, unknown>
    const summary = spec.summarize(input)
    const call: ToolCall = { id: tu.id, name: spec.name, arg: summary, dur: '…', status: 'running' }
    store.agentTool(r.id, call)
    const item = post({ kind: 'tool', who: r.id, tool: spec.name, body: summary, dur: '…', status: 'running', lines: [] })

    const t0 = Date.now()
    const outcome = await spec.execute(input, { agent: r.id, workspace, run: store, signal })
    if (!fresh(g)) return { type: 'tool_result', tool_use_id: tu.id, content: outcome.result, is_error: !outcome.ok }

    const dur = fmtDur(Date.now() - t0)
    const status = outcome.ok ? 'ok' : 'error'
    store.patchThread(item.id, { dur, status, lines: outcome.lines ?? [] })
    store.agentTool(r.id, { ...call, dur, status })
    const log = outcome.log ?? { level: 'INFO' as const, msg: `${spec.name} ${summary}` }
    store.agentLog(r.id, log.level, log.msg)

    noteBadgeEvents(spec.name, input, outcome, ctx)
    let note: string | undefined
    if (outcome.effect) note = applyEffect(r, outcome.effect, outcome, ctx)
    const content = note ? `${outcome.result}\n${note}` : outcome.result
    return { type: 'tool_result', tool_use_id: tu.id, content, is_error: !outcome.ok }
  }

  function noteBadgeEvents(name: string, input: Record<string, unknown>, outcome: ToolOutcome, ctx: TurnCtx): void {
    if (name === 'run.set_phase' || name === 'run.assign') ctx.plan = true
    if (name === 'sec.scan' && outcome.log?.level === 'RISK') ctx.risk = true
    if (name === 'pr.comment' && outcome.ok && (input.blocking === true || input.blocking === 'true')) ctx.risk = true
  }

  // ---- effects --------------------------------------------------------------

  function applyEffect(r: Runner, e: ToolEffect, outcome: ToolOutcome, ctx: TurnCtx): string | undefined {
    switch (e.kind) {
      case 'assign':
        return effectAssign(e)
      case 'handoff':
        return effectHandoff(e)
      case 'set_phase':
        return effectSetPhase(e.phase)
      case 'progress':
        return effectProgress(r, e)
      case 'done':
        return effectDone(r, e)
      case 'blocked':
        return effectBlocked(r, e, ctx)
      case 'queue_add': {
        const queue = [...agentState(r.id).queue, { title: e.title, meta: e.meta ?? 'queued' }]
        store.setAgent(r.id, { queue, queueCount: queue.length })
        return
      }
      case 'tests': {
        const ratio = `${e.passed}/${e.total}`
        patchTask(r.id, { meta: ratio })
        store.setAgent(r.id, { subtask: `e2e suite ${ratio}` })
        ctx.tests = ratio
        recompute()
        return
      }
      case 'risk':
        if (!outcome.log) store.agentLog(r.id, 'RISK', e.msg)
        ctx.risk = true
        return
      case 'pr_review':
        if (!outcome.log) store.agentLog(r.id, 'INFO', `review ${e.verdict.replace('_', ' ')}`)
        return
      case 'pushed':
        if (!outcome.log) store.agentLog(r.id, 'INFO', `pushed ${e.sha}`)
        return
      case 'request_merge':
        return effectRequestMerge()
      case 'finish_run':
        return effectFinish()
    }
  }

  function effectAssign(e: Extract<ToolEffect, { kind: 'assign' }>): undefined {
    const id = `${e.phase}/${e.agent}/${slug(e.title)}`
    store.upsertTask({ id, title: e.title, owner: e.agent, phase: e.phase, state: 'active', meta: '0%' })
    const target = runners.get(e.agent)
    if (target) target.taskId = id
    store.setAgent(e.agent, { status: 'working', pct: 0, subtask: e.title, subtaskTitle: e.subtask, eta: e.eta ?? '—' })
    refreshAtlas()
    recompute()
    enqueue(e.agent, {
      tag: 'ASSIGNMENT',
      inline: `title: ${e.title}`,
      body: `phase: ${e.phase}\nsubtask: ${e.subtask}\neta: ${e.eta ?? '—'}`,
      tree: true,
    })
    return undefined
  }

  function effectHandoff(e: Extract<ToolEffect, { kind: 'handoff' }>): undefined {
    post({ kind: 'handoff', body: `${nameOf(e.from)} → ${nameOf(e.to)} · ${e.note}` })
    const task = currentTask(e.to)
    if (task?.state === 'blocked') {
      store.upsertTask({ ...task, state: 'active', meta: `${agentState(e.to).pct}%` })
      store.setAgent(e.to, { status: 'working', eta: '—' })
      refreshAtlas()
    }
    recompute()
    enqueue(e.to, { tag: 'HANDOFF', attrs: ` from=${e.from}`, inline: e.note, tree: true })
    return undefined
  }

  function effectSetPhase(phase: Phase): undefined {
    post({ kind: 'divider', body: `PHASE ${PHASES.indexOf(phase) + 1} · ${phase.toUpperCase()}` })
    recompute(phase)
    return undefined
  }

  function effectProgress(r: Runner, e: Extract<ToolEffect, { kind: 'progress' }>): undefined {
    store.setAgent(r.id, {
      pct: e.pct,
      ...(e.subtask ? { subtask: e.subtask } : {}),
      ...(e.eta ? { eta: e.eta } : {}),
      ...(e.io?.length ? { io: e.io } : {}),
    })
    const task = currentTask(r.id)
    // A test task keeps its passed/total cell; a percentage would hide the number that matters.
    if (task && !(task.phase === 'test' && isRatio(task.meta))) store.upsertTask({ ...task, meta: `${e.pct}%` })
    recompute()
    return undefined
  }

  function effectDone(r: Runner, e: Extract<ToolEffect, { kind: 'done' }>): undefined {
    store.setAgent(r.id, { status: 'idle', pct: 100, eta: 'done', subtask: clip(e.summary, 50), ...(e.io?.length ? { io: e.io } : {}) })
    patchTask(r.id, { state: 'done', meta: 'done' })
    refreshAtlas()
    recompute()
    enqueue('atlas', { tag: 'REPORT', attrs: ` from=${r.id} kind=done`, inline: e.summary })
    return undefined
  }

  function effectBlocked(r: Runner, e: Extract<ToolEffect, { kind: 'blocked' }>, ctx: TurnCtx): undefined {
    store.setAgent(r.id, { status: 'blocked', eta: 'blocked' })
    patchTask(r.id, { state: 'blocked', meta: 'blocked' })
    ctx.blocked = true
    refreshAtlas()
    recompute()
    const inline = e.waitingOn ? `${e.reason} (waiting on ${e.waitingOn})` : e.reason
    enqueue('atlas', { tag: 'REPORT', attrs: ` from=${r.id} kind=blocked`, inline })
    return undefined
  }

  function effectRequestMerge(): string | undefined {
    const info = runInfo()
    if (info.approvalGate && !approvedEarly) {
      store.setRun({ status: 'needs_approval' })
      recompute()
      return 'note: the human approval gate is on — the run is holding until the human approves'
    }
    approvedEarly = false
    const merged = mergePr()
    if (!merged.ok) return `merge failed: ${merged.reason ?? 'unknown reason'}`
    store.setRun({ status: 'done' })
    recompute('done')
    stopTicker()
    return 'note: gate off — PR merged, run is done'
  }

  function effectFinish(): string | undefined {
    if (!workspace.pr.state().merged) {
      const merged = mergePr()
      if (!merged.ok) store.agentLog('atlas', 'WARN', `run finished with PR unmerged · ${merged.reason ?? 'merge failed'}`)
    }
    store.setRun({ status: 'done' })
    recompute('done')
    store.setTyping([])
    stopTicker()
    return undefined
  }

  /** Merges, or tells the room why it could not. */
  function mergePr(): { ok: boolean; reason?: string } {
    const result = workspace.pr.merge()
    if (!result.ok) {
      post({ kind: 'message', who: 'atlas', body: `Merge blocked — ${result.reason ?? 'the PR cannot be merged yet'}. Holding at the gate.` })
      store.agentLog('atlas', 'WARN', `merge blocked · ${clip(result.reason ?? 'unknown', 80)}`)
    }
    return result
  }

  // ---- human commands -------------------------------------------------------

  function resolveAgent(word: string): AgentId | null {
    const w = word.toLowerCase().replace(/^@/, '')
    return AGENT_IDS.find((id) => id === w || nameOf(id).toLowerCase() === w) ?? null
  }

  function humanWake(target: MessageTarget, body: string): void {
    const to: AgentId = target === 'all' ? 'atlas' : target
    enqueue(to, { tag: 'HUMAN', attrs: ` target=${target}`, inline: body }, true)
  }

  function slashCommand(body: string, target: MessageTarget): boolean {
    const [cmd, ...rest] = body.split(/\s+/)
    const arg = rest.join(' ')
    switch (cmd.toLowerCase()) {
      case '/approve':
        post({ kind: 'human', body, target })
        approve()
        return true
      case '/pause':
        pause()
        return true
      case '/resume':
        resume()
        return true
      case '/assign': {
        const agent = rest[0] ? resolveAgent(rest[0]) : null
        if (!agent) return false
        const text = rest.slice(1).join(' ') || 'the next open subtask'
        post({ kind: 'human', body, target })
        humanWake('all', `Assign ${agent}: ${text}`)
        return true
      }
      case '/rollback':
        post({ kind: 'human', body, target })
        humanWake('forge', `Roll back the build to the last push${arg && arg !== 'build' ? ` (${arg})` : ''}`)
        return true
      default:
        return false
    }
  }

  // ---- public API -----------------------------------------------------------

  function approve(): void {
    const info = runInfo()
    if (info.status === 'needs_approval') {
      const merged = mergePr()
      if (!merged.ok) return
      store.setRun({ status: 'live' })
      recompute()
      enqueue('atlas', { tag: 'GATE_APPROVED' }, true)
      return
    }
    if (info.status === 'live' || info.status === 'paused') approvedEarly = true
  }

  function pause(): void {
    if (runInfo().status !== 'live') return
    store.setRun({ status: 'paused' })
    pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve
    })
    recompute()
  }

  function resume(): void {
    if (runInfo().status !== 'paused') return
    store.setRun({ status: 'live' })
    release()
    recompute()
  }

  const orchestrator: Orchestrator = {
    async start() {
      gen++
      abortAll()
      release()
      approvedEarly = false
      const previous = runInfo()
      store.reset({
        label: 'RUN 04',
        status: 'live',
        channel: '#feature-passkey-auth',
        repo: 'helios/api',
        branch: 'feat/passkey-auth',
        goal: 'Ship passkey sign-in behind the auth.passkeys flag',
        startedAt: store.now(),
        toolServers: 3,
        llm: llm.kind,
        approvalGate: previous.approvalGate,
      })
      workspace.reset()
      runners = newRunners()
      refreshAtlas()
      startTicker()
      enqueue('atlas', { tag: 'RUN_START', body: `goal: ${runInfo().goal}` })
    },

    pause,
    resume,

    setGate(enabled) {
      store.setRun({ approvalGate: enabled })
      refreshAtlas()
      recompute()
      if (!enabled && runInfo().status === 'needs_approval') approve()
    },

    approve,

    async humanMessage(body, target) {
      const text = body.trim()
      if (!text) return
      if (text.startsWith('/') && slashCommand(text, target)) return
      post({ kind: 'human', body: text, target })
      humanWake(target, text)
    },

    interrupt(agent) {
      const r = runners.get(agent)
      if (!r) return
      r.abort?.abort()
      store.agentLog(agent, 'WARN', 'interrupted by human')
      store.setAgent(agent, { status: 'idle' })
    },

    dispose() {
      disposed = true
      gen++
      abortAll()
      release()
      stopTicker()
    },
  }

  return orchestrator
}
