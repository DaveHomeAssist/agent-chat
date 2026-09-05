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
import { LLMRequestError, toolNamesFor } from './contracts.js'
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
  /** HUMAN only: the operator's messages coalesced into this wake, in arrival order. */
  texts?: string[]
  /** ASSIGNMENT only: the task to make current when the wake is dequeued. */
  assign?: Assignment
}

interface Assignment {
  id: string
  subtask: string
  eta: string
}

/** What happened during one wake, for the badge on the agent's message. */
interface TurnCtx {
  human: boolean
  plan: boolean
  risk: boolean
  tests: string | null
  blocked: boolean
  messageIds: string[]
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
const ENDED_STATUSES: readonly RunInfo['status'][] = ['done', 'failed']

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const isRatio = (s: string): boolean => /^\d+\/\d+$/.test(s)
const fmtDur = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)
/**
 * Wake messages are parsed by their bracketed tag lines, so no dynamic text may
 * start a line with '['. Inline fragments (tag line, room lines) lose their
 * newlines; multi-line bodies are indented so every line starts with a space.
 */
const oneLine = (s: string): string => s.replace(/[ \t]*\r?\n[ \t]*/g, ' ⏎ ')
const indent = (s: string): string =>
  s
    .split(/\r?\n/)
    .map((l) => `  ${l}`)
    .join('\n')

export function createOrchestrator(deps: Deps): Orchestrator {
  const { store, llm, workspace, tools, config } = deps
  const personas = new Map(deps.personas.map((p) => [p.id, p]))
  const nameOf = (id: AgentId): string => personas.get(id)?.name ?? id

  let gen = 0
  let disposed = false
  let runners = new Map<AgentId, Runner>()
  let ticker: NodeJS.Timeout | null = null
  const inFlight = new Set<AgentId>()
  let approvedRevision: number | null = null
  let pendingMergeRevision: number | null = null
  /** Human pause, tracked apart from `run.status` — a merge request or the end of the run may overwrite that. */
  let paused = false
  let pauseGate: Promise<void> | null = null
  let releasePause: (() => void) | null = null

  const maybeBudget = store as RunStore & { setBudget?: (usd: number) => void }
  maybeBudget.setBudget?.(config.budgetUsd)

  // ---- state helpers ------------------------------------------------------

  const fresh = (g: number): boolean => g === gen && !disposed && runActive()
  const post = (item: ThreadDraft): ThreadItem => store.appendThread(item as Parameters<RunStore['appendThread']>[0])
  const runInfo = (): RunInfo => store.snapshot().run
  const runActive = (): boolean => ACTIVE_STATUSES.includes(runInfo().status)
  const runEnded = (): boolean => ENDED_STATUSES.includes(runInfo().status)
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
    paused = false
    releasePause?.()
    releasePause = null
    pauseGate = null
  }

  /** Resolves when the pause lifts or the turn is aborted, whichever comes first. */
  function awaitPause(signal: AbortSignal): Promise<void> {
    const gate = pauseGate
    if (!gate || signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        signal.removeEventListener('abort', wake)
        resolve()
      }
      signal.addEventListener('abort', wake, { once: true })
      void gate.then(wake)
    })
  }

  function startTicker(): void {
    stopTicker()
    ticker = setInterval(() => store.tick(), 1000)
  }

  function stopTicker(): void {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  /** Ends the run as failed. Idempotent: a run that has already ended keeps its outcome. */
  function failRun(error: string): void {
    if (runEnded()) return
    endRun('failed', error)
  }

  function endRun(status: 'done' | 'failed', error?: string): void {
    gen++
    abortAll()
    release()
    stopTicker()
    approvedRevision = null
    pendingMergeRevision = null
    store.setRun({ status, ...(error ? { error } : {}) })
    // Nothing in flight will report back (gen moved on), so close out what it left mid-way.
    for (const r of runners.values()) {
      const a = agentState(r.id)
      if (a.status !== 'idle' && a.status !== 'blocked') store.setAgent(r.id, { status: 'idle' })
      for (const t of a.tools) if (t.status === 'running') store.agentTool(r.id, { ...t, dur: '—', status: 'error' })
    }
    for (const item of store.snapshot().thread) {
      if (item.kind === 'message' && item.streaming) store.patchThread(item.id, { streaming: false })
      else if (item.kind === 'tool' && item.status === 'running') store.patchThread(item.id, { dur: '—', status: 'error' })
    }
    store.setTyping([])
    recompute(status === 'done' ? 'done' : undefined)
  }

  /** Ends the run as done. Releases anyone parked on a pause so they are not stranded. */
  function markDone(): void {
    if (!runEnded()) endRun('done')
  }

  // ---- wake queue -----------------------------------------------------------

  /** `front` puts human-originated wakes ahead of agent traffic, behind earlier ones so arrival order holds. */
  function enqueue(id: AgentId, wake: Wake, front = false): void {
    const r = runners.get(id)
    if (!r) return
    if (!runActive()) {
      if (runEnded()) store.agentLog(id, 'INFO', `run ${runInfo().status} · ${wake.tag} wake dropped`)
      return
    }
    if (front) {
      let at = 0
      while (at < r.inbox.length && (r.inbox[at].tag === 'HUMAN' || r.inbox[at].tag === 'GATE_APPROVED')) at++
      r.inbox.splice(at, 0, wake)
    } else r.inbox.push(wake)
    void pump(r, gen)
  }

  async function pump(r: Runner, g: number): Promise<void> {
    if (r.busy) return
    r.busy = true
    try {
      while (fresh(g) && r.inbox.length) {
        if (!runActive()) {
          if (runEnded()) store.agentLog(r.id, 'INFO', `run ${runInfo().status} · ${r.inbox.length} pending wake${r.inbox.length === 1 ? '' : 's'} dropped`)
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
          if (fresh(g)) failRun(`${nameOf(r.id)} turn failed: ${clip(errMsg(e), 160)}`)
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
        return `${item.time} ${nameOf(item.who)}: ${clip(oneLine(item.body), ROOM_LINE_MAX)}`
      case 'tool':
        return `${item.time} ${nameOf(item.who)} → ${item.tool} ${clip(oneLine(item.body), 80)}`
      case 'human':
        return `${item.time} Human(${item.target === 'all' ? 'all' : nameOf(item.target)}): ${clip(oneLine(item.body), ROOM_LINE_MAX)}`
      case 'handoff':
        return `${item.time} handoff: ${oneLine(item.body)}`
      case 'divider':
        return `${item.time} — ${oneLine(item.body)}`
    }
  }

  function wakeText(r: Runner, wake: Wake): string {
    const head = `[${wake.tag}${wake.attrs ?? ''}]${wake.inline ? ` ${oneLine(wake.inline)}` : ''}`
    // Body lines are label-prefixed or indented already; stripping a leading '[' is the last line of defence.
    const body = wake.body?.replace(/^\[/gm, '')
    const parts = [body ? `${head}\n${body}` : head]
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
    const ctx: TurnCtx = { human: wake.tag === 'HUMAN', plan: false, risk: false, tests: null, blocked: false, messageIds: [] }
    // One controller for the whole turn: model calls, tool execution and the pause park all answer to it.
    const ac = new AbortController()
    r.abort = ac
    try {
      if (wake.assign) activateTask(r, wake.assign)
      r.history.push({ role: 'user', content: wakeText(r, wake) })
      r.turns++
      let iterations = 0

      while (true) {
        if (!fresh(g)) return
        if (pauseGate) {
          await awaitPause(ac.signal)
          if (!fresh(g)) return
          if (!runActive()) {
            store.agentLog(r.id, 'INFO', `run ${runInfo().status} while paused · turn dropped`)
            break
          }
        }
        if (ac.signal.aborted) break
        if (store.stats().costUsd >= config.budgetUsd) {
          failRun(`Run budget of $${config.budgetUsd} reached`)
          return
        }
        if (iterations >= config.maxIterationsPerTurn) {
          store.agentLog(r.id, 'WARN', `stopped after ${iterations} model calls in one turn`)
          break
        }
        iterations++

        const revision = workspace.revision()
        const outcome = await callModel(r, ac, ctx, g)
        if (!fresh(g)) return
        if (outcome === 'aborted') break
        if (outcome instanceof Error) {
          handleModelError(r, outcome, ctx)
          if (!fresh(g)) return
          break
        }

        if (store.stats().costUsd >= config.budgetUsd) {
          failRun(`Run budget of $${config.budgetUsd} reached`)
          return
        }
        if (outcome.stopReason === 'refusal') {
          // A classifier refusal carries no content; an empty assistant turn would 400 every later call.
          r.history.push({ role: 'assistant', content: [{ type: 'text', text: outcome.text.trim() || '(the model declined this request)' }] })
          handleRefusal(r, outcome, ctx)
          break
        }
        if (outcome.stopReason === 'max_tokens') store.agentLog(r.id, 'WARN', `response truncated at ${MAX_TOKENS} output tokens`)
        r.history.push({ role: 'assistant', content: outcome.content })
        if (!outcome.toolUses.length) break

        store.setAgent(r.id, { status: 'working' })
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        for (const tu of outcome.toolUses) {
          if (pauseGate) await awaitPause(ac.signal)
          if (!fresh(g)) return
          if (ac.signal.aborted) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'error: interrupted by the human operator', is_error: true })
            continue
          }
          results.push(await execTool(r, tu, ac.signal, ctx, g, revision))
          if (!fresh(g)) return
        }
        r.history.push({ role: 'user', content: results })
      }
      if (fresh(g)) finishTurn(r, ctx)
    } finally {
      if (r.abort === ac) r.abort = null
    }
  }

  async function callModel(r: Runner, ac: AbortController, ctx: TurnCtx, g: number): Promise<LLMResult | 'aborted' | Error> {
    store.setAgent(r.id, { status: r.id === 'atlas' ? 'working' : 'thinking' })
    inFlight.add(r.id)
    syncTyping()
    const usageRunId = runInfo().id
    const stream = createStreamer(r, ctx, g, ac.signal)
    try {
      const result = await llm.complete({
        agent: r.id,
        model: config.models[r.id],
        system: r.persona.system,
        tools: tools.definitionsFor(r.id),
        messages: r.history,
        maxTokens: MAX_TOKENS,
        effort: config.effort,
        signal: ac.signal,
        onText: stream.onText,
      })
      // Reported cost survives interruption, termination and restart. Old run usage
      // goes to the lifetime ledger without touching the new run's tasks or spend.
      store.addUsage(result.usage, usageRunId)
      if (fresh(g) && store.stats().costUsd >= config.budgetUsd) {
        failRun(`Run budget of $${config.budgetUsd} reached`)
      }
      if (!fresh(g)) return 'aborted'
      if (ac.signal.aborted) {
        const partial = stream.finish(null)
        r.history.push({ role: 'assistant', content: [{ type: 'text', text: partial || '(interrupted by the human operator)' }] })
        return 'aborted'
      }
      stream.finish(result.text)
      return result
    } catch (e) {
      if (e instanceof LLMRequestError && e.usage) store.addUsage(e.usage, usageRunId)
      if (fresh(g) && store.stats().costUsd >= config.budgetUsd) failRun(`Run budget of $${config.budgetUsd} reached`)
      const partial = stream.finish(null)
      if (!fresh(g)) return 'aborted'
      if (ac.signal.aborted) {
        // Keep the transcript alternating so the next wake is a clean user turn.
        r.history.push({ role: 'assistant', content: [{ type: 'text', text: partial || '(interrupted by the human operator)' }] })
        return 'aborted'
      }
      const err = e instanceof Error ? e : new Error(String(e))
      r.history.push({ role: 'assistant', content: [{ type: 'text', text: partial || `(model call failed: ${clip(err.message, 140)})` }] })
      return err
    } finally {
      if (fresh(g)) {
        inFlight.delete(r.id)
        syncTyping()
      }
    }
  }

  /** Mirrors streamed text into one thread message per assistant turn. */
  function createStreamer(r: Runner, ctx: TurnCtx, g: number, signal: AbortSignal) {
    let id: string | null = null
    let buf = ''
    let timer: NodeJS.Timeout | null = null
    let lastFlush = 0

    const flush = (): void => {
      timer = null
      lastFlush = Date.now()
      if (id && fresh(g) && !signal.aborted) store.patchThread(id, { body: buf })
    }

    return {
      onText(delta: string): void {
        if (!fresh(g) || signal.aborted || !delta) return
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
        return body
      },
    }
  }

  /**
   * A model call that failed for a reason other than an interrupt (unknown
   * model, API failure after the SDK's retries). Fail explicitly for every
   * agent: asking another agent cannot repair an unrecoverable provider error.
   */
  function handleModelError(r: Runner, e: Error, ctx: TurnCtx): void {
    const msg = clip(e.message, 140)
    store.agentLog(r.id, 'FAIL', `model call failed · ${msg}`)
    ctx.messageIds.push(post({ kind: 'message', who: r.id, body: `model call failed: ${msg}` }).id)
    failRun(`${nameOf(r.id)} model call failed: ${msg}`)
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
  }

  // ---- tools ----------------------------------------------------------------

  async function execTool(
    r: Runner,
    tu: Anthropic.Beta.BetaToolUseBlock,
    signal: AbortSignal,
    ctx: TurnCtx,
    g: number,
    revision: number,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const reject = (reason: string): Anthropic.Beta.BetaToolResultBlockParam =>
      ({ type: 'tool_result', tool_use_id: tu.id, content: `error: ${reason}`, is_error: true })
    if (!fresh(g) || signal.aborted) return reject('turn is no longer active')
    const spec = tools.byApiName(tu.name)
    if (!spec) {
      store.agentLog(r.id, 'WARN', `unknown tool ${tu.name}`)
      return { type: 'tool_result', tool_use_id: tu.id, content: `error: unknown tool ${tu.name}`, is_error: true }
    }
    if (!toolNamesFor(r.id).includes(spec.name)) return reject(`${r.id} is not authorized to execute ${spec.name}`)
    const input = (tu.input && typeof tu.input === 'object' ? tu.input : {}) as Record<string, unknown>
    const summary = spec.summarize(input)
    const call: ToolCall = { id: tu.id, name: spec.name, arg: summary, dur: '…', status: 'running' }
    store.agentTool(r.id, call)
    const item = post({ kind: 'tool', who: r.id, tool: spec.name, body: summary, dur: '…', status: 'running', lines: [] })

    const t0 = Date.now()
    const outcome = await spec.execute(input, { agent: r.id, revision, workspace, run: store, signal })
    if (!fresh(g)) return reject('run ended or restarted during tool execution')

    invalidateApproval()

    const dur = fmtDur(Date.now() - t0)
    const status = outcome.ok && !signal.aborted ? 'ok' : 'error'
    store.patchThread(item.id, { dur, status, lines: outcome.lines ?? [] })
    store.agentTool(r.id, { ...call, dur, status })
    const log = outcome.log ?? { level: 'INFO' as const, msg: `${spec.name} ${summary}` }
    store.agentLog(r.id, log.level, log.msg)
    if (signal.aborted) return reject('tool interrupted; no effects applied')

    noteBadgeEvents(spec.name, input, outcome, ctx)
    const note = outcome.effect ? applyEffect(r, outcome.effect, outcome, ctx) : undefined
    // An effect that could not be applied ("error: …") turns an ok tool outcome into an error result.
    const failed = note !== undefined && note.startsWith('error:')
    if (failed) {
      store.patchThread(item.id, { status: 'error' })
      store.agentTool(r.id, { ...call, dur, status: 'error' })
      store.agentLog(r.id, 'WARN', clip(note, 120))
    }
    const content = failed ? note : note ? `${outcome.result}\n${note}` : outcome.result
    return { type: 'tool_result', tool_use_id: tu.id, content, is_error: !outcome.ok || failed }
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
    const target = runners.get(e.agent)
    const assign: Assignment = { id, subtask: e.subtask, eta: e.eta ?? '—' }
    // An agent mid-turn or with an active task keeps reporting against that task; the new one
    // waits as `queued` and becomes current only when its wake is dequeued. The record always
    // starts `queued`: `activateTask` alone flips it to active and writes the agent row, so a
    // re-assignment of a title the agent already held goes through full activation too.
    const held = target?.taskId ? store.tasks().find((t) => t.id === target.taskId) : undefined
    const defer = target !== undefined && (target.busy || held?.state === 'active')
    store.upsertTask({ id, title: e.title, owner: e.agent, phase: e.phase, state: 'queued', meta: 'queued' })
    if (!defer && target) activateTask(target, assign)
    refreshAtlas()
    recompute()
    enqueue(e.agent, {
      tag: 'ASSIGNMENT',
      inline: `title: ${e.title}`,
      body: `phase: ${e.phase}\nsubtask: ${oneLine(e.subtask)}\neta: ${oneLine(e.eta ?? '—')}`,
      tree: true,
      assign,
    })
    return undefined
  }

  /** Makes `a` the runner's current task; a previous task still active is closed out rather than lost. */
  function activateTask(r: Runner, a: Assignment): void {
    const tasks = store.tasks()
    const next = tasks.find((t) => t.id === a.id)
    if (!next || (r.taskId === a.id && next.state === 'active')) return
    if (r.taskId && r.taskId !== a.id) {
      const prev = tasks.find((t) => t.id === r.taskId)
      if (prev?.state === 'active') store.upsertTask({ ...prev, state: 'done', meta: 'done' })
    }
    r.taskId = a.id
    if (next.state !== 'active') store.upsertTask({ ...next, state: 'active', meta: '0%' })
    store.setAgent(r.id, { status: 'working', pct: 0, subtask: next.title, subtaskTitle: a.subtask, eta: a.eta })
    refreshAtlas()
    recompute()
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

  function invalidateApproval(): void {
    const revision = workspace.revision()
    if (approvedRevision !== revision) approvedRevision = null
    if (pendingMergeRevision !== null && pendingMergeRevision !== revision) {
      pendingMergeRevision = null
      if (runInfo().status === 'needs_approval') {
        store.setRun({ status: paused ? 'paused' : 'live' })
        post({ kind: 'message', who: 'atlas', body: 'Revision changed. Fresh tests, review and a new merge request are required.' })
        recompute()
      }
    }
  }

  function effectRequestMerge(): string | undefined {
    invalidateApproval()
    const ready = workspace.pr.checkMerge()
    if (!ready.ok) return `error: merge prerequisites failed — ${ready.reason}`
    const revision = workspace.revision()
    if (runInfo().approvalGate && approvedRevision !== revision) {
      pendingMergeRevision = revision
      store.setRun({ status: 'needs_approval' })
      recompute()
      return 'note: the human approval gate is on — holding this revision until the human approves'
    }
    const merged = mergePr()
    if (!merged.ok) return `error: merge failed — ${merged.reason ?? 'unknown reason'}`
    markDone()
    return 'note: PR merged, run is done'
  }

  /** Completion acknowledges an existing merge; it never initiates one. */
  function effectFinish(): string | undefined {
    if (!workspace.pr.state().merged) return 'error: PR is not merged; use run_request_merge and satisfy the approval gate first'
    markDone()
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

  /** One message on the tag line; several, or a multi-line one, indented beneath it. */
  function humanWakeText(texts: string[]): Pick<Wake, 'inline' | 'body'> {
    const single = texts.length === 1 && !/\n/.test(texts[0])
    return single ? { inline: texts[0], body: undefined } : { inline: undefined, body: texts.map(indent).join('\n\n') }
  }

  function humanWake(target: MessageTarget, body: string): void {
    const to: AgentId = target === 'all' ? 'atlas' : target
    const attrs = ` target=${target}`
    // A message that arrives while an earlier one is still waiting joins that wake — one turn, both messages, in order.
    const pending = runners.get(to)?.inbox.find((w) => w.tag === 'HUMAN' && w.attrs === attrs)
    if (pending?.texts) {
      pending.texts.push(body)
      Object.assign(pending, humanWakeText(pending.texts))
      return
    }
    const texts = [body]
    enqueue(to, { tag: 'HUMAN', attrs, texts, ...humanWakeText(texts) }, true)
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
    if (!runActive()) return
    invalidateApproval()
    const ready = workspace.pr.checkMerge()
    if (!ready.ok) {
      approvedRevision = null
      post({ kind: 'message', who: 'atlas', body: `Approval blocked — ${ready.reason}` })
      return
    }
    const revision = workspace.revision()
    approvedRevision = revision
    if (runInfo().status !== 'needs_approval' || pendingMergeRevision !== revision) return
    const merged = mergePr()
    if (!merged.ok) {
      approvedRevision = null
      return
    }
    post({ kind: 'message', who: 'atlas', body: 'Human approval received. Simulated PR #482 merged; run complete.' })
    markDone()
  }

  function pause(): void {
    if (paused || runInfo().status !== 'live') return
    paused = true
    store.setRun({ status: 'paused' })
    pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve
    })
    recompute()
  }

  /** Always lifts the gate; the status goes back to live unless a merge request moved it on meanwhile. */
  function resume(): void {
    if (!paused) return
    release()
    if (runInfo().status === 'paused') store.setRun({ status: 'live' })
    recompute()
  }

  const orchestrator: Orchestrator = {
    async start() {
      if (disposed) return
      gen++
      abortAll()
      release()
      approvedRevision = null
      pendingMergeRevision = null
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
      enqueue('atlas', { tag: 'RUN_START', body: `goal: ${oneLine(runInfo().goal)}` })
    },

    pause,
    resume,

    setGate(enabled) {
      if (disposed) return
      store.setRun({ approvalGate: enabled })
      refreshAtlas()
      recompute()
      if (!enabled && runInfo().status === 'needs_approval') approve()
    },

    approve,

    async humanMessage(body, target) {
      const text = body.trim()
      if (!text || !runActive() || disposed) return
      if (text.startsWith('/') && slashCommand(text, target)) return
      post({ kind: 'human', body: text, target })
      humanWake(target, text)
    },

    interrupt(agent) {
      if (!runActive() || disposed) return
      // Only a turn in progress can be interrupted; the log and the idle status would otherwise be a lie.
      const ac = runners.get(agent)?.abort
      if (!ac || ac.signal.aborted) return
      ac.abort()
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
