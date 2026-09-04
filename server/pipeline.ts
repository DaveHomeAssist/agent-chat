/**
 * Derives the board (lanes) and the checklist (steps) from the store's tasks,
 * agents, run status and thread. Pure: no state of its own, nothing invented —
 * every number in a detail line comes from a task record or an agent's io.
 */

import type { Agent, AgentId, Lane, LaneTask, Phase, Pipeline, RunInfo, RunSnapshot, Step, StepState, ThreadItem } from '../shared/protocol.js'
import { PHASES } from '../shared/protocol.js'
import type { RunStore, TaskRecord } from './contracts.js'

const PR = 'PR #482'

const LANES: { name: string; phase: Phase; color: string }[] = [
  { name: 'Spec', phase: 'spec', color: '#A78BFA' },
  { name: 'Build', phase: 'build', color: '#3ED8C4' },
  { name: 'Test', phase: 'test', color: '#F2B457' },
  { name: 'Review', phase: 'review', color: '#7C9BFF' },
  { name: 'Ship', phase: 'ship', color: '#5E6779' },
]

interface StepDef {
  title: (gate: boolean) => string
  phase: Phase
  owner: AgentId
}

const STEPS: StepDef[] = [
  { title: () => 'Spec + ADR-0142', phase: 'spec', owner: 'vector' },
  { title: () => 'Threat model signed off', phase: 'spec', owner: 'vector' },
  { title: () => 'Implement register + verify', phase: 'build', owner: 'forge' },
  { title: () => 'e2e suite green', phase: 'test', owner: 'probe' },
  { title: () => 'Security + diff review', phase: 'review', owner: 'sentry' },
  { title: (gate) => (gate ? 'Human approval to merge' : 'Auto-merge on green'), phase: 'ship', owner: 'atlas' },
  { title: () => 'Canary 5% → 100%', phase: 'done', owner: 'atlas' },
]

const RATIO = /^(\d+)\/(\d+)$/

interface View {
  run: RunInfo
  phase: Phase
  tasks: TaskRecord[]
  agents: Record<AgentId, Agent>
  thread: ThreadItem[]
}

/** `phaseOverride` lets the caller derive for a phase it is about to record. */
export function derivePipeline(store: RunStore, phaseOverride?: Phase): Pipeline {
  const snap: RunSnapshot = store.snapshot()
  const done = snap.run.status === 'done'
  const view: View = {
    run: snap.run,
    phase: done ? 'done' : (phaseOverride ?? snap.pipeline.phase),
    tasks: store.tasks(),
    agents: Object.fromEntries(snap.agents.map((a) => [a.id, a])) as Record<AgentId, Agent>,
    thread: snap.thread,
  }
  return {
    phase: view.phase,
    lanes: LANES.map((l) => lane(l, view)),
    steps: STEPS.map((s, i) => step(s, i, view)),
    pr: PR,
  }
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

function lane(def: (typeof LANES)[number], v: View): Lane {
  const tasks = v.tasks.filter((t) => t.phase === def.phase)
  const cells: LaneTask[] = tasks.map((t) => ({ title: t.title, owner: t.owner, meta: t.meta }))
  if (def.phase === 'ship') cells.push(canaryTask(v))
  return { name: def.name, color: def.color, state: laneState(def.phase, tasks, v), tasks: cells }
}

function canaryTask(v: View): LaneTask {
  const gate = v.run.approvalGate
  const done = v.run.status === 'done'
  return {
    title: gate ? 'Canary 5% · awaiting approval' : 'Canary 5% · auto-release',
    owner: 'atlas',
    meta: done ? 'done' : gate ? 'gated' : 'auto',
  }
}

function laneState(phase: Phase, tasks: TaskRecord[], v: View): string {
  if (phase === 'ship') {
    if (v.run.status === 'done') return 'DONE'
    if (v.run.status === 'needs_approval') return 'NEEDS YOU'
    return v.run.approvalGate ? '—' : 'AUTO'
  }
  if (tasks.length && tasks.every((t) => t.state === 'done')) return 'DONE'
  const active = tasks.filter((t) => t.state === 'active').length
  if (active) return phase === 'test' ? 'RUNNING' : `${active} ACTIVE`
  return tasks.length ? 'QUEUED' : '—'
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function step(def: StepDef, index: number, v: View): Step {
  const gate = v.run.approvalGate
  if (def.phase === 'ship') return gateStep(def.title(gate), v)
  if (def.phase === 'done') return canaryStep(def.title(gate), v)

  const tasks = v.tasks.filter((t) => t.phase === def.phase)
  const task = primaryTask(tasks)
  const state = phaseState(def.phase, tasks, v)
  const owner = task?.owner ?? def.owner
  const agent = v.agents[owner]
  return {
    title: def.title(gate),
    state,
    detail: detailFor(index, state, task, agent),
    meta: stepMeta(state, def.phase, task, agent, v),
    pct: state === 'active' ? agent.pct : 0,
  }
}

/** The task the step reports on: the live one, else the most recent. */
function primaryTask(tasks: TaskRecord[]): TaskRecord | undefined {
  return tasks.find((t) => t.state === 'active') ?? tasks.find((t) => t.state === 'blocked') ?? tasks[tasks.length - 1]
}

function phaseState(phase: Phase, tasks: TaskRecord[], v: View): StepState {
  if (v.phase === 'done') return 'done'
  const idx = PHASES.indexOf(phase)
  const cur = PHASES.indexOf(v.phase)
  const allDone = tasks.length > 0 && tasks.every((t) => t.state === 'done')
  const anyLive = tasks.some((t) => t.state === 'active' || t.state === 'blocked')
  if (allDone) return 'done'
  if (anyLive) return 'active'
  if (idx < cur) return 'done'
  return idx === cur ? 'active' : 'wait'
}

function stepMeta(state: StepState, phase: Phase, task: TaskRecord | undefined, agent: Agent, v: View): string {
  if (state === 'done') return phaseClosedAt(phase, v) ?? 'done'
  if (state === 'active') return task?.state === 'blocked' ? 'blocked' : `${agent.pct}%`
  return task ? 'queued' : '—'
}

/** Time of the divider that moved the run past `phase` — the phase's real completion time. */
function phaseClosedAt(phase: Phase, v: View): string | null {
  const next = PHASES.indexOf(phase) + 2
  const divider = v.thread.find((t) => t.kind === 'divider' && t.body.startsWith(`PHASE ${next} `))
  return divider ? divider.time : null
}

function gateStep(title: string, v: View): Step {
  const gate = v.run.approvalGate
  const who = gate ? 'You' : 'Atlas'
  if (v.run.status === 'done') {
    return { title, state: 'done', detail: `${who} · ${gate ? 'approved' : 'auto-merged'}`, meta: 'done', pct: 0 }
  }
  if (v.run.status === 'needs_approval') {
    return { title, state: 'active', detail: 'You · approval requested', meta: 'needs you', pct: 0 }
  }
  if (v.phase === 'ship') {
    return { title, state: 'active', detail: 'Atlas · requesting merge', meta: `${v.agents.atlas.pct}%`, pct: v.agents.atlas.pct }
  }
  return { title, state: 'wait', detail: gate ? 'You · gate is held' : 'Atlas · gate disabled', meta: '—', pct: 0 }
}

function canaryStep(title: string, v: View): Step {
  if (v.run.status === 'done') return { title, state: 'done', detail: `Atlas · ${PR} merged`, meta: 'done', pct: 0 }
  return { title, state: 'wait', detail: 'Atlas · not started', meta: '—', pct: 0 }
}

// ---------------------------------------------------------------------------
// Detail lines — built only from task records and the owner's io
// ---------------------------------------------------------------------------

function detailFor(index: number, state: StepState, task: TaskRecord | undefined, agent: Agent): string {
  const name = agent.name
  const io = (re: RegExp): string[] => agent.io.filter((s) => re.test(s))
  switch (index) {
    case 0: {
      const decisions = io(/decision/i)[0]
      if (decisions) return `${name} · ${decisions} recorded`
      const adr = io(/adr/i)[0]
      return adr ? `${name} · ${adr}` : fallback(name, state, task)
    }
    case 1: {
      const tm = io(/threat/i)[0]
      if (tm) return `${name} · ${tm}`
      return `${name} · ${state === 'done' ? 'signed off' : state === 'active' ? 'in progress' : 'pending'}`
    }
    case 2: {
      const parts = io(/\bfiles?\b|migration/i)
      return parts.length ? `${name} · ${parts.join(', ')}` : fallback(name, state, task)
    }
    case 3: {
      const m = task ? RATIO.exec(task.meta) : null
      const green = task?.state === 'done'
      if (m) {
        const passed = Number(m[1])
        const total = Number(m[2])
        const failed = total - passed
        return `${name} · ${passed}/${total}${failed ? `, ${failed} failing` : ' green'}`
      }
      const cases = io(/cases?$/i)[0]
      if (green && cases) return `${name} · ${cases} green`
      return fallback(name, state, task)
    }
    case 4: {
      if (task?.state === 'blocked') {
        const blocking = io(/blocking/i)[0]
        return `${name} · blocked${blocking ? `, ${blocking}` : ''}`
      }
      const parts = io(/LOC|blocking/i)
      return parts.length ? `${name} · ${parts.join(', ')}` : fallback(name, state, task)
    }
    default:
      return fallback(name, state, task)
  }
}

function fallback(name: string, state: StepState, task: TaskRecord | undefined): string {
  if (task) return `${name} · ${task.title}`
  return `${name} · ${state === 'done' ? 'done' : state === 'active' ? 'in progress' : 'not started'}`
}
