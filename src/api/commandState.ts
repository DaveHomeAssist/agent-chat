import type { AgentId, CommandResult, MessageTarget, RunEvent, RunSnapshot } from '../../shared/protocol.js'
import { isSequence, patchThread, validateEvent, validateSnapshot } from './runValidation.js'

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting'
export type Command =
  | { kind: 'send'; body: string; target: MessageTarget }
  | { kind: 'start' | 'pause' | 'resume' | 'approve' }
  | { kind: 'gate'; enabled: boolean }
  | { kind: 'interrupt'; id: AgentId }
export type CommandOutcome =
  | { kind: 'accepted'; attemptId: number; contextGeneration: number; seq: number }
  | { kind: 'rejected'; error: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'obsolete' }
export type RefreshOutcome = 'refreshed' | 'unavailable' | 'obsolete'
const admissionBrand: unique symbol = Symbol('rendered admission')
export interface AdmissionToken {
  readonly [admissionBrand]: true
  readonly contextGeneration: number
  readonly authVersion: number
  readonly runId: string | null
  readonly readiness: number
  readonly statusRevision: number
  readonly gateRevision: number
  readonly prRevision: number
  readonly phaseRevision: number
  readonly status: RunSnapshot['run']['status'] | null
  readonly gate: boolean | null
}
export interface PendingCommand {
  id: number
  label: string
  lane: string
  phase: 'network' | 'synchronizing'
  deadline: number
}
export interface CommandView {
  snapshot: RunSnapshot | null
  connection: ConnectionStatus
  admission: AdmissionToken
  lastError: string | null
  pending: readonly PendingCommand[]
  coherence: 'awaiting_snapshot' | 'coherent' | 'repairing' | 'needs_refresh'
  availabilityReason: string | null
  mutationAvailable: boolean
  globalAvailable: boolean
  sendAvailable: boolean
  interruptAvailable: Readonly<Record<AgentId, boolean>>
  refreshPending: boolean
  synchronization: { deadline: number; reason: string } | null
}
interface Clock {
  now(): number
  schedule(fn: () => void, ms: number): () => void
}
interface Transports {
  execute(command: Command, signal: AbortSignal): Promise<CommandResult>
  fetchState(signal: AbortSignal): Promise<unknown>
  refresh(signal: AbortSignal): void
}
interface Ticket extends PendingCommand {
  generation: number
  controller: AbortController
  cancelTimer: () => void
  resolve: (outcome: CommandOutcome) => void
  settled: boolean
  seq?: number
}
interface Episode {
  id: number
  generation: number
  deadline: number
  cancelTimer: () => void
  readStarted: boolean
  read: { id: number; epoch: number; invalidGeneration: number; controller: AbortController } | null
}
interface ManualRefresh {
  id: number
  generation: number
  epoch: number | null
  deadline: number
  controller: AbortController
  cancelTimer: () => void
  resolve: (outcome: RefreshOutcome) => void
}
const TIMEOUT = 'Command timed out. Its outcome is unknown; check the run before trying again.'
const AGENTS: AgentId[] = ['atlas', 'vector', 'forge', 'probe', 'sentry']
const defaultClock: Clock = {
  now: () => performance.now(),
  schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer) },
}
let nextGeneration = 0

function lane(command: Command): string {
  if (command.kind === 'interrupt') return `interrupt:${command.id}`
  if (command.kind === 'send' && !command.body.trimStart().startsWith('/')) return 'send'
  return 'global'
}
function label(command: Command): string {
  if (command.kind === 'send') return command.body.trimStart().startsWith('/') ? 'Slash command' : 'Message'
  if (command.kind === 'interrupt') return `Interrupt ${command.id}`
  return ({ start: 'Start run', pause: 'Pause run', resume: 'Resume run', approve: 'Approve merge', gate: 'Merge approval gate' })[command.kind]
}
function apply(snapshot: RunSnapshot, event: Exclude<RunEvent, { type: 'snapshot' }>): RunSnapshot | null {
  const next = { ...snapshot, seq: event.seq }
  switch (event.type) {
    case 'run':
      if (event.run.id !== undefined && event.run.id !== snapshot.run.id) return null
      return { ...next, run: { ...snapshot.run, ...event.run } }
    case 'stats': return { ...next, stats: event.stats }
    case 'pipeline': return { ...next, pipeline: event.pipeline }
    case 'typing': return event.typing.every((id) => snapshot.agents.some((a) => a.id === id)) ? { ...next, typing: event.typing } : null
    case 'thread.append': {
      const item = event.item
      if (snapshot.thread.some((t) => t.id === item.id) || ('who' in item && !snapshot.agents.some((a) => a.id === item.who))) return null
      return { ...next, thread: [...snapshot.thread, item] }
    }
    case 'thread.patch': {
      const item = snapshot.thread.find((item) => item.id === event.id)
      const patched = item ? patchThread(item, event.patch) : null
      if (!patched || ('who' in patched && !snapshot.agents.some((a) => a.id === patched.who))) return null
      return { ...next, thread: snapshot.thread.map((item) => item.id === event.id ? patched : item) }
    }
    default: {
      const agent = snapshot.agents.find((a) => a.id === event.id)
      if (!agent) return null
      let updated = agent
      if (event.type === 'agent') {
        if ('id' in event.patch && event.patch.id !== event.id) return null
        updated = { ...agent, ...event.patch }
      } else if (event.type === 'agent.log') updated = { ...agent, log: [...agent.log, event.line].slice(-200) }
      else updated = { ...agent, tools: agent.tools.some((t) => t.id === event.call.id) ? agent.tools.map((t) => t.id === event.call.id ? event.call : t) : [...agent.tools, event.call] }
      return { ...next, agents: snapshot.agents.map((a) => a.id === event.id ? updated : a) }
    }
  }
}

/** One synchronous owner for stream truth, admission and all asynchronous settlement. */
export class CommandController {
  private generation = ++nextGeneration
  private alive = true
  private snapshot: RunSnapshot | null = null
  private connection: ConnectionStatus = 'connecting'
  private coherence: CommandView['coherence'] = 'awaiting_snapshot'
  private epoch = 0
  private initialized = false
  private readiness = 0
  private statusRevision = 0
  private gateRevision = 0
  private prRevision = 0
  private phaseRevision = 0
  private highWater = 0
  private gapFloor = 0
  private ackFloor = 0
  private invalidGeneration = 0
  private coveredInvalidGeneration = 0
  private quarantine = new Map<number, { event: Exclude<RunEvent, { type: 'snapshot' }>; bytes: number }>()
  private quarantineBytes = 0
  private discarded = false
  private tickets = new Map<number, Ticket>()
  private nextId = 0
  private latestCommand = 0
  private lastError: string | null = null
  private episode: Episode | null = null
  private manual: ManualRefresh | null = null
  private listeners = new Set<() => void>()
  private view: CommandView

  constructor(private readonly auth: number, private readonly transports: Transports, private readonly clock: Clock = defaultClock) {
    this.view = this.makeView()
  }
  getView = (): CommandView => this.view
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  isCurrentContext = (generation: number): boolean => this.alive && this.generation === generation
  private ready(): boolean { return this.alive && this.initialized && this.connection === 'live' && this.coherence === 'coherent' }
  private occupied(nextLane: string): boolean {
    return [...this.tickets.values()].some((ticket) => nextLane === 'global' || ticket.lane === 'global' || ticket.lane === nextLane)
  }
  private makeView(): CommandView {
    const available = this.ready()
    return {
      snapshot: this.snapshot, connection: this.connection, lastError: this.lastError,
      admission: Object.freeze({ [admissionBrand]: true as const, contextGeneration: this.generation, authVersion: this.auth, runId: this.snapshot?.run.id ?? null, readiness: this.readiness, statusRevision: this.statusRevision, gateRevision: this.gateRevision, prRevision: this.prRevision, phaseRevision: this.phaseRevision, status: this.snapshot?.run.status ?? null, gate: this.snapshot?.run.approvalGate ?? null }),
      pending: [...this.tickets.values()].map(({ id, label, lane, phase, deadline }) => ({ id, label, lane, phase, deadline })),
      coherence: this.coherence, mutationAvailable: available,
      availabilityReason: available ? null : this.coherence === 'needs_refresh' ? 'State needs refresh' : 'Waiting for current run state',
      globalAvailable: available && !this.occupied('global'), sendAvailable: available && !this.occupied('send'),
      interruptAvailable: Object.fromEntries(AGENTS.map((id) => [id, available && !this.occupied(`interrupt:${id}`)])) as Record<AgentId, boolean>,
      refreshPending: this.manual !== null,
      synchronization: this.episode ? { deadline: this.episode.deadline, reason: 'Waiting for current run state' } : null,
    }
  }
  private publish(): void { this.view = this.makeView(); this.listeners.forEach((listener) => listener()) }
  private setCoherence(value: CommandView['coherence']): void {
    if (value !== this.coherence) { this.coherence = value; this.readiness++ }
  }
  private replaceSnapshot(next: RunSnapshot): void {
    if (next.run.status !== this.snapshot?.run.status) this.statusRevision++
    if (next.run.approvalGate !== this.snapshot?.run.approvalGate) this.gateRevision++
    if (next.pipeline.pr !== this.snapshot?.pipeline.pr) this.prRevision++
    if (next.pipeline.phase !== this.snapshot?.pipeline.phase) this.phaseRevision++
    this.snapshot = next
  }
  private current(expected: AdmissionToken | undefined): boolean {
    return !!expected && expected[admissionBrand] === true && this.alive && expected.contextGeneration === this.generation && expected.authVersion === this.auth && expected.runId === (this.snapshot?.run.id ?? null)
  }
  private admissionError(command: Command, expected: AdmissionToken): string | null {
    if (!this.ready() || expected.readiness !== this.readiness) return 'Wait for the current run state.'
    const statusMatches = expected.statusRevision === this.statusRevision && expected.status === this.snapshot?.run.status
    const pipelineMatches = expected.prRevision === this.prRevision && expected.phaseRevision === this.phaseRevision
    const gateMatches = expected.gateRevision === this.gateRevision && expected.gate === this.snapshot?.run.approvalGate
    const statuses = { start: ['idle', 'done', 'failed'], pause: ['live'], resume: ['paused'], approve: ['needs_approval'] }
    if (command.kind in statuses) {
      if (!statusMatches || !statuses[command.kind as keyof typeof statuses].includes(expected.status ?? '')) return 'The run changed. Use its current control.'
      if (command.kind === 'approve' && !pipelineMatches) return 'The approval changed. Review its current state.'
    }
    if (command.kind === 'gate' && (!gateMatches || command.enabled !== !expected.gate)) return 'The gate changed. Use its current control.'
    if (command.kind === 'send' && command.body.trimStart().startsWith('/') && (!statusMatches || !pipelineMatches || !gateMatches)) return 'The run changed. Review the command before sending.'
    if (this.occupied(lane(command))) return 'Another command is pending.'
    return null
  }
  perform(command: Command, expected: AdmissionToken): Promise<CommandOutcome> {
    if (!expected) return Promise.resolve({ kind: 'blocked', reason: 'The view is no longer current.' })
    if (!this.current(expected)) return Promise.resolve({ kind: 'obsolete' })
    const reason = this.admissionError(command, expected)
    if (reason) return Promise.resolve({ kind: 'blocked', reason })
    const id = ++this.nextId
    const deadline = this.clock.now() + 15_000
    return new Promise((resolve) => {
      const ticket: Ticket = { id, label: label(command), lane: lane(command), phase: 'network', deadline, generation: this.generation, controller: new AbortController(), cancelTimer: () => {}, resolve, settled: false }
      this.tickets.set(id, ticket)
      this.latestCommand = id
      ticket.cancelTimer = this.clock.schedule(() => this.expireTicket(ticket), deadline - this.clock.now())
      this.publish()
      // Admission and registry insertion above happen before calling any transport.
      try {
        void this.transports.execute(command, ticket.controller.signal).then(
          (ack) => this.accept(ticket, ack),
          (error: unknown) => this.reject(ticket, error instanceof Error ? error.message : 'Command failed.'),
        )
      } catch (error) { this.reject(ticket, error instanceof Error ? error.message : 'Command failed.') }
    })
  }
  private validTicket(ticket: Ticket): boolean {
    return this.alive && this.generation === ticket.generation && this.tickets.get(ticket.id) === ticket
  }
  private settle(ticket: Ticket, outcome: CommandOutcome): void {
    if (!ticket.settled) { ticket.settled = true; ticket.resolve(outcome) }
  }
  private release(ticket: Ticket): void {
    if (this.tickets.get(ticket.id) !== ticket) return
    this.tickets.delete(ticket.id)
    ticket.cancelTimer()
    ticket.controller.abort()
  }
  private expireTicket(ticket: Ticket): void {
    if (!this.validTicket(ticket)) return
    if (this.episode) { this.expireEpisode(this.episode); return }
    this.reject(ticket, TIMEOUT, true)
  }
  private reject(ticket: Ticket, error: string, expired = false): void {
    if (!this.validTicket(ticket)) return
    if (!expired && this.clock.now() >= ticket.deadline) { this.expireTicket(ticket); return }
    if (ticket.id === this.latestCommand) this.lastError = error.slice(0, 240)
    this.settle(ticket, { kind: 'rejected', error: error.slice(0, 240) })
    this.release(ticket)
    this.publish()
  }
  private accept(ticket: Ticket, ack: CommandResult): void {
    if (!this.validTicket(ticket)) return
    if (this.clock.now() >= ticket.deadline) { this.expireTicket(ticket); return }
    if (!ack || ack.ok !== true || !isSequence(ack.seq)) { this.reject(ticket, 'The run server returned an invalid command response.'); return }
    if (ticket.id === this.latestCommand) this.lastError = null
    this.ackFloor = Math.max(this.ackFloor, ack.seq)
    ticket.seq = ack.seq
    if (!this.ready() || !this.snapshot || this.snapshot.seq < ack.seq) {
      ticket.phase = 'synchronizing'
      this.beginEpisode(true, ticket.deadline)
    } else this.release(ticket)
    this.settle(ticket, { kind: 'accepted', attemptId: ticket.id, contextGeneration: ticket.generation, seq: ack.seq })
    this.publish()
  }
  private beginEpisode(read: boolean, commandDeadline?: number): void {
    if (this.coherence === 'needs_refresh') return
    const deadline = Math.min(this.episode?.deadline ?? this.clock.now() + 15_000, commandDeadline ?? Infinity, ...[...this.tickets.values()].map((t) => t.deadline))
    if (!this.episode) this.episode = { id: ++this.nextId, generation: this.generation, deadline, cancelTimer: () => {}, readStarted: false, read: null }
    const episode = this.episode
    episode.deadline = deadline
    episode.cancelTimer()
    episode.cancelTimer = this.clock.schedule(() => this.expireEpisode(episode), Math.max(0, deadline - this.clock.now()))
    this.setCoherence(this.snapshot ? 'repairing' : 'awaiting_snapshot')
    if (read && !episode.readStarted) {
      episode.readStarted = true
      const request = { id: ++this.nextId, epoch: this.epoch, invalidGeneration: this.invalidGeneration, controller: new AbortController() }
      episode.read = request
      try {
        void this.transports.fetchState(request.controller.signal).then((value) => {
          if (!this.alive || this.episode !== episode || episode.read !== request || episode.generation !== this.generation || request.epoch !== this.epoch) return
          if (this.clock.now() >= episode.deadline) { this.expireEpisode(episode); return }
          const full = validateSnapshot(value)
          if (full && request.invalidGeneration === this.invalidGeneration) this.admitSnapshot(full, false, request.invalidGeneration)
          this.publish()
        }, () => {
          // Stream proof may still heal this episode before the unchanged deadline.
        })
      } catch { /* A synchronous read failure has the same bounded stream fallback. */ }
    }
  }
  private closeEpisode(): void {
    const episode = this.episode
    this.episode = null
    episode?.cancelTimer()
    episode?.read?.controller.abort()
  }
  private expireEpisode(episode: Episode): void {
    if (this.episode !== episode || !this.alive) return
    this.closeEpisode()
    for (const ticket of this.tickets.values()) {
      if (!ticket.settled) {
        if (ticket.id === this.latestCommand) this.lastError = TIMEOUT
        this.settle(ticket, { kind: 'rejected', error: TIMEOUT })
      }
      this.release(ticket)
    }
    this.discardBuffer()
    this.setCoherence('needs_refresh')
    this.publish()
  }
  private discardBuffer(): void {
    this.gapFloor = Math.max(this.gapFloor, this.highWater)
    this.quarantine.clear(); this.quarantineBytes = 0; this.discarded = true
  }
  streamStarted(epoch: number): void {
    if (!this.alive || epoch <= this.epoch) return
    this.epoch = epoch
    this.initialized = false
    this.connection = this.snapshot ? 'reconnecting' : 'connecting'
    this.readiness++
    if (this.manual) this.manual.epoch = epoch
    this.episode?.read?.controller.abort()
    if (this.episode) this.episode.read = null
    if (!this.manual) this.beginEpisode(false)
    this.publish()
  }
  streamOpened(epoch: number): void {
    if (!this.alive || epoch !== this.epoch) return
    this.connection = 'live'
    this.maybeHeal()
    this.publish()
  }
  streamError(epoch: number): void {
    if (!this.alive || epoch !== this.epoch) return
    this.connection = 'reconnecting'
    this.initialized = false
    this.readiness++
    if (this.manual) this.finishManual('unavailable')
    else this.beginEpisode(false)
    this.publish()
  }
  ingest(value: unknown, epoch: number, rawBytes?: number): void {
    if (!this.alive || epoch !== this.epoch) return
    if (this.manual && this.clock.now() >= this.manual.deadline) { this.finishManual('unavailable'); return }
    if (this.episode && this.clock.now() >= this.episode.deadline) this.expireEpisode(this.episode)
    const event = validateEvent(value)
    if (!event) {
      if (typeof value === 'object' && value !== null && 'seq' in value && isSequence(value.seq)) {
        this.highWater = Math.max(this.highWater, value.seq)
        this.gapFloor = Math.max(this.gapFloor, value.seq)
      }
      this.invalidGeneration++
      this.beginEpisode(true)
      this.publish()
      return
    }
    if (event.type === 'snapshot') {
      this.admitSnapshot(event.snapshot, true, this.invalidGeneration)
      this.publish()
      return
    }
    this.highWater = Math.max(this.highWater, event.seq)
    if (this.initialized && this.snapshot && !this.gapFloor && this.invalidGeneration === this.coveredInvalidGeneration && this.coherence !== 'needs_refresh') {
      if (event.seq <= this.snapshot.seq) return
      if (event.seq === this.snapshot.seq + 1) {
        const next = apply(this.snapshot, event)
        if (next) { this.replaceSnapshot(next); this.maybeHeal(); this.publish(); return }
      }
    }
    this.gapFloor = Math.max(this.gapFloor, !this.gapFloor ? event.seq : 0)
    const bytes = rawBytes ?? new TextEncoder().encode(JSON.stringify(event)).byteLength
    if (this.discarded || this.coherence === 'needs_refresh') this.gapFloor = Math.max(this.gapFloor, this.highWater)
    else if (!this.quarantine.has(event.seq)) {
      if (this.quarantine.size >= 256 || this.quarantineBytes + bytes > 1_048_576) this.discardBuffer()
      else { this.quarantine.set(event.seq, { event, bytes }); this.quarantineBytes += bytes }
    }
    this.beginEpisode(true)
    this.publish()
  }
  private admitSnapshot(full: RunSnapshot, fromStream: boolean, invalidGeneration: number): void {
    const newRun = this.snapshot !== null && full.run.id !== this.snapshot.run.id
    const firstOnStream = fromStream && !this.initialized
    if (this.snapshot && full.seq < this.snapshot.seq && !(newRun && firstOnStream)) return
    if (newRun && !firstOnStream && full.seq === this.snapshot!.seq) return
    if (newRun) this.replaceContext()
    if (full.seq < Math.max(this.gapFloor, this.ackFloor, firstOnStream && !newRun ? this.snapshot?.seq ?? 0 : 0)) return
    if (invalidGeneration < this.invalidGeneration) return
    this.replaceSnapshot(full)
    this.highWater = Math.max(this.highWater, full.seq)
    this.coveredInvalidGeneration = invalidGeneration
    this.gapFloor = 0
    this.discarded = false
    if (fromStream) this.initialized = true
    for (const [sequence, buffered] of [...this.quarantine].sort(([a], [b]) => a - b)) {
      if (sequence > this.snapshot!.seq) {
        if (sequence !== this.snapshot!.seq + 1) { this.gapFloor = sequence; break }
        const next = apply(this.snapshot!, buffered.event)
        if (!next) { this.gapFloor = sequence; break }
        this.replaceSnapshot(next)
      }
      this.quarantine.delete(sequence); this.quarantineBytes -= buffered.bytes
    }
    this.maybeHeal()
  }
  private maybeHeal(): void {
    if (!this.initialized || this.connection !== 'live' || !this.snapshot || this.gapFloor || this.invalidGeneration !== this.coveredInvalidGeneration || this.snapshot.seq < Math.max(this.ackFloor, this.highWater)) return
    this.closeEpisode()
    this.setCoherence('coherent')
    for (const ticket of this.tickets.values()) if (ticket.phase === 'synchronizing' && ticket.seq! <= this.snapshot.seq) this.release(ticket)
    if (this.manual) this.finishManual('refreshed')
  }
  private replaceContext(): void {
    this.generation = ++nextGeneration
    this.readiness++
    for (const ticket of this.tickets.values()) { this.settle(ticket, { kind: 'obsolete' }); this.release(ticket) }
    this.closeEpisode()
    this.lastError = null
    this.latestCommand = 0
    this.highWater = 0; this.ackFloor = 0; this.gapFloor = 0
    this.quarantine.clear(); this.quarantineBytes = 0; this.discarded = false
    this.coveredInvalidGeneration = this.invalidGeneration
  }
  refreshState(expected: AdmissionToken): Promise<RefreshOutcome> {
    if (!this.current(expected)) return Promise.resolve('obsolete')
    if (expected.readiness !== this.readiness || this.manual || this.coherence !== 'needs_refresh') return Promise.resolve('unavailable')
    this.closeEpisode()
    return new Promise((resolve) => {
      const attempt: ManualRefresh = { id: ++this.nextId, generation: this.generation, epoch: null, deadline: this.clock.now() + 15_000, controller: new AbortController(), cancelTimer: () => {}, resolve }
      this.manual = attempt
      this.readiness++
      attempt.cancelTimer = this.clock.schedule(() => { if (this.manual === attempt) this.finishManual('unavailable') }, 15_000)
      this.publish()
      try { this.transports.refresh(attempt.controller.signal) } catch { this.finishManual('unavailable') }
    })
  }
  private finishManual(outcome: RefreshOutcome): void {
    const manual = this.manual
    if (!manual) return
    this.manual = null
    manual.cancelTimer()
    // Successful refresh owns the new continuing stream. Only unsuccessful attempts close it.
    if (outcome !== 'refreshed') {
      manual.controller.abort()
      this.epoch++ // Fence callbacks from the source just closed by the manual attempt.
      this.initialized = false
      this.connection = 'reconnecting'
      this.setCoherence('needs_refresh')
    }
    manual.resolve(outcome)
    this.publish()
  }
  dispose(): void {
    if (!this.alive) return
    this.alive = false
    this.replaceContext()
    this.finishManual('obsolete')
    this.snapshot = null
    this.publish()
  }
  /** Bounded diagnostics used by deterministic acceptance tests, never presented as server proof. */
  diagnostics() {
    return { appliedSeq: this.snapshot?.seq ?? null, observedHighWater: this.highWater, bufferedEvents: this.quarantine.size, bufferedBytes: this.quarantineBytes, gapFloor: this.gapFloor, ackFloor: this.ackFloor, epoch: this.epoch }
  }
}

/** Edits update this owner synchronously, including edit-and-revert and target-only changes. */
export class DraftBuffer {
  private value = { raw: '', target: 'all' as MessageTarget, editVersion: 0 }
  read() { return this.value }
  edit(raw: string, target: MessageTarget = this.value.target) {
    this.value = { raw, target, editVersion: this.value.editVersion + 1 }
    return this.value
  }
  clearAccepted(capture: ReturnType<DraftBuffer['read']>, outcome: CommandOutcome, isCurrent: (generation: number) => boolean): boolean {
    if (outcome.kind !== 'accepted' || !isCurrent(outcome.contextGeneration) || capture.editVersion !== this.value.editVersion || capture.raw !== this.value.raw || capture.target !== this.value.target) return false
    this.edit('')
    return true
  }
}
