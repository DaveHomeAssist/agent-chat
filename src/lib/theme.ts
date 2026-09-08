import type { AgentStatus, LogLevel, ToolStatus } from '../types'

export type AppTheme = 'light' | 'dark'

export function toggleTheme(theme: AppTheme): AppTheme {
  return theme === 'light' ? 'dark' : 'light'
}

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

export type ThemeColor = keyof typeof COLOR

const LIGHT_COLOR: Record<ThemeColor, string> = {
  teal: '#087568',
  violet: '#6742A6',
  amber: '#875100',
  pink: '#B42359',
  blue: '#3D5EBA',
  slate: '#536078',
}

export function colorForTheme(theme: AppTheme, color: ThemeColor): string {
  return theme === 'light' ? LIGHT_COLOR[color] : COLOR[color]
}

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

export function statusMeta(status: AgentStatus, live: boolean, theme: AppTheme = 'dark'): StatusMeta {
  const m = STATUS_META[status]
  const pulsing = live && (status === 'working' || status === 'thinking')
  const colorName = status === 'working' ? 'teal' : status === 'thinking' ? 'violet' : status === 'blocked' ? 'amber' : 'slate'
  return { ...m, color: colorForTheme(theme, colorName), pulse: pulsing ? 'ring 1.8s ease-out infinite' : 'none' }
}

export function levelColor(level: LogLevel, theme: AppTheme = 'dark'): string {
  if (level === 'FAIL' || level === 'RISK') return colorForTheme(theme, 'pink')
  if (level === 'WARN') return colorForTheme(theme, 'amber')
  return colorForTheme(theme, 'slate')
}

export function toolColor(status: ToolStatus, theme: AppTheme = 'dark'): string {
  if (status === 'ok') return colorForTheme(theme, 'teal')
  if (status === 'queued') return colorForTheme(theme, 'slate')
  if (status === 'drafting' || status === 'running') return colorForTheme(theme, 'amber')
  return colorForTheme(theme, 'pink')
}
