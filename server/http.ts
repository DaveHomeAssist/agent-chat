import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { AGENT_IDS, API, type AgentId, type MessageTarget, type RunEvent } from '../shared/protocol.js'
import type { AuthHeaderValue, AuthPrincipal, AuthService } from './auth.js'
import { evaluateRequestSecurity, type RequestPolicy } from './request-security.js'
import type { ServerConfig } from './config.js'
import type { CommandAcceptance, Orchestrator, RunStore } from './contracts.js'

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 4000
const HEARTBEAT_MS = 15_000
/** POST /api/message: this many in a burst, then one per second. */
const MESSAGE_BURST = 5
const MESSAGE_PER_SEC = 1

interface Deps {
  store: RunStore
  orchestrator: Orchestrator
  config: ServerConfig
  auth: AuthService
}

type Req = http.IncomingMessage
type Res = http.ServerResponse

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface Route {
  method: 'GET' | 'POST'
  match: (path: string) => Record<string, string> | null
  handle: (req: Req, res: Res, params: Record<string, string>, principal: AuthPrincipal) => Promise<void> | void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

export function createServer(deps: Deps): http.Server {
  return http.createServer(createRequestHandler(deps))
}

/** Shared handler also permits direct TLS in isolated browser verification. */
export function createRequestHandler(deps: Deps): http.RequestListener {
  const routes = buildRoutes(deps)
  return (req, res) => {
    const started = Date.now()
    let safePath = '/[invalid-url]'
    res.once('finish', () => console.log(`${req.method} ${safePath} ${res.statusCode} ${Date.now() - started}ms`))
    // URL parsing stays inside the rejection boundary. Never log the query,
    // headers, body or exception payload: any of them can contain a credential.
    Promise.resolve().then(async () => {
      safePath = pathname(req)
      await dispatch(req, res, routes, deps, safePath)
    }).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error(`${req.method} ${safePath} failed`)
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (status === 413) {
        res.setHeader('Connection', 'close')
        res.once('finish', () => req.destroy())
      }
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="Agent Chatroom"')
      if (status === 429 && !res.hasHeader('Retry-After')) res.setHeader('Retry-After', '1')
      json(res, status, { ok: false, error: err instanceof HttpError ? err.message : 'request failed' })
    })
  }
}

/** Preserve duplicates that Node otherwise discards for singleton headers. */
function securityHeader(req: Req, name: string): AuthHeaderValue {
  const values: string[] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1])
  }
  return values.length > 1 ? values : req.headers[name]
}

function assertRequestPolicy(req: Req, deps: Deps, policy: RequestPolicy, principal: AuthPrincipal | null): void {
  const result = evaluateRequestSecurity(deps.config.auth, policy, {
    host: securityHeader(req, 'host'),
    origin: securityHeader(req, 'origin'),
    secFetchSite: securityHeader(req, 'sec-fetch-site'),
    credentialKind: principal?.kind ?? null,
    encrypted: 'encrypted' in req.socket && req.socket.encrypted === true,
  })
  if (!result.ok) throw new HttpError(403, 'request forbidden')
}

async function dispatch(req: Req, res: Res, routes: Route[], deps: Deps, path: string): Promise<void> {
  const method = req.method ?? 'GET'
  const credentials = { authorization: securityHeader(req, 'authorization'), cookie: securityHeader(req, 'cookie') }
  const result = deps.auth.authenticate(credentials)
  const principal = result.ok ? result.principal : null
  const authPolicy = path === API.authStatus ? 'auth-status' : path === API.login ? 'login' : path === API.logout ? 'logout' : null
  if (authPolicy) {
    // Login evaluates the submitted bearer itself; an existing cookie must not
    // turn a valid explicit login attempt into an ambiguous credential request.
    assertRequestPolicy(req, deps, authPolicy, authPolicy === 'login' ? null : principal)
    if (method !== (authPolicy === 'auth-status' ? 'GET' : 'POST')) throw new HttpError(405, 'method not allowed')
    if (authPolicy === 'auth-status') {
      json(res, 200, deps.auth.status(credentials))
    } else if (authPolicy === 'login') {
      const issued = deps.auth.issueSession(credentials.authorization)
      if (!issued.ok) {
        if (issued.code === 'denied') throw new HttpError(401, 'authentication required')
        if (issued.code === 'rate_limited') {
          res.setHeader('Retry-After', String(issued.retryAfterSeconds))
          throw new HttpError(429, 'too many login attempts')
        }
        throw new HttpError(503, 'authentication unavailable')
      }
      res.setHeader('Set-Cookie', issued.setCookie)
      json(res, 200, issued.status)
    } else {
      if (principal?.kind === 'session') deps.auth.revoke(principal)
      const clearCookie = deps.auth.clearSessionCookie()
      if (clearCookie) res.setHeader('Set-Cookie', clearCookie)
      json(res, 200, { mode: deps.auth.mode, authenticated: false, expiresAt: null })
    }
    return
  }

  const api = path.startsWith('/api/') || path === '/api'
  if (api) {
    // Before method dispatch, body reads, snapshots, SSE headers or commands.
    if (!principal) throw new HttpError(401, 'authentication required')
    assertRequestPolicy(req, deps, method === 'GET' || method === 'HEAD' ? 'protected-read' : 'protected-mutation', principal)
  }
  let pathKnown = false
  for (const route of routes) {
    const params = route.match(path)
    if (!params) continue
    pathKnown = true
    if (route.method !== method) continue
    if (!principal) throw new HttpError(401, 'authentication required')
    await route.handle(req, res, params, principal)
    return
  }
  if (pathKnown) throw new HttpError(405, `${method} not allowed on ${path}`)
  if (api) throw new HttpError(404, `no route for ${path}`)
  if (deps.config.staticDir && (method === 'GET' || method === 'HEAD')) {
    await serveStatic(req, res, path, deps.config.staticDir)
    return
  }
  throw new HttpError(404, `no route for ${path}`)
}

/** The request path, or a 400 — `new URL` throws on e.g. an absolute-form target with a bad port. */
function pathname(req: Req): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    throw new HttpError(400, 'bad request url')
  }
}

function isJsonRequest(req: Req): boolean {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase()
  return type === 'application/json'
}

/** Token bucket: `burst` immediately, then `perSec` more per second. */
function tokenBucket(burst: number, perSec: number): { take(): boolean } {
  let tokens = burst
  let last = Date.now()
  return {
    take() {
      const now = Date.now()
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec)
      last = now
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}

function buildRoutes(deps: Deps): Route[] {
  const { store, orchestrator, config, auth } = deps
  const reauthorize = (req: Req) => {
    const current = auth.authenticate({ authorization: securityHeader(req, 'authorization'), cookie: securityHeader(req, 'cookie') })
    if (!current.ok) throw new HttpError(401, 'authentication required')
    assertRequestPolicy(req, deps, 'protected-mutation', current.principal)
  }
  const exact = (p: string) => (path: string) => (path === p ? {} : null)
  const interrupt = /^\/api\/agents\/([^/]+)\/interrupt$/
  const messageBucket = tokenBucket(MESSAGE_BURST, MESSAGE_PER_SEC)
  const lifetimeSpend = () => store.lifetimeCostUsd()
  const requireAcceptance = (result: CommandAcceptance) => {
    if (!result.accepted) throw new HttpError(409, {
      run_unavailable: 'run is not active',
      empty_message: 'message is empty',
      no_active_operation: 'agent has no active operation',
    }[result.reason])
  }

  /** `guard` runs before the body is read, so refusals cost nothing. */
  const command = (fn: (body: unknown) => Promise<void> | void, guard?: (req: Req) => void): Route['handle'] => {
    return async (req, res) => {
      guard?.(req)
      const body = await readJson(req)
      // A slow body can outlive its session. Recheck after the await and before effects.
      reauthorize(req)
      await fn(body)
      json(res, 200, { ok: true, seq: store.seq() })
    }
  }

  return [
    { method: 'GET', match: exact(API.events), handle: (req, res, _params, principal) => streamEvents(req, res, store, auth, principal) },
    { method: 'GET', match: exact(API.state), handle: (_req, res) => json(res, 200, store.snapshot()) },
    {
      method: 'POST',
      match: exact(API.message),
      handle: command(
        async (body) => {
          const { text, target } = parseMessage(body)
          requireAcceptance(await orchestrator.humanMessage(text, target))
        },
        (req) => {
          if (!isJsonRequest(req)) throw new HttpError(415, 'Content-Type must be application/json')
          if (!messageBucket.take()) throw new HttpError(429, 'slow down')
        },
      ),
    },
    {
      method: 'POST',
      match: exact(API.start),
      handle: command(
        () => {
          if (lifetimeSpend() >= config.lifetimeBudgetUsd) throw new HttpError(403, 'lifetime budget reached')
          // start() may resolve only when the run ends, so the request does not wait on it.
          orchestrator.start().catch((err: unknown) => console.error('run failed:', err))
        },
        () => {
          // The per-run ceiling resets with every start; this one does not.
          if (lifetimeSpend() >= config.lifetimeBudgetUsd) throw new HttpError(403, 'lifetime budget reached')
        },
      ),
    },
    { method: 'POST', match: exact(API.pause), handle: command(() => orchestrator.pause()) },
    { method: 'POST', match: exact(API.resume), handle: command(() => orchestrator.resume()) },
    { method: 'POST', match: exact(API.approve), handle: command(() => orchestrator.approve()) },
    { method: 'POST', match: exact(API.gate), handle: command((body) => orchestrator.setGate(parseGate(body))) },
    {
      method: 'POST',
      match: (path) => {
        const m = interrupt.exec(path)
        return m ? { id: m[1] } : null
      },
      handle: async (req, res, params) => {
        if (!isAgentId(params.id)) throw new HttpError(400, `unknown agent "${params.id}"`)
        await readJson(req)
        reauthorize(req)
        requireAcceptance(orchestrator.interrupt(params.id))
        json(res, 200, { ok: true, seq: store.seq() })
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function streamEvents(req: Req, res: Res, store: RunStore, auth: AuthService, principal: AuthPrincipal): void {
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unsubscribe = () => {}
  let unsubscribeAuth = () => {}
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    unsubscribeAuth()
    req.off('close', close)
    req.off('error', close)
    res.off('error', close)
    res.off('close', close)
    if (!res.headersSent) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Agent Chatroom"')
      json(res, 401, { ok: false, error: 'authentication required' })
    } else res.end()
  }
  // Subscribe before sending any run data. A stale/disposed principal can
  // invalidate synchronously; no snapshot or event headers escape that race.
  unsubscribeAuth = auth.onInvalidated(principal, close)
  if (closed) { unsubscribeAuth(); return }
  req.on('close', close)
  req.on('error', close)
  res.on('error', close)
  res.on('close', close)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  req.socket.setTimeout(0)
  req.socket.setNoDelay(true)
  req.socket.setKeepAlive(true)
  res.flushHeaders()
  const send = (event: RunEvent) => {
    if (!closed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\nid: ${event.seq}\n\n`)
  }
  // Reconnects always receive a fresh snapshot, never an old replay buffer.
  const snapshot = store.snapshot()
  send({ type: 'snapshot', seq: snapshot.seq, snapshot })
  unsubscribe = store.subscribe(send)
  heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n') }, HEARTBEAT_MS)
}

// ---------------------------------------------------------------------------
// Bodies and validation
// ---------------------------------------------------------------------------

/** Parses the JSON body; an empty body is `undefined` so bare POSTs work. */
function readJson(req: Req): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop reading; the 413 goes out with Connection: close and the socket
        // drops once it is flushed, so the rest of the body is never buffered.
        req.pause()
        reject(new HttpError(413, `body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolvePromise(undefined)
        return
      }
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'))
      }
    })
    req.on('error', (err) => reject(new HttpError(400, err.message)))
  })
}

function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v)
}

function isTarget(v: unknown): v is MessageTarget {
  return v === 'all' || isAgentId(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseMessage(body: unknown): { text: string; target: MessageTarget } {
  if (!isRecord(body)) throw new HttpError(400, 'expected a JSON object with body and target')
  if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string')
  const text = body.body.trim()
  if (!text) throw new HttpError(400, 'body must not be empty')
  if (text.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `body must be at most ${MAX_MESSAGE_CHARS} characters`)
  if (!isTarget(body.target)) throw new HttpError(400, `target must be "all" or one of ${AGENT_IDS.join(', ')}`)
  return { text, target: body.target }
}

function parseGate(body: unknown): boolean {
  if (!isRecord(body) || typeof body.enabled !== 'boolean') throw new HttpError(400, 'expected { enabled: boolean }')
  return body.enabled
}

function json(res: Res, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

async function serveStatic(req: Req, res: Res, path: string, staticDir: string): Promise<void> {
  const root = resolve(staticDir)
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new HttpError(400, 'bad request url')
  }
  const target = resolve(root, `.${decoded}`)
  if (target !== root && !target.startsWith(root + sep)) throw new HttpError(403, 'forbidden')

  const file = (await isFile(target)) ? target : extname(path) ? null : resolve(root, 'index.html')
  if (!file || !(await isFile(file))) throw new HttpError(404, `no route for ${path}`)

  const info = await stat(file)
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise<void>((done, fail) => {
    createReadStream(file).on('error', fail).on('end', done).pipe(res)
  })
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
