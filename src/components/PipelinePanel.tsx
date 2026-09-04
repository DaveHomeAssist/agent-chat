import type { CSSVars } from '../lib/css'
import { COLOR, tint } from '../lib/theme'
import type { Agent, AgentId, Lane, Pipeline, Step, TrackerMode } from '../types'

interface Props {
  mode: TrackerMode
  onMode: (m: TrackerMode) => void
  pipeline: Pipeline
  accent: string
  agents: Record<AgentId, Agent>
  onSelectAgent: (id: AgentId) => void
}

/** Amber for anything the run is holding on; slate for the merely queued. */
function taskMetaColor(meta: string): string {
  if (meta === 'done') return COLOR.teal
  if (meta === 'blocked' || meta === 'gated') return COLOR.amber
  return COLOR.slate
}

export function PipelinePanel({ mode, onMode, pipeline, accent, agents, onSelectAgent }: Props) {
  const isBoard = mode === 'board'

  return (
    <div className="ac-pipeline" style={{ '--h': isBoard ? '52%' : '54%' } as CSSVars}>
      <div className="ac-pipeline-head">
        <div className="ac-eyebrow">PIPELINE</div>
        <span className="ac-pipeline-pr">{pipeline.pr}</span>
        <div className="ac-spacer" />
        <div className="ac-seg">
          <button
            className="ac-seg-btn"
            style={
              {
                '--c': isBoard ? '#0A0C11' : '#8C95A9',
                '--bg-c': isBoard ? accent : 'transparent',
              } as CSSVars
            }
            onClick={() => onMode('board')}
          >
            Board
          </button>
          <button
            className="ac-seg-btn"
            style={
              {
                '--c': !isBoard ? '#0A0C11' : '#8C95A9',
                '--bg-c': !isBoard ? accent : 'transparent',
              } as CSSVars
            }
            onClick={() => onMode('steps')}
          >
            Steps
          </button>
        </div>
      </div>

      <div className="ac-pipeline-body">
        {isBoard ? (
          <Board lanes={pipeline.lanes} agents={agents} onSelectAgent={onSelectAgent} />
        ) : (
          <Steps steps={pipeline.steps} accent={accent} />
        )}
      </div>
    </div>
  )
}

function Board({
  lanes,
  agents,
  onSelectAgent,
}: {
  lanes: Lane[]
  agents: Record<AgentId, Agent>
  onSelectAgent: (id: AgentId) => void
}) {
  return (
    <div className="ac-lanes">
      {lanes.map((lane) => {
        const needsYou = lane.state === 'NEEDS YOU'
        return (
          <div
            key={lane.name}
            className="ac-lane"
            style={
              {
                '--ring': needsYou ? 'rgba(242,180,87,.30)' : 'rgba(255,255,255,.07)',
                '--bg-c': needsYou ? 'rgba(242,180,87,.06)' : 'rgba(255,255,255,.018)',
              } as CSSVars
            }
          >
            <div className="ac-lane-head" style={{ '--c': lane.color } as CSSVars}>
              <span className="ac-dot ac-dot--6" />
              <span className="ac-lane-name">{lane.name}</span>
              <span className="ac-lane-count">{lane.tasks.length}</span>
              <div className="ac-spacer" />
              <span className="ac-lane-state">{lane.state}</span>
            </div>

            <div className="ac-lane-tasks">
              {lane.tasks.map((t, i) => {
                const owner = agents[t.owner]
                return (
                  <button
                    key={`${i}:${t.title}`}
                    className="ac-task"
                    onClick={() => onSelectAgent(t.owner)}
                  >
                    <span
                      className="ac-task-owner"
                      style={
                        {
                          '--c': owner.color,
                          '--tint': tint(owner.color, 0.16),
                        } as CSSVars
                      }
                    >
                      {owner.initials}
                    </span>
                    <span className="ac-task-title ac-truncate">{t.title}</span>
                    <span
                      className="ac-task-meta"
                      style={{ '--c': taskMetaColor(t.meta) } as CSSVars}
                    >
                      {t.meta}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Steps({ steps, accent }: { steps: Step[]; accent: string }) {
  return (
    <div className="ac-steps">
      {steps.map((s, i) => {
        const done = s.state === 'done'
        const active = s.state === 'active'
        const c = done ? COLOR.teal : active ? accent : COLOR.slate
        const last = i === steps.length - 1

        return (
          <div className="ac-step" key={`${i}:${s.title}`}>
            <div className="ac-step-rail">
              <div
                className="ac-step-dot"
                style={
                  {
                    '--ring': done ? COLOR.teal : active ? accent : 'rgba(255,255,255,.14)',
                    '--bg-c': done ? COLOR.teal : active ? tint(accent, 0.35) : 'transparent',
                  } as CSSVars
                }
              >
                {done ? '✓' : ''}
              </div>
              <div
                className="ac-step-line"
                style={
                  {
                    '--line': last
                      ? 'transparent'
                      : done
                        ? 'rgba(62,216,196,.28)'
                        : 'rgba(255,255,255,.08)',
                    '--h': last ? '0px' : '18px',
                  } as CSSVars
                }
              />
            </div>

            <div className="ac-step-body">
              <div className="ac-step-head">
                <span
                  className="ac-step-title"
                  style={{ '--c': done ? '#8C95A9' : '#E8EBF3' } as CSSVars}
                >
                  {s.title}
                </span>
                <span className="ac-spacer" />
                <span className="ac-step-meta" style={{ '--c': c } as CSSVars}>
                  {s.meta}
                </span>
              </div>
              <div className="ac-step-detail">{s.detail}</div>
              {active ? (
                <div className="ac-track ac-step-bar" style={{ '--c': c } as CSSVars}>
                  <div className="ac-track-fill" style={{ '--w': `${s.pct}%` } as CSSVars} />
                </div>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
