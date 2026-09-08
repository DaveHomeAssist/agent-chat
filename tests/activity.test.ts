import assert from 'node:assert/strict'
import test from 'node:test'
import { quickCommands } from '../src/constants.js'
import { deriveAgentActivity, shouldAnimateAgentActivity } from '../src/lib/activity.js'
import type { Agent, AgentStatus, RunInfo, RunStatus, ToolCall } from '../shared/protocol.js'

const run = (status: RunStatus = 'live', error?: string): RunInfo => ({
  id: 'run-activity',
  label: 'RUN ACTIVITY',
  status,
  approvalGate: true,
  channel: '#activity',
  repo: 'helios/api',
  branch: 'feat/activity',
  goal: 'Verify truthful activity',
  startedAt: '09:00',
  toolServers: 3,
  llm: 'mock',
  ...(error ? { error } : {}),
})

const agent = (options: {
  status?: AgentStatus
  pct?: number
  eta?: string
  queueCount?: number
  tools?: ToolCall[]
} = {}): Agent => ({
  id: 'forge',
  name: 'Forge',
  initials: 'FG',
  role: 'Builder',
  model: 'mock',
  color: '#4c8cff',
  status: options.status ?? 'idle',
  pct: options.pct ?? 0,
  subtask: 'activity fixture',
  subtaskTitle: 'Activity fixture',
  eta: options.eta ?? '—',
  io: [],
  queueCount: options.queueCount ?? 0,
  queue: [],
  log: [],
  tools: options.tools ?? [],
})

const runningTool: ToolCall = {
  id: 'tool-running',
  name: 'repo.patch',
  arg: 'fixture',
  dur: '—',
  status: 'running',
}

test('connection and terminal run states override stale agent activity', () => {
  const stale = agent({ status: 'working', tools: [runningTool] })
  assert.deepEqual(deriveAgentActivity('connecting', run('failed', 'late failure'), stale, ['forge']), {
    label: 'Connecting', tone: 'disconnected', operationActive: false,
  })
  assert.equal(deriveAgentActivity('reconnecting', run(), stale, ['forge']).label, 'Disconnected · reconnecting')
  assert.equal(deriveAgentActivity('live', null, null, []).label, 'Idle')
  assert.equal(deriveAgentActivity('live', run('idle'), stale, ['forge']).label, 'Idle')
  assert.equal(deriveAgentActivity('live', run('failed', 'provider stopped'), stale, ['forge']).label, 'Failed · provider stopped')
  assert.equal(deriveAgentActivity('live', run('done'), stale, ['forge']).label, 'Completed')
})

test('paused state distinguishes an active operation from a settled pause', () => {
  const model = deriveAgentActivity('live', run('paused'), agent({ status: 'thinking' }), ['forge'])
  const tool = deriveAgentActivity('live', run('paused'), agent({ tools: [runningTool] }), [])
  const settled = deriveAgentActivity('live', run('paused'), agent(), [])
  assert.equal(model.label, 'Pausing · current operation finishing')
  assert.equal(model.operationActive, true)
  assert.equal(tool.label, model.label)
  assert.equal(tool.operationActive, true)
  assert.equal(settled.label, 'Paused')
  assert.equal(settled.operationActive, false)
})

test('selected-agent precedence separates tools, model calls and stale working labels', () => {
  assert.equal(deriveAgentActivity('live', run(), agent({ status: 'blocked', tools: [runningTool] }), ['forge']).label, 'Blocked')
  assert.equal(deriveAgentActivity('live', run(), agent({ tools: [runningTool] }), ['forge']).label, 'Working · repo.patch')
  assert.equal(deriveAgentActivity('live', run(), agent(), ['forge']).label, 'Model call active')
  assert.equal(deriveAgentActivity('live', run(), agent({ status: 'working' }), []).label, 'Working')
  assert.equal(deriveAgentActivity('live', run(), agent({ status: 'thinking' }), []).label, 'Thinking')
  assert.equal(deriveAgentActivity('live', run(), agent({ pct: 100, eta: 'done' }), []).label, 'Completed')
})

test('follow-up wording never claims access to the scheduler inbox', () => {
  const one = deriveAgentActivity('live', run(), agent({ queueCount: 1 }), [])
  const many = deriveAgentActivity('live', run(), agent({ queueCount: 3 }), [])
  assert.equal(one.label, 'Idle · 1 follow-up queued')
  assert.equal(many.label, 'Idle · 3 follow-ups queued')
  assert.equal(`${one.label} ${many.label}`.includes('queued to run'), false)
  assert.equal(deriveAgentActivity('live', run('needs_approval'), agent(), []).label, 'Idle · run awaiting approval')
})

test('motion preference changes animation only and never the activity label', () => {
  const active = deriveAgentActivity('live', run(), agent(), ['forge'])
  assert.equal(active.label, 'Model call active')
  assert.equal(shouldAnimateAgentActivity(active, true), true)
  assert.equal(shouldAnimateAgentActivity(active, false), false)
  assert.equal(shouldAnimateAgentActivity(deriveAgentActivity('live', run(), agent({ status: 'working' }), []), true), false)
})

test('activity detail is bounded and merge shortcuts reflect current pipeline state', () => {
  const failed = deriveAgentActivity('live', run('failed', `provider ${'x'.repeat(80)}`), agent(), [])
  assert.equal(failed.label.endsWith('…'), true)
  assert.equal(failed.label.length <= 57, true)
  assert.deepEqual(quickCommands('PR #917')[0], {
    label: '/approve merge #917', draft: '/approve merge', disabled: false,
  })
  assert.deepEqual(quickCommands('')[0], {
    label: '/approve merge · no PR',
    draft: '/approve merge',
    disabled: true,
    reason: 'No pull request is associated with this run.',
  })
})
