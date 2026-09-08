import { AUTH_MODES, type AuthMode } from '../shared/auth.js'

export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 8 * 60 * 60
export const MIN_AUTH_SESSION_TTL_SECONDS = 5 * 60
export const MAX_AUTH_SESSION_TTL_SECONDS = 24 * 60 * 60
export const REMOTE_SESSION_COOKIE = '__Host-agent_chat_session'
export const LOOPBACK_SESSION_COOKIE = 'agent_chat_session'

const DEFAULT_BIND_HOST = '127.0.0.1'
const MIN_OPERATOR_TOKEN_BYTES = 32
const MAX_OPERATOR_TOKEN_CHARS = 128
const BASE64URL = /^[A-Za-z0-9_-]+$/

export type AuthConfigInput = Readonly<Record<string, string | undefined>>

export interface AuthConfig {
  mode: AuthMode
  bindHost: string
  /** Canonical URL.origin serialization, without a trailing slash. */
  publicOrigin: string | null
  /** Server-only bootstrap credential. Never put this object in a public payload or log. */
  operatorToken: string | null
  sessionTtlSeconds: number
  sessionCookieName: string | null
  secureCookie: boolean
}

export function isApprovedLoopbackHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function isApprovedLoopbackBindHost(value: string): boolean {
  const host = value.toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

export function parseAuthConfig(input: AuthConfigInput): AuthConfig {
  const mode = parseMode(input.AUTH_MODE)
  const bindHost = setting(input.HOST) ?? DEFAULT_BIND_HOST
  const sessionTtlSeconds = parseTtl(input.AUTH_SESSION_TTL_SECONDS)
  const token = input.AGENT_CHAT_OPERATOR_TOKEN
  const configuredOrigin = setting(input.PUBLIC_ORIGIN)

  if (mode === 'local') {
    if (!isApprovedLoopbackBindHost(bindHost)) {
      throw new Error('AUTH_MODE=local requires HOST to be an approved loopback value')
    }
    if (configuredOrigin !== undefined) {
      throw new Error('PUBLIC_ORIGIN is only valid when AUTH_MODE=session')
    }
    if (token !== undefined && token !== '') {
      throw new Error('AGENT_CHAT_OPERATOR_TOKEN is only valid when AUTH_MODE=session')
    }
    return {
      mode,
      bindHost,
      publicOrigin: null,
      operatorToken: null,
      sessionTtlSeconds,
      sessionCookieName: null,
      secureCookie: false,
    }
  }

  if (!validOperatorToken(token)) {
    throw new Error('AGENT_CHAT_OPERATOR_TOKEN must be unpadded base64url encoding of at least 32 random bytes')
  }
  if (configuredOrigin === undefined) throw new Error('PUBLIC_ORIGIN is required when AUTH_MODE=session')

  const origin = parseOrigin(configuredOrigin)
  const url = new URL(origin)
  const loopbackOrigin = isApprovedLoopbackHost(url.hostname)
  if (url.protocol === 'http:' && !(loopbackOrigin && isApprovedLoopbackBindHost(bindHost))) {
    throw new Error('PUBLIC_ORIGIN must use HTTPS unless both origin and HOST are approved loopback values')
  }

  return {
    mode,
    bindHost,
    publicOrigin: origin,
    operatorToken: token,
    sessionTtlSeconds,
    sessionCookieName: url.protocol === 'https:' ? REMOTE_SESSION_COOKIE : LOOPBACK_SESSION_COOKIE,
    secureCookie: url.protocol === 'https:',
  }
}

function parseMode(value: string | undefined): AuthMode {
  const mode = setting(value) ?? 'local'
  if ((AUTH_MODES as readonly string[]).includes(mode)) return mode as AuthMode
  throw new Error(`AUTH_MODE must be one of ${AUTH_MODES.join(', ')}`)
}

function parseTtl(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_AUTH_SESSION_TTL_SECONDS
  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) throw new Error('AUTH_SESSION_TTL_SECONDS must be an integer')
  const ttl = Number(normalized)
  if (ttl < MIN_AUTH_SESSION_TTL_SECONDS || ttl > MAX_AUTH_SESSION_TTL_SECONDS) {
    throw new Error(
      `AUTH_SESSION_TTL_SECONDS must be between ${MIN_AUTH_SESSION_TTL_SECONDS} and ${MAX_AUTH_SESSION_TTL_SECONDS}`,
    )
  }
  return ttl
}

function validOperatorToken(value: string | undefined): value is string {
  if (value === undefined || value.length > MAX_OPERATOR_TOKEN_CHARS || !BASE64URL.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength >= MIN_OPERATOR_TOKEN_BYTES && decoded.toString('base64url') === value
}

function parseOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid HTTP(S) origin')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_ORIGIN must be a valid HTTP(S) origin')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin === 'null') {
    throw new Error('PUBLIC_ORIGIN must contain only scheme, host and optional port')
  }
  return url.origin
}

function setting(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}
