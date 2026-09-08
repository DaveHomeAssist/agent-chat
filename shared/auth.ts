/** Browser-safe authentication contracts. Secrets and session handles never use these types. */

export const AUTH_MODES = ['local', 'session'] as const

export type AuthMode = (typeof AUTH_MODES)[number]

export type AuthCredentialKind = 'local' | 'session' | 'bearer'

export interface AuthStatusPayload {
  mode: AuthMode
  authenticated: boolean
  /** Absolute ISO-8601 expiry for cookie sessions; null for local/bearer/anonymous state. */
  expiresAt: string | null
}

export type AuthErrorCode = 'AUTH_REQUIRED' | 'AUTH_RATE_LIMITED' | 'AUTH_CAPACITY' | 'AUTH_UNAVAILABLE'
