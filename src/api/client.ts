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

/** Delay before re-opening a stream the browser gave up on (non-2xx response). */
const RETRY_MS = 2000

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init)
  } catch {
    throw new Error('run server unreachable')
  }
}

async function post(path: string, body?: unknown): Promise<CommandResult> {
  const res = await request(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as CommandResponse | null
  if (data && data.ok === false) throw new Error(data.error)
  if (!res.ok || !data) throw new Error(`${res.status} ${res.statusText || 'request failed'}`)
  return data
}

export async function fetchState(): Promise<RunSnapshot> {
  const res = await request(API.state)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'request failed'}`)
  return (await res.json()) as RunSnapshot
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
 * Subscribe to the SSE feed. The browser reconnects on its own after a dropped
 * connection; a stream the browser closes for good (e.g. a 5xx while the server
 * restarts) is re-opened here. Every (re)connection starts with a snapshot.
 */
export function connectEvents(
  onEvent: (e: RunEvent) => void,
  onStatus: (s: ConnectionStatus) => void,
): () => void {
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let first = true

  const open = () => {
    onStatus(first ? 'connecting' : 'reconnecting')
    first = false
    const es = new EventSource(API.events)
    source = es

    es.onopen = () => onStatus('live')
    es.onerror = () => {
      if (closed) return
      onStatus('reconnecting')
      if (es.readyState === EventSource.CLOSED) {
        es.close()
        retry = setTimeout(open, RETRY_MS)
      }
    }
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev) => {
        const event = parseEvent((ev as MessageEvent).data)
        if (event) onEvent(event)
      })
    }
  }

  open()

  return () => {
    closed = true
    if (retry) clearTimeout(retry)
    source?.close()
  }
}
