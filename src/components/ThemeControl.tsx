import type { AppTheme } from '../lib/theme'

interface Props {
  theme: AppTheme
  onToggle: () => void
}

export function ThemeControl({ theme, onToggle }: Props) {
  const dark = theme === 'dark'

  return (
    <button
      className="ac-theme-control"
      type="button"
      aria-label="Dark mode"
      aria-pressed={dark}
      onClick={onToggle}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {dark ? (
          <path d="M15.7 12.8A6.7 6.7 0 0 1 7.2 4.3 6.8 6.8 0 1 0 15.7 12.8Z" />
        ) : (
          <>
            <circle cx="10" cy="10" r="3.25" />
            <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M16 4l-1.4 1.4M5.4 14.6 4 16" />
          </>
        )}
      </svg>
      <span>{dark ? 'Light mode' : 'Dark mode'}</span>
    </button>
  )
}
