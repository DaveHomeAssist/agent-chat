import type { CSSVars } from '../lib/css'
import { COLOR, tint } from '../lib/theme'

interface Props {
  accent: string
  paused: boolean
  live: boolean
  detailOpen: boolean
  onTogglePause: () => void
  onToggleDetail: () => void
}

export function RunHeader({ accent, paused, live, detailOpen, onTogglePause, onToggleDetail }: Props) {
  const runColor = paused ? COLOR.amber : COLOR.teal

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

  return (
    <header className="ac-header">
      <div className="ac-brand">
        <div className="ac-brand-mark">
          <i />
        </div>
        <div className="ac-brand-text">
          <div className="ac-brand-title">Agent Chatroom</div>
          <div className="ac-brand-sub">helios/api · feat/passkey-auth</div>
        </div>
      </div>

      <div className="ac-vrule" />

      <div className="ac-run">
        <div className="ac-run-pill" style={pill}>
          <span
            className="ac-dot ac-dot--6"
            style={{ animation: live && !paused ? 'ring 2s ease-out infinite' : 'none' }}
          />
          <span className="ac-run-label">{paused ? 'RUN 04 · PAUSED' : 'RUN 04 · LIVE'}</span>
        </div>
        <div className="ac-run-stats">
          <span>12:41 elapsed</span>
          <span>38.2k tok</span>
          <span>$1.14</span>
        </div>
      </div>

      <div className="ac-spacer" />

      <div className="ac-actions">
        <button className="ac-btn ac-btn--pause" onClick={onTogglePause}>
          <span className="ac-btn-swatch" style={{ '--c': runColor } as CSSVars} />
          {paused ? 'Resume run' : 'Pause run'}
        </button>
        <button className="ac-btn">Snapshot</button>
        <button className="ac-btn ac-btn--accent" style={accentBtn} onClick={onToggleDetail}>
          {detailOpen ? 'Hide detail' : 'Agent detail'}
        </button>
      </div>
    </header>
  )
}
