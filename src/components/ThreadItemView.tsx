import type { CSSVars } from '../lib/css'
import { COLOR, toolColor, tint } from '../lib/theme'
import type { Agent, AgentId, ThreadItem } from '../types'

const BADGE_COLOR: Record<string, string> = {
  RISK: COLOR.pink,
  PLAN: COLOR.violet,
  '18/24': COLOR.amber,
}

interface Props {
  item: ThreadItem
  agents: Record<AgentId, Agent>
  accent: string
  open: boolean
  onToggle: (id: string) => void
}

export function ThreadItemView({ item, agents, accent, open, onToggle }: Props) {
  return <div className="ac-thread-item">{render()}</div>

  function render() {
    switch (item.kind) {
      case 'divider':
        return (
          <div className="ac-divider">
            <div className="ac-divider-chip">
              <span className="ac-diamond" style={{ '--c': '#8B5CF6' } as CSSVars} />
              <span className="ac-divider-label">{item.body}</span>
            </div>
            <div className="ac-divider-line" />
            <span className="ac-divider-time">{item.time}</span>
          </div>
        )

      case 'message': {
        const a = agents[item.who]
        const badgeColor = item.badge ? (BADGE_COLOR[item.badge] ?? '#7E879B') : '#7E879B'
        const colors: CSSVars = {
          '--c': a.color,
          '--tint': tint(a.color, 0.14),
          '--ring': tint(a.color, 0.28),
        }
        return (
          <div className="ac-msg">
            <div className="ac-avatar ac-avatar--30" style={colors}>
              {a.initials}
            </div>
            <div className="ac-msg-body">
              <div className="ac-msg-head">
                <span className="ac-msg-name" style={colors}>
                  {a.name}
                </span>
                <span className="ac-msg-role">{a.role}</span>
                <span className="ac-spacer" />
                {item.badge ? (
                  <span
                    className="ac-badge"
                    style={{ '--c': badgeColor, '--ring': tint(badgeColor, 0.3) } as CSSVars}
                  >
                    {item.badge}
                  </span>
                ) : null}
                <span className="ac-msg-time">{item.time}</span>
              </div>
              <div className="ac-msg-text">{item.body}</div>
              {item.chips?.length ? (
                <div className="ac-chips">
                  {item.chips.map((c) => (
                    <span className="ac-chip" key={c}>
                      {c}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )
      }

      case 'tool': {
        const a = agents[item.who]
        const sc = toolColor(item.status)
        return (
          <div className="ac-tool">
            <button className="ac-tool-head" onClick={() => onToggle(item.id)}>
              <span className="ac-dot ac-dot--5" style={{ '--c': a.color } as CSSVars} />
              <span className="ac-tool-name">{item.tool}</span>
              <span className="ac-tool-arg ac-truncate">{item.body}</span>
              <span className="ac-spacer" />
              <span className="ac-tool-dur">{item.dur}</span>
              <span
                className="ac-tool-status"
                style={{ '--c': sc, '--tint': tint(sc, 0.14) } as CSSVars}
              >
                {item.status}
              </span>
              <span className="ac-caret">{open ? '▾' : '▸'}</span>
            </button>
            {open ? (
              <div className="ac-tool-lines">
                {item.lines.map((l, i) => (
                  <div className="ac-tool-line" key={`${i}:${l.text}`} style={{ '--c': l.color } as CSSVars}>
                    {l.text}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )
      }

      case 'handoff':
        return (
          <div className="ac-handoff">
            <span className="ac-handoff-tag">HANDOFF</span>
            <span className="ac-handoff-body">{item.body}</span>
            <span className="ac-handoff-time">{item.time}</span>
          </div>
        )

      case 'human':
        return (
          <div
            className="ac-human"
            style={{ '--ring': tint(accent, 0.32), '--tint': tint(accent, 0.1) } as CSSVars}
          >
            <div className="ac-human-avatar">DK</div>
            <div className="ac-msg-body">
              <div className="ac-msg-head">
                <span className="ac-human-name">You</span>
                <span
                  className="ac-badge ac-badge--human"
                  style={{ '--c': accent, '--ring': tint(accent, 0.32) } as CSSVars}
                >
                  {item.target === 'all' ? 'HUMAN · BROADCAST' : 'HUMAN · DIRECT'}
                </span>
                <span className="ac-spacer" />
                <span className="ac-msg-time">{item.time}</span>
              </div>
              <div className="ac-human-text">{item.body}</div>
            </div>
          </div>
        )
    }
  }
}
