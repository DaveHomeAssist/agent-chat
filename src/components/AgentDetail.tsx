import type { CSSVars } from '../lib/css'
import { levelColor, statusMeta, toolColor, tint } from '../lib/theme'
import type { Agent, DetailTab } from '../types'

const TAB_LABEL: Record<DetailTab, string> = {
  subtask: 'Subtask',
  output: 'Output log',
  tools: 'Tool calls',
}

const TABS: DetailTab[] = ['subtask', 'output', 'tools']

interface Props {
  agent: Agent
  tab: DetailTab
  onTab: (t: DetailTab) => void
  accent: string
  live: boolean
  onClose: () => void
  onMessage: () => void
  onInterrupt: () => void
}

export function AgentDetail({ agent, tab, onTab, accent, live, onClose, onMessage, onInterrupt }: Props) {
  const status = statusMeta(agent.status, live)
  const identity: CSSVars = {
    '--c': agent.color,
    '--tint': tint(agent.color, 0.14),
    '--ring': tint(agent.color, 0.28),
  }

  return (
    <div className="ac-agentpane">
      <div className="ac-agentpane-head">
        <div className="ac-avatar ac-avatar--26" style={identity}>
          {agent.initials}
        </div>
        <div className="ac-agentpane-id">
          <div className="ac-agentpane-name">{agent.name}</div>
          <div className="ac-agentpane-meta">
            {agent.role} · {status.label}
          </div>
        </div>
        <button className="ac-close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="ac-tabs">
        {TABS.map((k) => {
          const on = tab === k
          return (
            <button
              key={k}
              className="ac-tab"
              style={
                {
                  '--c': on ? accent : '#7E879B',
                  '--bg-c': on ? tint(accent, 0.12) : 'transparent',
                  '--ring': on ? tint(accent, 0.3) : 'rgba(255,255,255,.07)',
                } as CSSVars
              }
              onClick={() => onTab(k)}
            >
              {TAB_LABEL[k]}
            </button>
          )
        })}
      </div>

      <div className="ac-tabbody">
        {tab === 'subtask' ? (
          <SubtaskTab
            agent={agent}
            accent={accent}
            live={live}
            onMessage={onMessage}
            onInterrupt={onInterrupt}
          />
        ) : null}
        {tab === 'output' ? <OutputTab agent={agent} live={live} /> : null}
        {tab === 'tools' ? <ToolsTab agent={agent} /> : null}
      </div>
    </div>
  )
}

function SubtaskTab({
  agent,
  accent,
  live,
  onMessage,
  onInterrupt,
}: {
  agent: Agent
  accent: string
  live: boolean
  onMessage: () => void
  onInterrupt: () => void
}) {
  return (
    <div className="ac-subtask">
      <div className="ac-card">
        <div className="ac-card-eyebrow">CURRENT SUBTASK</div>
        <div className="ac-subtask-title">{agent.subtaskTitle}</div>

        <div className="ac-progress-row" style={{ '--c': agent.color } as CSSVars}>
          <div className="ac-track--5">
            <div className="ac-track-fill" style={{ '--w': `${agent.pct}%` } as CSSVars} />
            <div
              className="ac-track-sweep"
              style={{ animation: live ? 'sweep 2.4s ease-in-out infinite' : 'none' }}
            />
          </div>
          <span className="ac-pct">{agent.pct}%</span>
          <span className="ac-eta">{agent.eta}</span>
        </div>

        <div className="ac-io">
          {agent.io.map((c) => (
            <span className="ac-io-chip" key={c}>
              {c}
            </span>
          ))}
        </div>
      </div>

      <div className="ac-detail-actions">
        <button className="ac-action" onClick={onInterrupt}>
          Interrupt
        </button>
        <button className="ac-action">Reassign</button>
        <button
          className="ac-action ac-action--accent"
          style={
            { '--ring': tint(accent, 0.32), '--tint': tint(accent, 0.1), '--accent': accent } as CSSVars
          }
          onClick={onMessage}
        >
          Message
        </button>
      </div>

      <div className="ac-queue">
        <div className="ac-card-eyebrow">QUEUE · {agent.queueCount}</div>
        {agent.queue.map((q, i) => (
          <div className="ac-queue-item" key={`${i}:${q.title}`}>
            <span className="ac-dot ac-dot--4" style={{ '--c': '#5E6779' } as CSSVars} />
            <span className="ac-queue-title">{q.title}</span>
            <span className="ac-queue-meta">{q.meta}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function OutputTab({ agent, live }: { agent: Agent; live: boolean }) {
  return (
    <div className="ac-log">
      {agent.log.map((l, i) => (
        <div className="ac-log-line" key={`${i}:${l.t}:${l.msg}`}>
          <span className="ac-log-t">{l.t}</span>
          <span className="ac-log-level" style={{ '--c': levelColor(l.level) } as CSSVars}>
            {l.level}
          </span>
          <span className="ac-log-msg">{l.msg}</span>
        </div>
      ))}
      <div className="ac-log-foot">
        <span
          className="ac-cursor"
          style={
            {
              '--c': agent.color,
              animation: live ? 'blink 1.1s steps(1) infinite' : 'none',
            } as CSSVars
          }
        />
        <span className="ac-log-streaming">streaming</span>
      </div>
    </div>
  )
}

function ToolsTab({ agent }: { agent: Agent }) {
  return (
    <div className="ac-toolcalls">
      {agent.tools.map((t) => {
        const c = toolColor(t.status)
        return (
          <div
            className="ac-toolcall"
            key={t.id}
            style={{ '--c': c, '--tint': tint(c, 0.14) } as CSSVars}
          >
            <span className="ac-dot ac-dot--5" />
            <span className="ac-toolcall-name">{t.name}</span>
            <span className="ac-toolcall-arg ac-truncate">{t.arg}</span>
            <span className="ac-toolcall-dur">{t.dur}</span>
            <span className="ac-toolcall-status">{t.status}</span>
          </div>
        )
      })}
    </div>
  )
}
