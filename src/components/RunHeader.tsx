import type { CSSVars } from '../lib/css'
import { COLOR, tint } from '../lib/theme'
import type { RunInfo, RunStats, RunStatus } from '../types'

interface Props {
  accent: string
  run: RunInfo | null
  stats: RunStats | null
  live: boolean
  detailOpen: boolean
  /** The primary control: start / pause / resume / approve, depending on the run status. */
  onRunAction: () => void
  onToggleDetail: () => void
}

const STATUS_META: Record<RunStatus, { label: string; color: string; pulse: boolean }> = {
  idle: { label: 'IDLE', color: COLOR.slate, pulse: false },
  live: { label: 'LIVE', color: COLOR.teal, pulse: true },
  paused: { label: 'PAUSED', color: COLOR.amber, pulse: false },
  needs_approval: { label: 'NEEDS YOU', color: COLOR.amber, pulse: true },
  done: { label: 'DONE', color: COLOR.slate, pulse: false },
  failed: { label: 'FAILED', color: COLOR.pink, pulse: false },
}

const ACTION_LABEL: Record<RunStatus, string> = {
  idle: 'Start run',
  live: 'Pause run',
  paused: 'Resume run',
  needs_approval: 'Approve merge',
  done: 'Restart run',
  failed: 'Restart run',
}

export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatTokens(n: number): string {
  return `${(n / 1000).toFixed(1)}k tok`
}

export function RunHeader({ accent, run, stats, live, detailOpen, onRunAction, onToggleDetail }: Props) {
  const status: RunStatus = run?.status ?? 'idle'
  const meta = STATUS_META[status]
  const runColor = meta.color

  const pill: CSSVars = {
    '--ring': tint(runColor, 0.3),
    '--tint': tint(runColor, 0.1),
    '--c': runColor,
  }
  const accentBtn: CSSVars = {
    '--ring': tint(accent, 0.32),
    '--tint': tint(accent, 0.1),
    '--accent': accent,
  }

  const tokens = stats ? stats.inputTokens + stats.outputTokens : 0

  return (
    <header className="ac-header">
      <div className="ac-brand">
        <div className="ac-brand-mark">
          <i />
        </div>
        <div className="ac-brand-text">
          <div className="ac-brand-title">Agent Chatroom</div>
          <div className="ac-brand-sub">{run ? `${run.repo} · ${run.branch}` : ''}</div>
        </div>
      </div>

      <div className="ac-vrule" />

      <div className="ac-run">
        <div className="ac-run-pill" style={pill}>
          <span
            className="ac-dot ac-dot--6"
            style={{ animation: live && meta.pulse ? 'ring 2s ease-out infinite' : 'none' }}
          />
          <span className="ac-run-label">{run ? `${run.label} · ${meta.label}` : meta.label}</span>
        </div>
        <div className="ac-run-stats">
          <span>{formatElapsed(stats?.elapsedSec ?? 0)} elapsed</span>
          <span>{formatTokens(tokens)}</span>
          <span>${(stats?.costUsd ?? 0).toFixed(2)}</span>
        </div>
      </div>

      <div className="ac-spacer" />

      <div className="ac-actions">
        <button className="ac-btn ac-btn--pause" onClick={onRunAction}>
          <span className="ac-btn-swatch" style={{ '--c': runColor } as CSSVars} />
          {ACTION_LABEL[status]}
        </button>
        <button className="ac-btn">Snapshot</button>
        <button className="ac-btn ac-btn--accent" style={accentBtn} onClick={onToggleDetail}>
          {detailOpen ? 'Hide detail' : 'Agent detail'}
        </button>
      </div>
    </header>
  )
}
