import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createAuthService, type AuthRuntime } from '../server/auth.js'
import {
  DEFAULT_AUTH_SESSION_TTL_SECONDS,
  LOOPBACK_SESSION_COOKIE,
  REMOTE_SESSION_COOKIE,
  parseAuthConfig,
} from '../server/auth-config.js'

const OPERATOR_TOKEN = Buffer.alloc(32, 0x41).toString('base64url')
const WRONG_TOKEN = Buffer.alloc(32, 0x42).toString('base64url')

class FakeRuntime implements AuthRuntime {
  nowMs = Date.parse('2026-09-08T12:00:00.000Z')
  private nextTimer = 1
  private nextRandom = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now = () => this.nowMs

  randomBytes = (size: number): Uint8Array => Buffer.alloc(size, this.nextRandom++)

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextTimer++
    this.timers.set(id, { at: this.nowMs + delayMs, callback })
    return id
  }

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number)
  }

  advance(ms: number): void {
    this.nowMs += ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.nowMs)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) return
      this.timers.delete(due[0])
      due[1].callback()
    }
  }

  pendingTimers(): number {
    return this.timers.size
  }
}

const httpsConfig = (extra: Record<string, string> = {}) =>
  parseAuthConfig({
    AUTH_MODE: 'session',
    HOST: '0.0.0.0',
    PUBLIC_ORIGIN: 'https://console.example',
    AGENT_CHAT_OPERATOR_TOKEN: OPERATOR_TOKEN,
    ...extra,
  })

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]
}

function issuedCookie(result: ReturnType<ReturnType<typeof createAuthService>['issueSession']>): string {
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('session was not issued')
  return cookiePair(result.setCookie)
}

test('auth config defaults to explicit loopback-only local mode', () => {
  const config = parseAuthConfig({})
  assert.deepEqual(config, {
    mode: 'local',
    bindHost: '127.0.0.1',
    publicOrigin: null,
    operatorToken: null,
    sessionTtlSeconds: DEFAULT_AUTH_SESSION_TTL_SECONDS,
    sessionCookieName: null,
    secureCookie: false,
  })

  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    assert.equal(parseAuthConfig({ HOST: host }).bindHost, host)
  }
  for (const host of ['0.0.0.0', '::', '[::1]', '192.168.1.20', 'console.example', '127.0.0.2']) {
    assert.throws(() => parseAuthConfig({ HOST: host }), /approved loopback/)
  }
})

test('local mode rejects misleading session-only settings', () => {
  assert.throws(() => parseAuthConfig({ PUBLIC_ORIGIN: 'http://localhost:8787' }), /PUBLIC_ORIGIN/)
  assert.throws(() => parseAuthConfig({ AGENT_CHAT_OPERATOR_TOKEN: OPERATOR_TOKEN }), /AGENT_CHAT_OPERATOR_TOKEN/)
  assert.throws(() => parseAuthConfig({ AUTH_MODE: 'unknown' }), /AUTH_MODE/)
})

test('session config validates exact origins, token encoding and bounded absolute TTL', () => {
  const config = httpsConfig({ PUBLIC_ORIGIN: 'https://Console.Example:443', AUTH_SESSION_TTL_SECONDS: '300' })
  assert.equal(config.publicOrigin, 'https://console.example')
  assert.equal(config.sessionCookieName, REMOTE_SESSION_COOKIE)
  assert.equal(config.secureCookie, true)
  assert.equal(config.sessionTtlSeconds, 300)

  const loopback = parseAuthConfig({
    AUTH_MODE: 'session',
    HOST: '::1',
    PUBLIC_ORIGIN: 'http://[::1]:8787',
    AGENT_CHAT_OPERATOR_TOKEN: OPERATOR_TOKEN,
  })
  assert.equal(loopback.sessionCookieName, LOOPBACK_SESSION_COOKIE)
  assert.equal(loopback.secureCookie, false)

  assert.throws(() => httpsConfig({ PUBLIC_ORIGIN: 'http://console.example' }), /HTTPS/)
  assert.throws(() => httpsConfig({ PUBLIC_ORIGIN: 'ftp://console.example' }), /HTTP\(S\)/)
  for (const origin of [
    'https://user@console.example',
    'https://console.example/path',
    'https://console.example?query=1',
    'https://console.example#fragment',
    'not an origin',
  ]) {
    assert.throws(() => httpsConfig({ PUBLIC_ORIGIN: origin }), /PUBLIC_ORIGIN/)
  }
  for (const ttl of ['299', '86401', '3.5', '-300', 'word']) {
    assert.throws(() => httpsConfig({ AUTH_SESSION_TTL_SECONDS: ttl }), /AUTH_SESSION_TTL_SECONDS/)
  }
})

test('invalid operator keys are rejected without appearing in errors', () => {
  const invalid = 'not+base64url/and-secret'
  for (const token of ['', 'A'.repeat(42), invalid, `${OPERATOR_TOKEN}=`, 'A'.repeat(129)]) {
    let message = ''
    assert.throws(
      () => httpsConfig({ AGENT_CHAT_OPERATOR_TOKEN: token }),
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error)
        return true
      },
    )
    if (token) assert.equal(message.includes(token), false)
    assert.match(message, /AGENT_CHAT_OPERATOR_TOKEN/)
  }
})

test('local service grants only an implicit local principal and creates no session state', () => {
  const runtime = new FakeRuntime()
  const service = createAuthService(parseAuthConfig({}), { runtime })
  assert.deepEqual(service.status(), { mode: 'local', authenticated: true, expiresAt: null })
  assert.deepEqual(service.authenticate(), { ok: true, principal: { kind: 'local', expiresAt: null } })
  assert.deepEqual(service.issueSession(`Bearer ${OPERATOR_TOKEN}`), { ok: false, code: 'not_enabled' })
  assert.equal(service.clearSessionCookie(), null)
  assert.equal(service.activeSessionCount(), 0)
  assert.equal(runtime.pendingTimers(), 0)
})

test('HTTPS sessions are unique, fixation-resistant and carry strict cookie attributes', () => {
  const runtime = new FakeRuntime()
  const service = createAuthService(httpsConfig(), { runtime })
  const first = service.issueSession(`Bearer ${OPERATOR_TOKEN}`)
  const second = service.issueSession(`Bearer ${OPERATOR_TOKEN}`)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return

  assert.notEqual(cookiePair(first.setCookie), cookiePair(second.setCookie))
  assert.equal(first.setCookie.includes(OPERATOR_TOKEN), false)
  assert.match(first.setCookie, /^__Host-agent_chat_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800$/)
  assert.equal(first.setCookie.includes('Domain='), false)
  assert.deepEqual(first.status, {
    mode: 'session',
    authenticated: true,
    expiresAt: '2026-09-08T20:00:00.000Z',
  })
  assert.equal(service.activeSessionCount(), 2)
  assert.equal(runtime.pendingTimers(), 2)
})

test('loopback HTTP session fixture uses the non-Secure alternate cookie only', () => {
  const config = parseAuthConfig({
    AUTH_MODE: 'session',
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: 'http://127.0.0.1:8787',
    AGENT_CHAT_OPERATOR_TOKEN: OPERATOR_TOKEN,
  })
  const result = createAuthService(config, { runtime: new FakeRuntime() }).issueSession(`Bearer ${OPERATOR_TOKEN}`)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.match(result.setCookie, /^agent_chat_session=/)
  assert.equal(result.setCookie.includes('; Secure'), false)
  assert.equal(result.setCookie.includes('Domain='), false)
})

test('cookie and bearer authentication reject malformed, duplicate and ambiguous credentials', () => {
  const service = createAuthService(httpsConfig(), { runtime: new FakeRuntime() })
  const cookie = issuedCookie(service.issueSession(`Bearer ${OPERATOR_TOKEN}`))

  const session = service.authenticate({ cookie: `theme=dark; ${cookie}` })
  assert.equal(session.ok, true)
  if (session.ok) assert.equal(session.principal.kind, 'session')

  const bearer = service.authenticate({ authorization: `Bearer ${OPERATOR_TOKEN}` })
  assert.equal(bearer.ok, true)
  if (bearer.ok) assert.deepEqual(bearer.principal, { kind: 'bearer', expiresAt: null })

  for (const credentials of [
    { authorization: `Bearer ${WRONG_TOKEN}` },
    { authorization: `Basic ${OPERATOR_TOKEN}` },
    { authorization: [`Bearer ${OPERATOR_TOKEN}`, `Bearer ${WRONG_TOKEN}`] },
    { authorization: `Bearer ${'A'.repeat(513)}` },
    { cookie: `${cookie}; ${cookie}` },
    { cookie: `broken; ${cookie}` },
    { cookie: `${REMOTE_SESSION_COOKIE}=short` },
    { cookie: [`${cookie}`, `${cookie}`] },
    { cookie: `filler=${'x'.repeat(4096)}; ${cookie}` },
    { cookie, authorization: `Bearer ${OPERATOR_TOKEN}` },
  ]) {
    assert.deepEqual(service.authenticate(credentials), { ok: false })
  }
})

test('public status is generic and contains no operator or session credential', () => {
  const service = createAuthService(httpsConfig(), { runtime: new FakeRuntime() })
  const issue = service.issueSession(`Bearer ${OPERATOR_TOKEN}`)
  const cookie = issuedCookie(issue)
  const status = service.status({ cookie })
  const serialized = JSON.stringify(status)
  assert.deepEqual(status, {
    mode: 'session',
    authenticated: true,
    expiresAt: '2026-09-08T20:00:00.000Z',
  })
  assert.equal(serialized.includes(OPERATOR_TOKEN), false)
  assert.equal(serialized.includes(cookie.split('=')[1]), false)
  assert.deepEqual(service.status({ authorization: `Bearer ${WRONG_TOKEN}` }), {
    mode: 'session',
    authenticated: false,
    expiresAt: null,
  })
})

test('login throttling and session capacity remain fixed-size under denied attempts', () => {
  const throttleRuntime = new FakeRuntime()
  const throttled = createAuthService(httpsConfig(), {
    runtime: throttleRuntime,
    loginBurst: 2,
    loginRefillMs: 1000,
  })
  assert.deepEqual(throttled.issueSession(`Bearer ${WRONG_TOKEN}`), { ok: false, code: 'denied' })
  assert.deepEqual(throttled.issueSession(`Bearer ${WRONG_TOKEN}`), { ok: false, code: 'denied' })
  assert.deepEqual(throttled.issueSession(`Bearer ${WRONG_TOKEN}`), {
    ok: false,
    code: 'rate_limited',
    retryAfterSeconds: 1,
  })
  assert.equal(throttled.activeSessionCount(), 0)
  assert.equal(throttleRuntime.pendingTimers(), 0)
  throttleRuntime.advance(1000)
  assert.equal(throttled.issueSession(`Bearer ${OPERATOR_TOKEN}`).ok, true)

  const capacityRuntime = new FakeRuntime()
  const capacity = createAuthService(httpsConfig(), {
    runtime: capacityRuntime,
    maxSessions: 2,
    loginBurst: 10,
  })
  assert.equal(capacity.issueSession(`Bearer ${OPERATOR_TOKEN}`).ok, true)
  assert.equal(capacity.issueSession(`Bearer ${OPERATOR_TOKEN}`).ok, true)
  assert.deepEqual(capacity.issueSession(`Bearer ${OPERATOR_TOKEN}`), { ok: false, code: 'capacity' })
  assert.equal(capacity.activeSessionCount(), 2)
  assert.equal(capacityRuntime.pendingTimers(), 2)
})

test('absolute expiry closes every listener once and removes timer/session state', () => {
  const runtime = new FakeRuntime()
  const service = createAuthService(httpsConfig({ AUTH_SESSION_TTL_SECONDS: '300' }), { runtime })
  const cookie = issuedCookie(service.issueSession(`Bearer ${OPERATOR_TOKEN}`))
  const authenticated = service.authenticate({ cookie })
  assert.equal(authenticated.ok, true)
  if (!authenticated.ok) return

  let firstClosed = 0
  let secondClosed = 0
  service.onInvalidated(authenticated.principal, () => { firstClosed += 1 })
  service.onInvalidated(authenticated.principal, () => { secondClosed += 1 })
  runtime.advance(299_999)
  assert.equal(firstClosed, 0)
  assert.equal(service.authenticate({ cookie }).ok, true)
  runtime.advance(1)
  assert.equal(firstClosed, 1)
  assert.equal(secondClosed, 1)
  assert.deepEqual(service.authenticate({ cookie }), { ok: false })
  assert.equal(service.activeSessionCount(), 0)
  assert.equal(runtime.pendingTimers(), 0)
})

test('listener cleanup is idempotent and prevents a later close callback', () => {
  const runtime = new FakeRuntime()
  const service = createAuthService(httpsConfig(), { runtime })
  const cookie = issuedCookie(service.issueSession(`Bearer ${OPERATOR_TOKEN}`))
  const authenticated = service.authenticate({ cookie })
  assert.equal(authenticated.ok, true)
  if (!authenticated.ok) return
  let closed = 0
  const unsubscribe = service.onInvalidated(authenticated.principal, () => { closed += 1 })
  unsubscribe()
  unsubscribe()
  assert.equal(service.revoke(authenticated.principal), true)
  assert.equal(closed, 0)
  assert.equal(runtime.pendingTimers(), 0)
})

test('individual revocation preserves independent sessions and dispose closes the rest', () => {
  const runtime = new FakeRuntime()
  const service = createAuthService(httpsConfig(), { runtime, loginBurst: 10 })
  const firstCookie = issuedCookie(service.issueSession(`Bearer ${OPERATOR_TOKEN}`))
  const secondCookie = issuedCookie(service.issueSession(`Bearer ${OPERATOR_TOKEN}`))
  const first = service.authenticate({ cookie: firstCookie })
  const second = service.authenticate({ cookie: secondCookie })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return

  let firstClosed = 0
  let secondClosed = 0
  service.onInvalidated(first.principal, () => { firstClosed += 1 })
  service.onInvalidated(second.principal, () => { secondClosed += 1 })
  assert.equal(service.revoke(first.principal), true)
  assert.equal(service.revoke(first.principal), false)
  assert.equal(firstClosed, 1)
  assert.equal(secondClosed, 0)
  assert.deepEqual(service.authenticate({ cookie: firstCookie }), { ok: false })
  assert.equal(service.authenticate({ cookie: secondCookie }).ok, true)

  service.dispose()
  service.dispose()
  assert.equal(secondClosed, 1)
  assert.equal(service.activeSessionCount(), 0)
  assert.equal(runtime.pendingTimers(), 0)
  assert.deepEqual(service.authenticate({ cookie: secondCookie }), { ok: false })
  assert.deepEqual(service.issueSession(`Bearer ${OPERATOR_TOKEN}`), { ok: false, code: 'unavailable' })
})

test('a fresh service instance cannot authenticate a session from an earlier process', () => {
  const config = httpsConfig()
  const first = createAuthService(config, { runtime: new FakeRuntime() })
  const oldCookie = issuedCookie(first.issueSession(`Bearer ${OPERATOR_TOKEN}`))
  const restarted = createAuthService(config, { runtime: new FakeRuntime() })
  assert.deepEqual(restarted.authenticate({ cookie: oldCookie }), { ok: false })
})

test('clear-cookie output mirrors strict attributes without exposing a credential', () => {
  const service = createAuthService(httpsConfig(), { runtime: new FakeRuntime() })
  assert.equal(
    service.clearSessionCookie(),
    '__Host-agent_chat_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0',
  )
})
