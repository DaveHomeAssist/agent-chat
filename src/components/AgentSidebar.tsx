import type { CSSVars } from '../lib/css'
import { statusMeta, tint } from '../lib/theme'
import type { Agent, AgentId } from '../types'

interface Props {
  agents: Agent[]
  selected: AgentId
  live: boolean
  accent: string
  gate: boolean
  onSelect: (id: AgentId) => void
  onToggleGate: () => void
}

export function AgentSidebar({ agents, selected, live, accent, gate, onSelect, onToggleGate }: Props) {
  return (
    <aside className="ac-sidebar">
      <div className="ac-sidebar-head">
        <div className="ac-eyebrow">ACTIVE AGENTS</div>
        <div className="ac-sidebar-count">{agents.length}</div>
      </div>

      <div className="ac-agent-list">
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            selected={selected === a.id}
            live={live}
            onSelect={() => onSelect(a.id)}
          />
        ))}
      </div>

      <div className="ac-oversight">
        <div className="ac-eyebrow">HUMAN OVERSIGHT</div>

        <button className="ac-toggle-row" onClick={onToggleGate}>
          <span className="ac-toggle-label">Approve before merge</span>
          <span
            className="ac-switch"
            style={
              {
                '--track': gate ? tint(accent, 0.55) : 'rgba(255,255,255,.10)',
                '--justify': gate ? 'flex-end' : 'flex-start',
                '--knob': '#E8EBF3',
              } as CSSVars
            }
          >
            <i />
          </span>
        </button>

        <div className="ac-toggle-row">
          <span className="ac-toggle-label">Auto-approve tool calls</span>
          <span
            className="ac-switch"
            style={
              {
                '--track': 'rgba(255,255,255,.10)',
                '--justify': 'flex-start',
                '--knob': '#5E6779',
              } as CSSVars
            }
          >
            <i />
          </span>
        </div>

        <div className="ac-oversight-stats">
          <span>128 msgs</span>
          <span>41 tools</span>
          <span>6 handoffs</span>
        </div>
      </div>
    </aside>
  )
}

function AgentRow({
  agent,
  selected,
  live,
  onSelect,
}: {
  agent: Agent
  selected: boolean
  live: boolean
  onSelect: () => void
}) {
  const status = statusMeta(agent.status, live)

  const row: CSSVars = {
    '--row-ring': selected ? tint(agent.color, 0.26) : 'rgba(255,255,255,.05)',
    '--row-bg': selected ? tint(agent.color, 0.09) : 'transparent',
    '--bar': selected ? agent.color : 'transparent',
  }

  return (
    <button className="ac-agent-row" style={row} onClick={onSelect}>
      <div className="ac-agent-bar" />

      <div className="ac-agent-main">
        <div
          className="ac-avatar ac-avatar--28"
          style={
            {
              '--c': agent.color,
              '--tint': tint(agent.color, 0.14),
              '--ring': tint(agent.color, 0.28),
            } as CSSVars
          }
        >
          {agent.initials}
        </div>

        <div className="ac-agent-id">
          <div className="ac-agent-nameline">
            <span className="ac-agent-name">{agent.name}</span>
            <span className="ac-agent-model">{agent.model}</span>
          </div>
          <div className="ac-agent-role ac-truncate">{agent.role}</div>
        </div>

        <div className="ac-agent-status" style={{ '--c': status.color } as CSSVars}>
          <span className="ac-dot ac-dot--6" style={{ animation: status.pulse }} />
          <span className="ac-status-label">{status.label}</span>
        </div>
      </div>

      <div className="ac-agent-sub">
        <div className="ac-agent-subtask ac-truncate">{agent.subtask}</div>
        <div className="ac-track" style={{ '--c': agent.color } as CSSVars}>
          <div className="ac-track-fill" style={{ '--w': `${agent.pct}%` } as CSSVars} />
        </div>
      </div>
    </button>
  )
}
