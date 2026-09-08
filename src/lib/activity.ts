import type { Agent, AgentId, RunInfo } from '../../shared/protocol.js'

export type ActivityConnection = 'connecting' | 'live' | 'reconnecting'
export type AgentActivityTone = 'idle' | 'active' | 'paused' | 'blocked' | 'failed' | 'complete' | 'disconnected'

export interface AgentActivity {
  label: string
  tone: AgentActivityTone
  /** True only while a model call or tool operation is actually in flight. */
  operationActive: boolean
}

function activity(label: string, tone: AgentActivityTone, operationActive = false): AgentActivity {
  return { label, tone, operationActive }
}

function boundedLabel(value: string | undefined, fallback: string, max = 48): string {
  const clean = value?.replace(/\s+/g, ' ').trim() || fallback
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function latestRunningTool(agent: Agent): Agent['tools'][number] | undefined {
  for (let index = agent.tools.length - 1; index >= 0; index -= 1) {
    if (agent.tools[index].status === 'running') return agent.tools[index]
  }
  return undefined
}

export function deriveAgentActivity(
  connection: ActivityConnection,
  run: RunInfo | null,
  agent: Agent | null,
  typing: readonly AgentId[],
): AgentActivity {
  if (connection === 'connecting') return activity('Connecting', 'disconnected')
  if (connection === 'reconnecting') return activity('Disconnected · reconnecting', 'disconnected')
  if (!run || run.status === 'idle') return activity('Idle', 'idle')
  if (run.status === 'failed') {
    return activity(`Failed · ${boundedLabel(run.error, 'unknown error')}`, 'failed')
  }
  if (run.status === 'done') return activity('Completed', 'complete')
  if (!agent) return activity('Idle', 'idle')

  const runningTool = latestRunningTool(agent)
  const modelActive = typing.includes(agent.id)
  if (run.status === 'paused') {
    return runningTool || modelActive
      ? activity('Pausing · current operation finishing', 'paused', true)
      : activity('Paused', 'paused')
  }
  if (agent.status === 'blocked') return activity('Blocked', 'blocked')
  if (runningTool) {
    return activity(`Working · ${boundedLabel(runningTool.name, 'tool')}`, 'active', true)
  }
  if (modelActive) return activity('Model call active', 'active', true)
  if (agent.status === 'working') return activity('Working', 'active')
  if (agent.status === 'thinking') return activity('Thinking', 'active')
  if (agent.pct === 100 && agent.eta.trim().toLowerCase() === 'done') {
    return activity('Completed', 'complete')
  }
  if (agent.status === 'idle' && agent.queueCount > 0) {
    const noun = agent.queueCount === 1 ? 'follow-up' : 'follow-ups'
    return activity(`Idle · ${agent.queueCount} ${noun} queued`, 'idle')
  }
  if (run.status === 'needs_approval') return activity('Idle · run awaiting approval', 'idle')
  return activity('Idle', 'idle')
}

export function shouldAnimateAgentActivity(value: AgentActivity, motionEnabled: boolean): boolean {
  return motionEnabled && value.operationActive
}
