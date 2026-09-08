import {
  API,
  type AgentId,
  type CommandResult,
  type MessageTarget,
  type RunEventType,
  type RunSnapshot,
  type SendMessageRequest,
  type SetGateRequest,
} from '@shared/protocol'
import {
  AuthRequiredError,
  authVersion,
  ensureAuthVersion,
  getAuthStatus,
  notifyAuthLoss,
  subscribeAuthLoss,
} from './auth'

import { parseJson, validateAcknowledgement, validateEvent, validateSnapshot, type ParsedJson } from './runValidation'
export type { ConnectionStatus } from './commandState'

const EVENT_TYPES: readonly RunEventType[] = [
  'snapshot',
  'run',
  'stats',
  'agent',
  'agent.log',
  'agent.tool',
  'thread.append',
  'thread.patch',
  'pipeline',
  'typing',
]

/** Probe before reconnecting, with a capped backoff during network outages. */
const RETRY_MS = 2000
const MAX_RETRY_MS = 30_000

async function request(path: string, init?: RequestInit): Promise<{ response: Response; parsed: ParsedJson }> {
  const expected = authVersion()
  const controller = new AbortController()
  const abort = () => controller.abort()
  const unsubscribe = subscribeAuthLoss(abort)
  init?.signal?.addEventListener('abort', abort, { once: true })
  if (init?.signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, 15_000)
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      redirect: 'error',
    })
    ensureAuthVersion(expected)
    if (response.status === 401) {
      notifyAuthLoss('required', expected)
      throw new AuthRequiredError()
    }
    const parsed = parseJson(await response.text())
    ensureAuthVersion(expected)
    if (controller.signal.aborted) throw new Error('Request cancelled or timed out. Try again.')
    return { response, parsed }
  } catch (error) {
    ensureAuthVersion(expected)
    if (error instanceof AuthRequiredError) throw error
    if (controller.signal.aborted) throw new Error('Request cancelled or timed out. Try again.')
    throw new Error('run server unreachable')
  } finally {
    clearTimeout(timeout)
    unsubscribe()
    init?.signal?.removeEventListener('abort', abort)
  }
}

async function post(path: string, body?: unknown, signal?: AbortSignal): Promise<CommandResult> {
  const { response, parsed } = await request(path, {
    method: 'POST', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return validateAcknowledgement(response.ok, parsed, `${response.status} ${response.statusText || 'request failed'}`)
}

export async function fetchState(signal?: AbortSignal): Promise<RunSnapshot> {
  const { response, parsed } = await request(API.state, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'request failed'}`)
  const snapshot = parsed.parsed ? validateSnapshot(parsed.value) : null
  if (!snapshot) throw new Error('The run server returned an invalid snapshot.')
  return snapshot
}

export function sendMessage(body: string, target: MessageTarget, signal?: AbortSignal): Promise<CommandResult> {
  const req: SendMessageRequest = { body, target }
  return post(API.message, req, signal)
}
export function startRun(signal?: AbortSignal): Promise<CommandResult> { return post(API.start, undefined, signal) }
export function pauseRun(signal?: AbortSignal): Promise<CommandResult> { return post(API.pause, undefined, signal) }
export function resumeRun(signal?: AbortSignal): Promise<CommandResult> { return post(API.resume, undefined, signal) }
export function setGate(enabled: boolean, signal?: AbortSignal): Promise<CommandResult> {
  const req: SetGateRequest = { enabled }
  return post(API.gate, req, signal)
}
export function approveMerge(signal?: AbortSignal): Promise<CommandResult> { return post(API.approve, undefined, signal) }
export function interruptAgent(id: AgentId, signal?: AbortSignal): Promise<CommandResult> { return post(API.interrupt(id), undefined, signal) }

export interface StreamCallbacks {
  started(epoch: number): void
  opened(epoch: number): void
  error(epoch: number): void
  event(value: unknown, epoch: number, rawBytes: number): boolean
}

/**
 * Close failed streams to prevent EventSource's implicit unauthenticated retries.
 * Only a successful auth probe permits a reconnect and its fresh snapshot.
 */
export function connectEvents(callbacks: StreamCallbacks): { close(): void; refresh(signal: AbortSignal): void } {
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let failures = 0
  let epoch = 0
  let probe: AbortController | null = null
  let releaseManualSignal: (() => void) | null = null
  const expected = authVersion()

  const cancelCurrent = () => {
    if (retry) clearTimeout(retry)
    retry = null
    probe?.abort(); probe = null
    source?.close(); source = null
    releaseManualSignal?.(); releaseManualSignal = null
  }
  const close = () => { closed = true; cancelCurrent() }
  const unsubscribe = subscribeAuthLoss(close)
  const current = (id: number) => !closed && epoch === id && authVersion() === expected

  const scheduleProbe = () => {
    if (closed) return
    const delay = Math.min(RETRY_MS * 2 ** Math.min(Math.max(failures - 1, 0), 4), MAX_RETRY_MS)
    retry = setTimeout(() => { begin(false) }, delay)
  }
  const failed = (id: number, manual: boolean) => {
    if (!current(id)) return
    source?.close(); source = null
    callbacks.error(id)
    if (!manual) { failures++; scheduleProbe() }
  }
  const open = (id: number, manual: boolean) => {
    if (!current(id)) return
    const es = new EventSource(API.events)
    source = es
    let receivedInitial = false
    es.onopen = () => {
      if (!current(id) || source !== es) return
      failures = 0
      callbacks.opened(id)
    }
    es.onerror = () => {
      if (!current(id) || source !== es) return
      failed(id, manual && !receivedInitial)
    }
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        if (!current(id) || source !== es) return
        const raw: unknown = (ev as MessageEvent).data
        const parsed = typeof raw === 'string' ? parseJson(raw) : { parsed: false as const }
        const event = parsed.parsed ? validateEvent(parsed.value) : null
        // The named SSE type must agree with the JSON envelope. Bad frames are explicit failures.
        const value = parsed.parsed ? parsed.value : null
        const frame = typeof value === 'object' && value !== null && 'type' in value && value.type === type
          ? value : typeof value === 'object' && value !== null && 'seq' in value ? { seq: value.seq } : null
        const admitted = callbacks.event(frame, id, typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : 0)
        if (event?.type === 'snapshot' && admitted) {
          receivedInitial = true
          releaseManualSignal?.(); releaseManualSignal = null
        }
      })
    }
  }
  const begin = (manual: boolean, signal?: AbortSignal, initial = false) => {
    if (closed || signal?.aborted) return
    cancelCurrent()
    const id = ++epoch // Reserve synchronously, before the probe or any source callback.
    callbacks.started(id)
    if (signal) {
      const abort = () => { if (epoch === id) { cancelCurrent(); epoch++ } }
      signal.addEventListener('abort', abort, { once: true })
      releaseManualSignal = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) { abort(); return }
    }
    if (initial) { open(id, false); return }
    const controller = new AbortController()
    probe = controller
    void getAuthStatus(controller.signal).then((status) => {
      if (!current(id) || controller.signal.aborted) return
      if (!status.authenticated) { notifyAuthLoss('required', expected); return }
      open(id, manual)
    }, (error: unknown) => {
      if (!current(id) || controller.signal.aborted) return
      if (error instanceof AuthRequiredError) { notifyAuthLoss('required', expected); return }
      failed(id, manual)
    }).finally(() => { if (probe === controller) probe = null })
  }
  begin(false, undefined, true)
  return { close: () => { close(); unsubscribe() }, refresh: (signal) => begin(true, signal) }
}
