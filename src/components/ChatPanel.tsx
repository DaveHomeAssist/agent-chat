import { useEffect, useRef } from 'react'
import type { CSSVars } from '../lib/css'
import { tint } from '../lib/theme'
import { FILTERS, QUICK_COMMANDS } from '../data/thread'
import type { Agent, AgentId, ThreadFilter, ThreadItem } from '../types'
import { ThreadItemView } from './ThreadItemView'

interface Props {
  thread: ThreadItem[]
  agents: Record<AgentId, Agent>
  accent: string
  filter: ThreadFilter
  onFilter: (f: ThreadFilter) => void
  openTools: Record<string, boolean>
  onToggleTool: (id: string) => void
  typing: boolean
  draft: string
  onDraft: (v: string) => void
  onSend: () => void
  targetLabel: string
  targetColor: string
  onCycleTarget: () => void
}

export function ChatPanel({
  thread,
  agents,
  accent,
  filter,
  onFilter,
  openTools,
  onToggleTool,
  typing,
  draft,
  onDraft,
  onSend,
  targetLabel,
  targetColor,
  onCycleTarget,
}: Props) {
  const threadRef = useRef<HTMLDivElement>(null)

  // The room always sits pinned to the newest message, like a live console.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  return (
    <main className="ac-main">
      <div className="ac-thread-head">
        <div className="ac-channel">
          <div className="ac-channel-name">#feature-passkey-auth</div>
          <div className="ac-channel-meta">started 14:02 · 5 agents · 3 tool servers</div>
        </div>
        <div className="ac-spacer" />
        <div className="ac-filters">
          {FILTERS.map((f) => {
            const on = filter === f.key
            return (
              <button
                key={f.key}
                className="ac-filter"
                style={
                  {
                    '--ring': on ? tint(accent, 0.3) : 'rgba(255,255,255,.08)',
                    '--bg-c': on ? tint(accent, 0.12) : 'rgba(255,255,255,.03)',
                    '--c': on ? accent : '#8C95A9',
                  } as CSSVars
                }
                onClick={() => onFilter(f.key)}
              >
                {f.label}
                <span className="ac-filter-count">{f.count}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="ac-thread" ref={threadRef}>
        {thread.map((item) => (
          <ThreadItemView
            key={item.id}
            item={item}
            agents={agents}
            accent={accent}
            open={!!openTools[item.id]}
            onToggle={onToggleTool}
          />
        ))}

        {typing ? (
          <div className="ac-typing">
            <div className="ac-typing-dots">
              <i />
              <i />
              <i />
            </div>
            <span className="ac-typing-label">
              Forge is writing a patch · Probe is bisecting 2 failures
            </span>
          </div>
        ) : null}
      </div>

      <div className="ac-composer">
        <div className="ac-quick">
          {QUICK_COMMANDS.map((q) => (
            <button key={q.label} className="ac-quick-btn" onClick={() => onDraft(q.draft)}>
              {q.label}
            </button>
          ))}
        </div>

        <div className="ac-input-bar">
          <button className="ac-target" onClick={onCycleTarget}>
            <span className="ac-diamond" style={{ '--c': targetColor } as CSSVars} />
            <span className="ac-target-label">{targetLabel}</span>
            <span className="ac-target-caret">▾</span>
          </button>

          <input
            className="ac-input"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onSend()
              }
            }}
            placeholder="Message the room, or /assign forge migration…"
          />

          <span className="ac-send-hint">⏎ send</span>
          <button className="ac-send" style={{ '--accent': accent } as CSSVars} onClick={onSend}>
            Send
          </button>
        </div>
      </div>
    </main>
  )
}
