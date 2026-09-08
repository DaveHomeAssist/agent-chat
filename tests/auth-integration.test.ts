import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import type { AuthServiceOptions } from '../server/auth.js'
import { loadConfig } from '../server/config.js'
import { createServer } from '../server/http.js'
import { API } from '../shared/protocol.js'
import { harness, reply } from './helpers.js'

const TOKEN = Buffer.alloc(32, 65).toString('base64url')
const WRONG = Buffer.alloc(32, 66).toString('base64url')
const ORIGIN = 'https://console.example'
const AUTH = { Host: 'console.example', Authorization: `Bearer ${TOKEN}` }
const ENV = { AUTH_MODE: 'session', PUBLIC_ORIGIN: ORIGIN, AGENT_CHAT_OPERATOR_TOKEN: TOKEN }

function clock() {
  let now = Date.parse('2026-09-08T12:00:00Z')
  const timers = new Map<object, { at: number; callback: () => void }>()
  return {
    runtime: {
      now: () => now,
      setTimer: (callback: () => void, delay: number) => { const id = {}; timers.set(id, { at: now + delay, callback }); return id },
      clearTimer: (id: unknown) => { timers.delete(id as object) },
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
  }
}

async function serve(t: TestContext, options: { local?: boolean; authOptions?: AuthServiceOptions } = {}) {
  const h = harness(t, async () => reply(), { env: options.local ? {} : ENV, authOptions: options.authOptions })
  // Count subscribers to prove invalidation removes the store callback, not just the socket.
  let subscribers = 0
  const subscribe = h.store.subscribe.bind(h.store)
  h.store.subscribe = (listener) => {
    subscribers++
    const unsubscribe = subscribe(listener)
    let closed = false
    return () => { if (!closed) { closed = true; subscribers--; unsubscribe() } }
  }
  let authListeners = 0
  const onInvalidated = h.auth.onInvalidated.bind(h.auth)
  h.auth.onInvalidated = (principal, listener) => {
    authListeners++
    const unsubscribe = onInvalidated(principal, listener)
    let closed = false
    return () => { if (!closed) { closed = true; authListeners--; unsubscribe() } }
  }
  const server = createServer(h)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { h.auth.dispose(); const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  // Node fetch normalizes Host; raw HTTP is needed to exercise direct Host policy.
  const request = (path: string, init: { method?: string; headers?: Record<string, string | string[] | undefined>; body?: string } = {}) => new Promise<Response>((resolve, reject) => {
    const req = http.request(url + path, {
      method: init.method ?? 'GET',
      headers: { ...(options.local ? {} : { Host: 'console.example' }), ...init.headers },
    }, (res) => {
      const headers = new Headers()
      for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode, headers }))
    })
    req.on('error', reject)
    req.end(typeof init.body === 'string' ? init.body : undefined)
  })
  const login = async () => {
    const res = await request(API.login, { method: 'POST', headers: AUTH })
    assert.equal(res.status, 200)
    const cookie = res.headers.get('set-cookie')!
    return { cookie: cookie.split(';')[0], setCookie: cookie, body: await res.json() }
  }
  return { ...h, url, request, login, subscribers: () => subscribers, authListeners: () => authListeners }
}

test('loadConfig applies auth to the selected bind and rejects unsafe inputs before composition', () => {
  assert.equal(loadConfig({ MOCK_LLM: '1' }).auth.mode, 'local')
  assert.equal(loadConfig({ MOCK_LLM: '1' }).host, '127.0.0.1')
  for (const env of [
    { HOST: '0.0.0.0' }, { PUBLIC_ORIGIN: ORIGIN },
    { ...ENV, PUBLIC_ORIGIN: 'http://console.example' },
    { ...ENV, AGENT_CHAT_OPERATOR_TOKEN: 'synthetic-invalid-key' },
    { ...ENV, AUTH_MODE: 'local' },
  ]) {
    assert.throws(() => loadConfig({ MOCK_LLM: '1', ...env }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes(TOKEN) && !error.message.includes('synthetic-invalid-key'))
      return true
    })
  }
  const remote = loadConfig({ MOCK_LLM: '1', ...ENV, HOST: '0.0.0.0' })
  assert.equal(remote.host, remote.auth.bindHost)
  assert.equal(remote.auth.secureCookie, true)
  // Caller environment is the complete input; ambient auth settings do not leak in.
  const env = { MOCK_LLM: '1', HOST: '::1' }
  assert.equal(loadConfig(env).auth.bindHost, '::1')
  assert.deepEqual(env, { MOCK_LLM: '1', HOST: '::1' })
})

test('every API route and wrong method rejects anonymous/invalid credentials without effects or SSE headers', async (t) => {
  const h = await serve(t)
  const before = h.store.snapshot()
  const paths = [API.state, API.events, API.message, API.start, API.pause, API.resume, API.gate, API.approve, API.interrupt('forge'), '/api/unknown']
  for (const path of paths) for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH']) {
    const res = await h.request(path, { method, ...(method === 'POST' ? { body: '{invalid' } : {}) })
    assert.equal(res.status, 401, `${method} ${path}`)
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="Agent Chatroom"')
    assert.match(res.headers.get('content-type')!, /application\/json/)
    if (method !== 'HEAD') assert.deepEqual(await res.json(), { ok: false, error: 'authentication required' })
  }
  for (const headers of [{ Authorization: `Bearer ${WRONG}` }, { Cookie: '__Host-agent_chat_session=bad' }, { Authorization: [`Bearer ${TOKEN}`, `Bearer ${WRONG}`] }]) {
    assert.equal((await h.request(API.state, { headers })).status, 401)
  }
  assert.deepEqual(h.store.snapshot(), before)
  assert.equal(h.requests.length, 0)
  assert.equal(h.subscribers(), 0)
  assert.equal(h.authListeners(), 0)
  // The response arrives while an unfinished body is still withheld.
  await new Promise<void>((resolve, reject) => {
    const req = http.request(h.url + API.start, { method: 'POST', headers: { Host: 'console.example', 'Content-Length': 64000 } }, (res) => {
      assert.equal(res.statusCode, 401); res.resume(); req.destroy(); resolve()
    })
    req.setTimeout(1500, () => { req.destroy(); reject(new Error('Denied request waited for its body')) })
    req.on('error', reject)
    req.flushHeaders()
  })
})

test('public shell/status stay minimal; direct Host and exact Origin reject invalid reads and mutations', async (t) => {
  const h = await serve(t)
  assert.equal((await h.request('/')).status, 200)
  const status = await h.request(API.authStatus)
  assert.deepEqual(await status.json(), { mode: 'session', authenticated: false, expiresAt: null })
  for (const path of [API.authStatus, API.login, API.logout, API.state, API.events, API.pause]) {
    for (const extra of [{ Host: 'attacker.example' }, { Origin: 'https://other.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const res = await h.request(path, { method: ([API.authStatus, API.state, API.events] as string[]).includes(path) ? 'GET' : 'POST', headers: { ...AUTH, ...extra } })
      assert.equal(res.status, 403, path)
      assert.deepEqual(await res.json(), { ok: false, error: 'request forbidden' })
    }
  }
  const session = await h.login()
  assert.match(session.setCookie, /^__Host-agent_chat_session=/)
  for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Max-Age=28800']) assert.ok(session.setCookie.includes(flag))
  assert.ok(!session.setCookie.includes('Domain='))
  assert.equal((await h.request(API.state, { headers: { Cookie: session.cookie } })).status, 200)
  assert.equal((await h.request(API.pause, { method: 'POST', headers: { Cookie: session.cookie } })).status, 403)
  assert.equal((await h.request(API.pause, { method: 'POST', headers: { Cookie: session.cookie, Origin: ORIGIN } })).status, 200)
  assert.equal((await h.request(API.pause, { method: 'POST', headers: AUTH })).status, 200)
  assert.equal((await h.request(API.state, { headers: { ...AUTH, Cookie: session.cookie } })).status, 401)
  assert.equal((await h.request(API.start, { headers: AUTH })).status, 405)
  assert.equal((await h.request(API.message, { method: 'POST', headers: AUTH, body: '{}' })).status, 415)
  assert.equal((await h.request(API.start, { method: 'POST', headers: AUTH, body: '{' })).status, 400)
  assert.equal((await h.request(API.start, { method: 'POST', headers: AUTH, body: 'x'.repeat(65537) })).status, 413)
})

test('login denial, throttling and capacity are bounded generic responses', async (t) => {
  const time = clock()
  const h = await serve(t, { authOptions: { maxSessions: 1, runtime: time.runtime } })
  for (let i = 0; i < 5; i++) {
    const denied = await h.request(API.login, { method: 'POST', headers: { Authorization: `Bearer ${WRONG}` } })
    assert.equal(denied.status, 401)
    assert.ok(denied.headers.has('www-authenticate'))
    assert.equal((await denied.text()).includes(WRONG), false)
  }
  const limited = await h.request(API.login, { method: 'POST', headers: AUTH })
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '12')
  time.advance(60000)
  await h.login()
  const full = await h.request(API.login, { method: 'POST', headers: AUTH })
  assert.equal(full.status, 503)
  assert.deepEqual(await full.json(), { ok: false, error: 'authentication unavailable' })
  h.auth.dispose()
  assert.equal((await h.request(API.login, { method: 'POST', headers: AUTH })).status, 503)
})

async function openStream(h: Awaited<ReturnType<typeof serve>>, headers: Record<string, string>) {
  const response = await h.request(API.events, { headers })
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /event: snapshot/)
  return reader
}

async function ended(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const timeout = AbortSignal.timeout(2000)
  while (true) {
    const read = await Promise.race([reader.read(), new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('SSE remained open')), { once: true }))])
    if (read.done) return
  }
}

test('logout, expiry, disposal and a fresh service close/reject sessions and remove SSE callbacks', async (t) => {
  const time = clock()
  const h = await serve(t, { authOptions: { runtime: time.runtime } })
  const first = await h.login()
  const stream = await openStream(h, { Cookie: first.cookie })
  assert.equal(h.subscribers(), 1)
  const logout = await h.request(API.logout, { method: 'POST', headers: { Cookie: first.cookie, Origin: ORIGIN } })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/)
  await ended(stream)
  assert.equal(h.subscribers(), 0)
  assert.equal(h.authListeners(), 0)
  assert.equal((await h.request(API.events, { headers: { Cookie: first.cookie } })).status, 401)
  for (const cookie of [undefined, first.cookie]) {
    assert.equal((await h.request(API.logout, { method: 'POST', headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } })).status, 200)
  }
  assert.equal((await h.request(API.logout, { method: 'POST' })).status, 403)
  const second = await h.login()
  const expiring = await openStream(h, { Cookie: second.cookie })
  time.advance(28800000)
  await ended(expiring)
  assert.equal(h.subscribers(), 0)
  assert.equal(h.authListeners(), 0)
  assert.equal((await h.request(API.state, { headers: { Cookie: second.cookie } })).status, 401)
  const third = await h.login()
  const sessionStream = await openStream(h, { Cookie: third.cookie })
  const bearerStream = await openStream(h, AUTH)
  h.auth.dispose()
  await Promise.all([ended(sessionStream), ended(bearerStream)])
  assert.equal(h.subscribers(), 0)
  assert.equal(h.authListeners(), 0)
  assert.equal((await h.request(API.events, { headers: AUTH })).status, 401)
  const restarted = await serve(t)
  assert.equal((await restarted.request(API.state, { headers: { Cookie: third.cookie } })).status, 401)
  await restarted.login()
})

test('local default is loopback-only and disposal closes local SSE', async (t) => {
  const h = await serve(t, { local: true })
  assert.deepEqual(await (await h.request(API.authStatus)).json(), { mode: 'local', authenticated: true, expiresAt: null })
  assert.equal((await h.request(API.state, { headers: { Host: 'remote.example' } })).status, 403)
  assert.equal((await h.request(API.events, { headers: { Host: 'remote.example' } })).status, 403)
  const stream = await openStream(h, {})
  h.auth.dispose()
  await ended(stream)
  assert.equal(h.subscribers(), 0)
  assert.equal(h.authListeners(), 0)
})

test('credentials never appear in public state/events/status, query logs or error logs', async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args) })
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  const h = await serve(t)
  const session = await h.login()
  const status = await (await h.request(API.authStatus, { headers: { Cookie: session.cookie } })).text()
  const state = await (await h.request(API.state + `?token=${TOKEN}`, { headers: AUTH })).text()
  const events = await h.request(API.events, { headers: AUTH })
  const reader = events.body!.getReader()
  const frame = new TextDecoder().decode((await reader.read()).value)
  await reader.cancel()
  const original = h.store.snapshot
  h.store.snapshot = () => { throw new Error(TOKEN) }
  const failed = await h.request(API.state + `?token=${TOKEN}`, { headers: AUTH })
  assert.equal(failed.status, 500)
  const error = await failed.text()
  h.store.snapshot = original
  const publicData = [status, state, frame, error, JSON.stringify(logs)].join('\n')
  for (const secret of [TOKEN, session.cookie.split('=')[1]]) assert.equal(publicData.includes(secret), false)
  assert.ok(logs.some((line) => String(line[0]).includes('GET /api/state 500')))
  assert.ok(!JSON.stringify(logs).includes('?token='))
})
