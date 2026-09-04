import type { AgentStatus, LogLevel, ToolStatus } from '../types'

/** The four accent choices exposed as a design prop. */
export const ACCENTS = ['#4C8CFF', '#8B5CF6', '#3ED8C4', '#F472B6'] as const

export const COLOR = {
  teal: '#3ED8C4',
  violet: '#A78BFA',
  amber: '#F2B457',
  pink: '#F472B6',
  blue: '#7C9BFF',
  slate: '#5E6779',
} as const

/** Fade a hex colour to an `rgba()` string at the given alpha. */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

const STATUS_META: Record<AgentStatus, { color: string; label: string }> = {
  working: { color: COLOR.teal, label: 'WORKING' },
  thinking: { color: COLOR.violet, label: 'THINKING' },
  idle: { color: COLOR.slate, label: 'IDLE' },
  blocked: { color: COLOR.amber, label: 'BLOCKED' },
}

export interface StatusMeta {
  color: string
  label: string
  /** Only the two in-flight statuses pulse, and only when live motion is on. */
  pulse: string
}

export function statusMeta(status: AgentStatus, live: boolean): StatusMeta {
  const m = STATUS_META[status]
  const pulsing = live && (status === 'working' || status === 'thinking')
  return { ...m, pulse: pulsing ? 'ring 1.8s ease-out infinite' : 'none' }
}

export function levelColor(level: LogLevel): string {
  if (level === 'FAIL' || level === 'RISK') return COLOR.pink
  if (level === 'WARN') return COLOR.amber
  return COLOR.slate
}

export function toolColor(status: ToolStatus): string {
  if (status === 'ok') return COLOR.teal
  if (status === 'queued') return COLOR.slate
  if (status === 'drafting') return COLOR.amber
  return COLOR.pink
}
