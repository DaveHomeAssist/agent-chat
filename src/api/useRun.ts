import { useEffect, useMemo, useState } from 'react'
import type { AgentId, MessageTarget } from '@shared/protocol'
import { authVersion, subscribeAuthLoss } from './auth'
import { approveMerge, connectEvents, fetchState, interruptAgent, pauseRun, resumeRun, sendMessage, setGate, startRun } from './client'
import { CommandController, type AdmissionToken, type Command, type CommandOutcome, type CommandView, type RefreshOutcome } from './commandState'

export interface RunActions {
  send(body: string, target: MessageTarget, expected: AdmissionToken): Promise<CommandOutcome>
  start(expected: AdmissionToken): Promise<CommandOutcome>
  pause(expected: AdmissionToken): Promise<CommandOutcome>
  resume(expected: AdmissionToken): Promise<CommandOutcome>
  setGate(enabled: boolean, expected: AdmissionToken): Promise<CommandOutcome>
  approve(expected: AdmissionToken): Promise<CommandOutcome>
  interrupt(id: AgentId, expected: AdmissionToken): Promise<CommandOutcome>
  refreshState(expected: AdmissionToken): Promise<RefreshOutcome>
}
export interface RunState extends CommandView {
  actions: RunActions
  isCurrentContext(generation: number): boolean
}
function execute(command: Command, signal: AbortSignal) {
  switch (command.kind) {
    case 'send': return sendMessage(command.body, command.target, signal)
    case 'start': return startRun(signal)
    case 'pause': return pauseRun(signal)
    case 'resume': return resumeRun(signal)
    case 'approve': return approveMerge(signal)
    case 'gate': return setGate(command.enabled, signal)
    case 'interrupt': return interruptAgent(command.id, signal)
  }
}

export function useRun(): RunState {
  // Each effect setup owns a different controller, including StrictMode's setup/cleanup/setup.
  const [{ owner, view }, setState] = useState(() => {
    const owner = new CommandController(authVersion(), { execute, fetchState, refresh: () => {} })
    return { owner, view: owner.getView() }
  })
  useEffect(() => {
    let stream: ReturnType<typeof connectEvents> | undefined
    const controller = new CommandController(authVersion(), { execute, fetchState, refresh: (signal) => stream?.refresh(signal) })
    const unsubscribe = controller.subscribe(() => setState({ owner: controller, view: controller.getView() }))
    const unsubscribeAuth = subscribeAuthLoss(() => controller.dispose())
    setState({ owner: controller, view: controller.getView() })
    stream = connectEvents({
      started: (epoch) => controller.streamStarted(epoch),
      opened: (epoch) => controller.streamOpened(epoch),
      error: (epoch) => controller.streamError(epoch),
      event: (event, epoch, bytes) => { controller.ingest(event, epoch, bytes); return controller.getView().mutationAvailable },
    })
    return () => { unsubscribe(); unsubscribeAuth(); controller.dispose(); stream?.close() }
  }, [])
  const actions = useMemo<RunActions>(() => ({
    send: (body, target, expected) => owner.perform({ kind: 'send', body, target }, expected),
    start: (expected) => owner.perform({ kind: 'start' }, expected),
    pause: (expected) => owner.perform({ kind: 'pause' }, expected),
    resume: (expected) => owner.perform({ kind: 'resume' }, expected),
    approve: (expected) => owner.perform({ kind: 'approve' }, expected),
    setGate: (enabled, expected) => owner.perform({ kind: 'gate', enabled }, expected),
    interrupt: (id, expected) => owner.perform({ kind: 'interrupt', id }, expected),
    refreshState: (expected) => owner.refreshState(expected),
  }), [owner])
  return { ...view, actions, isCurrentContext: owner.isCurrentContext }
}
