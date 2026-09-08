import type { AuthCredentialKind } from '../shared/auth.js'
import { isApprovedLoopbackHost, type AuthConfig } from './auth-config.js'
import type { AuthHeaderValue } from './auth.js'

const FETCH_SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none'])

export type RequestPolicy = 'auth-status' | 'login' | 'logout' | 'protected-read' | 'protected-mutation'

export interface RequestSecurityInput {
  host: AuthHeaderValue
  origin?: AuthHeaderValue
  secFetchSite?: AuthHeaderValue
  /** Result of authentication. Login may pass null before validating its submitted bearer token. */
  credentialKind: AuthCredentialKind | null
  /** True only when Node itself terminated TLS. Forwarding headers never set this value implicitly. */
  encrypted?: boolean
}

export type RequestSecurityFailureReason =
  | 'host'
  | 'origin'
  | 'cross_site'
  | 'origin_required'
  | 'credential'
  | 'mode'

export type RequestSecurityResult =
  | { ok: true }
  | { ok: false; reason: RequestSecurityFailureReason }

/**
 * Pure request policy. Callers map every failure to one generic 403 response and
 * must not echo Host/Origin values. X-Forwarded-* is intentionally not accepted.
 */
export function evaluateRequestSecurity(
  config: AuthConfig,
  policy: RequestPolicy,
  input: RequestSecurityInput,
): RequestSecurityResult {
  const configuredOrigin = config.mode === 'session' && config.publicOrigin !== null ? new URL(config.publicOrigin) : null
  const requestScheme = configuredOrigin?.protocol ?? (input.encrypted ? 'https:' : 'http:')
  const host = parseHost(input.host, requestScheme)
  if (!host) return denied('host')

  let expectedOrigin: string
  if (config.mode === 'local') {
    if (!isApprovedLoopbackHost(host.hostname)) return denied('host')
    expectedOrigin = `${requestScheme}//${host.host}`
  } else {
    if (configuredOrigin === null) return denied('mode')
    if (host.host.toLowerCase() !== configuredOrigin.host.toLowerCase()) return denied('host')
    expectedOrigin = configuredOrigin.origin
  }

  const origin = parseOriginHeader(input.origin)
  if (origin.state === 'invalid') return denied('origin')
  if (origin.state === 'value' && origin.value !== expectedOrigin) return denied('origin')

  const fetchSite = parseFetchSite(input.secFetchSite)
  if (fetchSite === 'invalid') return denied('cross_site')
  if (fetchSite === 'cross-site') return denied('cross_site')

  const credentialCheck = validateCredential(config.mode, policy, input.credentialKind)
  if (credentialCheck !== null) return denied(credentialCheck)

  if (!isMutation(policy) || origin.state === 'value') return { ok: true }

  if (policy === 'login') return { ok: true }
  if (config.mode === 'local' && input.credentialKind === 'local') return { ok: true }
  if (config.mode === 'session' && input.credentialKind === 'bearer') return { ok: true }
  return denied('origin_required')
}

function validateCredential(
  mode: AuthConfig['mode'],
  policy: RequestPolicy,
  credential: AuthCredentialKind | null,
): RequestSecurityFailureReason | null {
  if (policy === 'auth-status') return null

  if (mode === 'local') {
    if (policy === 'login' || policy === 'logout') return 'mode'
    return credential === 'local' ? null : 'credential'
  }

  if (policy === 'login') return credential === null || credential === 'bearer' ? null : 'credential'
  if (policy === 'logout') {
    return credential === null || credential === 'session' || credential === 'bearer' ? null : 'credential'
  }
  if (policy === 'protected-read' || policy === 'protected-mutation') {
    return credential === 'session' || credential === 'bearer' ? null : 'credential'
  }
  return 'credential'
}

function isMutation(policy: RequestPolicy): boolean {
  return policy === 'login' || policy === 'logout' || policy === 'protected-mutation'
}

function parseHost(value: AuthHeaderValue, scheme: string): { host: string; hostname: string } | null {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\s/@?#]/.test(value)) return null
  try {
    const url = new URL(`${scheme}//${value}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return { host: url.host, hostname: url.hostname }
  } catch {
    return null
  }
}

type ParsedOrigin = { state: 'none' | 'invalid' } | { state: 'value'; value: string }

function parseOriginHeader(value: AuthHeaderValue): ParsedOrigin {
  if (value === undefined) return { state: 'none' }
  if (typeof value !== 'string' || value.length > 512) return { state: 'invalid' }
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) {
      return { state: 'invalid' }
    }
    return { state: 'value', value: url.origin }
  } catch {
    return { state: 'invalid' }
  }
}

function parseFetchSite(value: AuthHeaderValue): string | 'invalid' | null {
  if (value === undefined) return null
  if (typeof value !== 'string') return 'invalid'
  const normalized = value.toLowerCase()
  return FETCH_SITES.has(normalized) ? normalized : 'invalid'
}

function denied(reason: RequestSecurityFailureReason): RequestSecurityResult {
  return { ok: false, reason }
}
