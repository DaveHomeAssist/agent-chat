import type { CSSProperties } from 'react'

/** A style object that may also carry CSS custom properties. */
export type CSSVars = CSSProperties & { [key: `--${string}`]: string | number }
