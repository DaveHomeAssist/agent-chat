import {
  API,
  type AgentId,
  type CommandResponse,
  type CommandResult,
  type MessageTarget,
  type RunEvent,
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

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting'

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

async function request(path: string, init?: RequestInit): Promise<{ response: Response; data: unknown }> {
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
    const data: unknown = await response.json().catch(() => null)
    ensureAuthVersion(expected)
    if (controller.signal.aborted) throw new Error('Request cancelled or timed out. Try again.')
    return { response, data }
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

async function post(path: string, body?: unknown): Promise<CommandResult> {
  const { response: res, data: value } = await request(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = value as CommandResponse | null
  if (data && data.ok === false) throw new Error(data.error)
  if (!res.ok || !data) throw new Error(`${res.status} ${res.statusText || 'request failed'}`)
  return data
}

export async function fetchState(signal?: AbortSignal): Promise<RunSnapshot> {
  const { response: res, data } = await request(API.state, { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'request failed'}`)
  if (!data) throw new Error('The run server returned an invalid snapshot.')
  return data as RunSnapshot
}

export function sendMessage(body: string, target: MessageTarget): Promise<CommandResult> {
  const req: SendMessageRequest = { body, target }
  return post(API.message, req)
}

export function startRun(): Promise<CommandResult> {
  return post(API.start)
}

export function pauseRun(): Promise<CommandResult> {
  return post(API.pause)
}

export function resumeRun(): Promise<CommandResult> {
  return post(API.resume)
}

export function setGate(enabled: boolean): Promise<CommandResult> {
  const req: SetGateRequest = { enabled }
  return post(API.gate, req)
}

export function approveMerge(): Promise<CommandResult> {
  return post(API.approve)
}

export function interruptAgent(id: AgentId): Promise<CommandResult> {
  return post(API.interrupt(id))
}

function parseEvent(raw: unknown): RunEvent | null {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as RunEvent
  } catch {
    return null
  }
}

/**
 * Close failed streams to prevent EventSource's implicit unauthenticated retries.
 * Only a successful auth probe permits a reconnect and its fresh snapshot.
 */
export function connectEvents(
  onEvent: (e: RunEvent) => void,
  onStatus: (s: ConnectionStatus) => void,
): () => void {
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let first = true
  let failures = 0
  let probe: AbortController | null = null
  const expected = authVersion()

  const close = () => {
    closed = true
    if (retry) clearTimeout(retry)
    probe?.abort()
    source?.close()
  }
  const unsubscribe = subscribeAuthLoss(close)

  const scheduleProbe = () => {
    if (closed) return
    const delay = Math.min(RETRY_MS * 2 ** Math.min(Math.max(failures - 1, 0), 4), MAX_RETRY_MS)
    retry = setTimeout(() => { void checkAndOpen() }, delay)
  }

  const checkAndOpen = async () => {
    if (closed) return
    const controller = new AbortController()
    probe = controller
    try {
      const status = await getAuthStatus(controller.signal)
      if (closed || controller.signal.aborted) return
      ensureAuthVersion(expected)
      if (!status.authenticated) {
        notifyAuthLoss('required', expected)
        return
      }
      open()
    } catch (error) {
      if (closed || controller.signal.aborted) return
      if (error instanceof AuthRequiredError) {
        notifyAuthLoss('required', expected)
        return
      }
      failures += 1
      scheduleProbe()
    } finally {
      if (probe === controller) probe = null
    }
  }

  const open = () => {
    if (closed || authVersion() !== expected) return
    onStatus(first ? 'connecting' : 'reconnecting')
    first = false
    const es = new EventSource(API.events)
    source = es

    es.onopen = () => {
      if (closed || source !== es) return
      failures = 0
      onStatus('live')
    }
    es.onerror = () => {
      if (closed || source !== es) return
      es.close()
      source = null
      onStatus('reconnecting')
      failures += 1
      scheduleProbe()
    }
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        if (closed || source !== es || authVersion() !== expected) return
        const event = parseEvent((ev as MessageEvent).data)
        if (event) onEvent(event)
      })
    }
  }

  open()

  return () => {
    close()
    unsubscribe()
  }
}
