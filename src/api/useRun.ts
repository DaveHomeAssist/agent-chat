import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import type {
  Agent,
  AgentId,
  CommandResult,
  MessageTarget,
  RunEvent,
  RunSnapshot,
  ThreadItem,
} from '@shared/protocol'
import {
  approveMerge,
  connectEvents,
  interruptAgent,
  pauseRun,
  resumeRun,
  sendMessage,
  setGate as postGate,
  startRun,
  type ConnectionStatus,
} from './client'

/** Output-log lines kept per agent; the server's history is the source of truth. */
const LOG_CAP = 200

export interface RunActions {
  send(body: string, target: MessageTarget): Promise<boolean>
  start(): Promise<boolean>
  pause(): Promise<boolean>
  resume(): Promise<boolean>
  setGate(enabled: boolean): Promise<boolean>
  approve(): Promise<boolean>
  interrupt(id: AgentId): Promise<boolean>
}

export interface RunState {
  snapshot: RunSnapshot | null
  connection: ConnectionStatus
  /** The last failed command's message; cleared by the next success. */
  lastError: string | null
  actions: RunActions
}

function patchAgent(
  agents: Agent[],
  id: AgentId,
  fn: (a: Agent) => Agent,
): Agent[] {
  return agents.map((a) => (a.id === id ? fn(a) : a))
}

function apply(s: RunSnapshot, e: RunEvent): RunSnapshot {
  switch (e.type) {
    case 'snapshot':
      return e.snapshot
    case 'run':
      return { ...s, seq: e.seq, run: { ...s.run, ...e.run } }
    case 'stats':
      return { ...s, seq: e.seq, stats: e.stats }
    case 'agent':
      return { ...s, seq: e.seq, agents: patchAgent(s.agents, e.id, (a) => ({ ...a, ...e.patch })) }
    case 'agent.log':
      return {
        ...s,
        seq: e.seq,
        agents: patchAgent(s.agents, e.id, (a) => ({ ...a, log: [...a.log, e.line].slice(-LOG_CAP) })),
      }
    case 'agent.tool':
      return {
        ...s,
        seq: e.seq,
        agents: patchAgent(s.agents, e.id, (a) => {
          const i = a.tools.findIndex((t) => t.id === e.call.id)
          const tools = i === -1 ? [...a.tools, e.call] : a.tools.map((t, j) => (j === i ? e.call : t))
          return { ...a, tools }
        }),
      }
    case 'thread.append':
      return { ...s, seq: e.seq, thread: [...s.thread, e.item] }
    case 'thread.patch':
      return {
        ...s,
        seq: e.seq,
        thread: s.thread.map((t) => (t.id === e.id ? ({ ...t, ...e.patch } as ThreadItem) : t)),
      }
    case 'pipeline':
      return { ...s, seq: e.seq, pipeline: e.pipeline }
    case 'typing':
      return { ...s, seq: e.seq, typing: e.typing }
  }
}

function reduce(s: RunSnapshot | null, e: RunEvent): RunSnapshot | null {
  if (e.type === 'snapshot') return e.snapshot
  // Nothing to merge into before the first snapshot; stale or replayed events are dropped.
  if (!s || e.seq <= s.seq) return s
  return apply(s, e)
}

export function useRun(): RunState {
  const [snapshot, dispatch] = useReducer(reduce, null)
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => connectEvents(dispatch, setConnection), [])

  const run = useCallback(async (command: () => Promise<CommandResult>): Promise<boolean> => {
    try {
      await command()
      setLastError(null)
      return true
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err))
      return false
    }
  }, [])

  const actions = useMemo<RunActions>(
    () => ({
      send: (body, target) => run(() => sendMessage(body, target)),
      start: () => run(startRun),
      pause: () => run(pauseRun),
      resume: () => run(resumeRun),
      setGate: (enabled) => run(() => postGate(enabled)),
      approve: () => run(approveMerge),
      interrupt: (id) => run(() => interruptAgent(id)),
    }),
    [run],
  )

  return { snapshot, connection, lastError, actions }
}
