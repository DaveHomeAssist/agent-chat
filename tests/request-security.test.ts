import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { parseAuthConfig, type AuthConfig } from '../server/auth-config.js'
import {
  evaluateRequestSecurity,
  type RequestPolicy,
  type RequestSecurityInput,
} from '../server/request-security.js'

const OPERATOR_TOKEN = Buffer.alloc(32, 0x55).toString('base64url')
const local = parseAuthConfig({})
const remote = parseAuthConfig({
  AUTH_MODE: 'session',
  HOST: '0.0.0.0',
  PUBLIC_ORIGIN: 'https://console.example:9443',
  AGENT_CHAT_OPERATOR_TOKEN: OPERATOR_TOKEN,
})

function check(
  config: AuthConfig,
  policy: RequestPolicy,
  input: Partial<RequestSecurityInput> = {},
) {
  return evaluateRequestSecurity(config, policy, {
    host: config.mode === 'local' ? '127.0.0.1:8787' : 'console.example:9443',
    credentialKind: config.mode === 'local' ? 'local' : 'session',
    ...input,
  })
}

test('local mode accepts only approved loopback request hosts', () => {
  for (const host of ['127.0.0.1:8787', 'localhost:5173', '[::1]:8787', 'LOCALHOST:8787']) {
    assert.deepEqual(check(local, 'protected-read', { host }), { ok: true })
  }
  for (const host of ['192.168.1.2:8787', 'console.example', '127.0.0.2:8787', '', undefined, ['localhost']]) {
    assert.deepEqual(check(local, 'protected-read', { host }), { ok: false, reason: 'host' })
  }
})

test('local mutation compares exact scheme, host and port while allowing intended headerless curl', () => {
  assert.deepEqual(check(local, 'protected-mutation'), { ok: true })
  assert.deepEqual(check(local, 'protected-mutation', {
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
  }), { ok: true })
  assert.deepEqual(check(local, 'protected-mutation', {
    host: 'localhost:5173',
    origin: 'https://localhost:5173',
  }), { ok: false, reason: 'origin' })
  assert.deepEqual(check(local, 'protected-mutation', {
    host: 'localhost:5173',
    origin: 'http://localhost:8787',
  }), { ok: false, reason: 'origin' })
  assert.deepEqual(check(local, 'protected-mutation', {
    host: 'localhost:5173',
    origin: 'https://localhost:5173',
    encrypted: true,
  }), { ok: true })
})

test('session mode requires exact configured Host and Origin, including port and scheme', () => {
  assert.deepEqual(check(remote, 'protected-read'), { ok: true })
  assert.deepEqual(check(remote, 'protected-mutation', { origin: 'https://console.example:9443' }), { ok: true })
  for (const host of ['console.example', 'console.example:443', 'other.example:9443', '127.0.0.1:9443']) {
    assert.deepEqual(check(remote, 'protected-read', { host }), { ok: false, reason: 'host' })
  }
  for (const origin of [
    'http://console.example:9443',
    'https://console.example',
    'https://other.example:9443',
    'https://console.example:9443/',
    'null',
    ['https://console.example:9443'],
  ]) {
    assert.deepEqual(check(remote, 'protected-mutation', { origin }), { ok: false, reason: 'origin' })
  }
})

test('cross-site and malformed Fetch Metadata fail closed', () => {
  for (const secFetchSite of ['cross-site', 'unexpected', ['same-origin']]) {
    assert.deepEqual(check(remote, 'protected-mutation', {
      origin: 'https://console.example:9443',
      secFetchSite,
    }), { ok: false, reason: 'cross_site' })
  }
  for (const secFetchSite of ['same-origin', 'same-site', 'none']) {
    assert.deepEqual(check(remote, 'protected-mutation', {
      origin: 'https://console.example:9443',
      secFetchSite,
    }), { ok: true })
  }
})

test('cookie mutations require Origin while bearer CLI and local curl may omit browser headers', () => {
  assert.deepEqual(check(remote, 'protected-mutation', { credentialKind: 'session' }), {
    ok: false,
    reason: 'origin_required',
  })
  assert.deepEqual(check(remote, 'protected-mutation', { credentialKind: 'bearer' }), { ok: true })
  assert.deepEqual(check(local, 'protected-mutation', { credentialKind: 'local' }), { ok: true })
  assert.deepEqual(check(remote, 'protected-mutation', { credentialKind: null }), {
    ok: false,
    reason: 'credential',
  })
})

test('login and logout have explicit mode, credential and Origin policies', () => {
  assert.deepEqual(check(remote, 'login', { credentialKind: null }), { ok: true })
  assert.deepEqual(check(remote, 'login', {
    credentialKind: null,
    origin: 'https://console.example:9443',
  }), { ok: true })
  assert.deepEqual(check(remote, 'login', {
    credentialKind: null,
    origin: 'https://other.example:9443',
  }), { ok: false, reason: 'origin' })
  assert.deepEqual(check(remote, 'login', { credentialKind: 'session' }), {
    ok: false,
    reason: 'credential',
  })

  assert.deepEqual(check(remote, 'logout', {
    credentialKind: 'session',
    origin: 'https://console.example:9443',
  }), { ok: true })
  assert.deepEqual(check(remote, 'logout', { credentialKind: 'session' }), {
    ok: false,
    reason: 'origin_required',
  })
  assert.deepEqual(check(remote, 'logout', {
    credentialKind: null,
    origin: 'https://console.example:9443',
    secFetchSite: 'same-origin',
  }), { ok: true })
  assert.deepEqual(check(remote, 'logout', { credentialKind: 'bearer' }), { ok: true })
  assert.deepEqual(check(local, 'login', { credentialKind: null }), { ok: false, reason: 'mode' })
  assert.deepEqual(check(local, 'logout', { credentialKind: 'local' }), { ok: false, reason: 'mode' })
})

test('unauthenticated session logout requires exact same-origin browser request metadata', () => {
  assert.deepEqual(check(remote, 'logout', { credentialKind: null }), {
    ok: false,
    reason: 'origin_required',
  })
  for (const origin of ['null', 'https://other.example:9443', 'http://console.example:9443']) {
    assert.deepEqual(check(remote, 'logout', { credentialKind: null, origin }), {
      ok: false,
      reason: 'origin',
    })
  }
  for (const secFetchSite of ['cross-site', 'unexpected', ['same-origin']]) {
    assert.deepEqual(check(remote, 'logout', {
      credentialKind: null,
      origin: 'https://console.example:9443',
      secFetchSite,
    }), { ok: false, reason: 'cross_site' })
  }
  assert.deepEqual(check(remote, 'logout', {
    host: 'other.example:9443',
    credentialKind: null,
    origin: 'https://console.example:9443',
    secFetchSite: 'same-origin',
  }), { ok: false, reason: 'host' })
})

test('auth status is public but still enforces Host and supplied Origin', () => {
  assert.deepEqual(check(remote, 'auth-status', { credentialKind: null }), { ok: true })
  assert.deepEqual(check(remote, 'auth-status', {
    credentialKind: null,
    origin: 'https://other.example:9443',
  }), { ok: false, reason: 'origin' })
  assert.deepEqual(check(remote, 'auth-status', {
    credentialKind: null,
    host: 'other.example:9443',
  }), { ok: false, reason: 'host' })
})

test('protected reads and mutations require the mode-appropriate authenticated principal', () => {
  for (const policy of ['protected-read', 'protected-mutation'] as const) {
    assert.deepEqual(check(local, policy, { credentialKind: 'bearer' }), { ok: false, reason: 'credential' })
    assert.deepEqual(check(remote, policy, {
      credentialKind: 'local',
      origin: policy === 'protected-mutation' ? 'https://console.example:9443' : undefined,
    }), { ok: false, reason: 'credential' })
  }
})

test('forwarded headers cannot repair an invalid direct Host or Origin', () => {
  const forwarded = {
    host: 'attacker.example:9443',
    origin: 'https://attacker.example:9443',
    credentialKind: 'session' as const,
    xForwardedHost: 'console.example:9443',
    xForwardedProto: 'https',
    forwarded: 'host=console.example:9443;proto=https',
  }
  assert.deepEqual(evaluateRequestSecurity(remote, 'protected-mutation', forwarded), {
    ok: false,
    reason: 'host',
  })
})

test('missing, duplicate and malformed security headers fail without echoing values', () => {
  const cases: Array<[Partial<RequestSecurityInput>, string]> = [
    [{ host: undefined }, 'host'],
    [{ host: ['console.example:9443'] }, 'host'],
    [{ host: 'user@console.example:9443' }, 'host'],
    [{ origin: 'https://user@console.example:9443' }, 'origin'],
    [{ origin: 'https://console.example:9443/path' }, 'origin'],
  ]
  for (const [input, reason] of cases) {
    assert.deepEqual(check(remote, 'protected-read', input), { ok: false, reason })
  }
})
