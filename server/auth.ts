import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AuthCredentialKind, AuthStatusPayload } from '../shared/auth.js'
import type { AuthConfig } from './auth-config.js'

const SESSION_BYTES = 32
const SESSION_TOKEN_CHARS = 43
const MAX_AUTHORIZATION_CHARS = 512
const MAX_COOKIE_HEADER_CHARS = 4096
const DEFAULT_MAX_SESSIONS = 16
const DEFAULT_LOGIN_BURST = 5
const DEFAULT_LOGIN_REFILL_MS = 12_000
const BASE64URL = /^[A-Za-z0-9_-]+$/
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export type AuthHeaderValue = string | readonly string[] | undefined

export interface AuthRequestCredentials {
  authorization?: AuthHeaderValue
  cookie?: AuthHeaderValue
}

export interface AuthPrincipal {
  readonly kind: AuthCredentialKind
  readonly expiresAt: number | null
}

export type AuthenticationResult = { ok: true; principal: AuthPrincipal } | { ok: false }

export type SessionIssueFailure =
  | { ok: false; code: 'denied' }
  | { ok: false; code: 'rate_limited'; retryAfterSeconds: number }
  | { ok: false; code: 'capacity' | 'unavailable' | 'not_enabled' }

export interface SessionIssueSuccess {
  ok: true
  setCookie: string
  status: AuthStatusPayload
}

export type SessionIssueResult = SessionIssueSuccess | SessionIssueFailure

type TimerHandle = unknown

export interface AuthRuntime {
  now(): number
  randomBytes(size: number): Uint8Array
  setTimer(callback: () => void, delayMs: number): TimerHandle
  clearTimer(handle: TimerHandle): void
}

export interface AuthServiceOptions {
  maxSessions?: number
  loginBurst?: number
  loginRefillMs?: number
  runtime?: Partial<AuthRuntime>
}

export interface AuthService {
  readonly mode: AuthConfig['mode']
  authenticate(credentials?: AuthRequestCredentials): AuthenticationResult
  status(credentials?: AuthRequestCredentials): AuthStatusPayload
  issueSession(authorization: AuthHeaderValue): SessionIssueResult
  clearSessionCookie(): string | null
  revoke(principal: AuthPrincipal): boolean
  onInvalidated(principal: AuthPrincipal, listener: () => void): () => void
  activeSessionCount(): number
  dispose(): void
}

interface SessionRecord {
  expiresAt: number
  listeners: Set<() => void>
  timer: TimerHandle
}

type ParsedCredential =
  | { state: 'none' | 'invalid' }
  | { state: 'value'; value: string }

const defaultRuntime: AuthRuntime = {
  now: Date.now,
  randomBytes,
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return timer
  },
  clearTimer(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export function createAuthService(config: AuthConfig, options: AuthServiceOptions = {}): AuthService {
  const runtime: AuthRuntime = { ...defaultRuntime, ...options.runtime }
  const maxSessions = positiveInteger(options.maxSessions, DEFAULT_MAX_SESSIONS, 'maxSessions')
  const loginBurst = positiveInteger(options.loginBurst, DEFAULT_LOGIN_BURST, 'loginBurst')
  const loginRefillMs = positiveInteger(options.loginRefillMs, DEFAULT_LOGIN_REFILL_MS, 'loginRefillMs')
  const mode = config.mode
  const sessionTtlMs = config.sessionTtlSeconds * 1000
  const cookieName = config.sessionCookieName
  const secureCookie = config.secureCookie
  const operatorDigest = config.operatorToken === null ? null : digest(config.operatorToken)
  const sessions = new Map<string, SessionRecord>()
  const principalHandles = new WeakMap<AuthPrincipal, string>()
  const localPrincipal: AuthPrincipal = Object.freeze({ kind: 'local', expiresAt: null })
  const bearerPrincipal: AuthPrincipal = Object.freeze({ kind: 'bearer', expiresAt: null })
  const serviceListeners = new Set<() => void>()
  let disposed = false
  let loginTokens = loginBurst
  let loginUpdatedAt = runtime.now()

  const invalidate = (key: string): boolean => {
    const record = sessions.get(key)
    if (!record) return false
    sessions.delete(key)
    runtime.clearTimer(record.timer)
    notifyListeners(record.listeners)
    return true
  }

  const purgeExpired = (): void => {
    const now = runtime.now()
    for (const [key, record] of sessions) {
      if (record.expiresAt <= now) invalidate(key)
    }
  }

  const principalFor = (key: string, expiresAt: number): AuthPrincipal => {
    const principal: AuthPrincipal = Object.freeze({ kind: 'session', expiresAt })
    principalHandles.set(principal, key)
    return principal
  }

  const validBearer = (value: string): boolean => {
    if (operatorDigest === null) return false
    const candidate = digest(value)
    return timingSafeEqual(candidate, operatorDigest)
  }

  const authenticate = (credentials: AuthRequestCredentials = {}): AuthenticationResult => {
    if (disposed) return { ok: false }
    if (mode === 'local') return { ok: true, principal: localPrincipal }

    const bearer = parseBearer(credentials.authorization)
    const session = parseSessionCookie(credentials.cookie, cookieName)
    if (bearer.state === 'invalid' || session.state === 'invalid') return { ok: false }
    if (bearer.state === 'value' && session.state === 'value') return { ok: false }

    if (session.state === 'value') {
      const key = digestKey(session.value)
      const record = sessions.get(key)
      if (!record) return { ok: false }
      if (record.expiresAt <= runtime.now()) {
        invalidate(key)
        return { ok: false }
      }
      return { ok: true, principal: principalFor(key, record.expiresAt) }
    }

    if (bearer.state === 'value' && validBearer(bearer.value)) {
      return { ok: true, principal: bearerPrincipal }
    }
    return { ok: false }
  }

  const takeLoginToken = (): number | null => {
    const now = Math.max(runtime.now(), loginUpdatedAt)
    const elapsed = now - loginUpdatedAt
    loginTokens = Math.min(loginBurst, loginTokens + elapsed / loginRefillMs)
    loginUpdatedAt = now
    if (loginTokens < 1) return Math.max(1, Math.ceil(((1 - loginTokens) * loginRefillMs) / 1000))
    loginTokens -= 1
    return null
  }

  return {
    mode,

    authenticate,

    status(credentials = {}) {
      const result = authenticate(credentials)
      return statusPayload(mode, result)
    },

    issueSession(authorization) {
      if (disposed) return { ok: false, code: 'unavailable' }
      if (mode !== 'session' || operatorDigest === null || cookieName === null) {
        return { ok: false, code: 'not_enabled' }
      }
      const retryAfterSeconds = takeLoginToken()
      if (retryAfterSeconds !== null) return { ok: false, code: 'rate_limited', retryAfterSeconds }

      const bearer = parseBearer(authorization)
      if (bearer.state !== 'value' || !validBearer(bearer.value)) return { ok: false, code: 'denied' }

      purgeExpired()
      if (sessions.size >= maxSessions) return { ok: false, code: 'capacity' }

      let token = ''
      let key = ''
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const bytes = runtime.randomBytes(SESSION_BYTES)
        if (bytes.byteLength !== SESSION_BYTES) throw new Error('auth random source returned the wrong number of bytes')
        token = Buffer.from(bytes).toString('base64url')
        key = digestKey(token)
        if (!sessions.has(key)) break
        token = ''
      }
      if (!token) throw new Error('auth random source repeatedly produced an existing session identifier')

      const expiresAt = runtime.now() + sessionTtlMs
      const record: SessionRecord = {
        expiresAt,
        listeners: new Set(),
        timer: undefined,
      }
      sessions.set(key, record)
      try {
        record.timer = runtime.setTimer(() => invalidate(key), sessionTtlMs)
      } catch (error) {
        sessions.delete(key)
        throw error
      }

      return {
        ok: true,
        setCookie: sessionCookie(cookieName, token, config.sessionTtlSeconds, secureCookie),
        status: { mode, authenticated: true, expiresAt: new Date(expiresAt).toISOString() },
      }
    },

    clearSessionCookie() {
      return cookieName === null ? null : sessionCookie(cookieName, '', 0, secureCookie)
    },

    revoke(principal) {
      if (principal.kind !== 'session') return false
      const key = principalHandles.get(principal)
      return key === undefined ? false : invalidate(key)
    },

    onInvalidated(principal, listener) {
      if (disposed) {
        notifyListener(listener)
        return () => undefined
      }

      const validServicePrincipal =
        (mode === 'local' && principal === localPrincipal) ||
        (mode === 'session' && principal === bearerPrincipal)
      if (validServicePrincipal) return subscribe(serviceListeners, listener)
      if (principal.kind !== 'session') return () => undefined

      const key = principalHandles.get(principal)
      const record = key === undefined ? undefined : sessions.get(key)
      if (!record || record.expiresAt <= runtime.now()) {
        if (key !== undefined) invalidate(key)
        notifyListener(listener)
        return () => undefined
      }
      return subscribe(record.listeners, listener)
    },

    activeSessionCount() {
      purgeExpired()
      return sessions.size
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const key of [...sessions.keys()]) invalidate(key)
      notifyListeners(serviceListeners)
    },
  }
}

function subscribe(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(listener)
  }
}

function notifyListeners(listeners: Set<() => void>): void {
  const pending = [...listeners]
  listeners.clear()
  for (const listener of pending) notifyListener(listener)
}

function notifyListener(listener: () => void): void {
  try {
    listener()
  } catch {
    // One stream cleanup must not prevent other listeners or disposal cleanup.
  }
}

function statusPayload(mode: AuthConfig['mode'], result: AuthenticationResult): AuthStatusPayload {
  if (!result.ok) return { mode, authenticated: false, expiresAt: null }
  return {
    mode,
    authenticated: true,
    expiresAt: result.principal.expiresAt === null ? null : new Date(result.principal.expiresAt).toISOString(),
  }
}

function parseBearer(header: AuthHeaderValue): ParsedCredential {
  if (header === undefined) return { state: 'none' }
  if (typeof header !== 'string' || header.length > MAX_AUTHORIZATION_CHARS) return { state: 'invalid' }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(header)
  if (!match || match[1].length > 128 || !validBase64Url(match[1], 32)) return { state: 'invalid' }
  return { state: 'value', value: match[1] }
}

function parseSessionCookie(header: AuthHeaderValue, targetName: string | null): ParsedCredential {
  if (header === undefined || targetName === null) return { state: 'none' }
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER_CHARS || /[\u0000-\u001f\u007f]/.test(header)) {
    return { state: 'invalid' }
  }

  let found: string | null = null
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim()
    const equals = part.indexOf('=')
    if (!part || equals <= 0) return { state: 'invalid' }
    const name = part.slice(0, equals)
    const value = part.slice(equals + 1)
    if (!COOKIE_NAME.test(name)) return { state: 'invalid' }
    if (name !== targetName) continue
    if (found !== null || value.length !== SESSION_TOKEN_CHARS || !validBase64Url(value, SESSION_BYTES)) {
      return { state: 'invalid' }
    }
    found = value
  }
  return found === null ? { state: 'none' } : { state: 'value', value: found }
}

function validBase64Url(value: string, minimumBytes: number): boolean {
  if (!BASE64URL.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength >= minimumBytes && decoded.toString('base64url') === value
}

function sessionCookie(name: string, value: string, maxAge: number, secure: boolean): string {
  const attributes = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (secure) attributes.push('Secure')
  attributes.push(`Max-Age=${maxAge}`)
  return attributes.join('; ')
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function digestKey(value: string): string {
  return digest(value).toString('hex')
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected <= 0) throw new Error(`${name} must be a positive integer`)
  return selected
}
