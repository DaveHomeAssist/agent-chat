import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { AGENT_IDS, API, type AgentId, type MessageTarget, type RunEvent } from '../shared/protocol.js'
import type { ServerConfig } from './config.js'
import type { Orchestrator, RunStore } from './contracts.js'

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
  handle: (req: Req, res: Res, params: Record<string, string>) => Promise<void> | void
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
  const routes = buildRoutes(deps)
  const staticDir = deps.config.staticDir

  return http.createServer((req, res) => {
    const started = Date.now()
    res.once('finish', () => console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`))

    // Everything that can throw — the URL parse included — runs inside this
    // promise so one bad request is a 4xx/5xx, never an uncaught exception.
    dispatch(req, res, routes, staticDir).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error(`${req.method} ${req.url} failed:`, err)
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (status === 413) {
        res.setHeader('Connection', 'close')
        res.once('finish', () => req.destroy())
      }
      if (status === 429) res.setHeader('Retry-After', '1')
      json(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
    })
  })
}

async function dispatch(req: Req, res: Res, routes: Route[], staticDir: string | null): Promise<void> {
  const method = req.method ?? 'GET'
  const path = pathname(req)
  if (method === 'POST') assertSameOrigin(req)
  let pathKnown = false
  for (const route of routes) {
    const params = route.match(path)
    if (!params) continue
    pathKnown = true
    if (route.method !== method) continue
    await route.handle(req, res, params)
    return
  }
  if (pathKnown) throw new HttpError(405, `${method} not allowed on ${path}`)
  if (path.startsWith('/api/') || path === '/api') throw new HttpError(404, `no route for ${path}`)
  if (staticDir && (method === 'GET' || method === 'HEAD')) {
    await serveStatic(req, res, path, staticDir)
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

/**
 * CSRF guard. Every POST here is a CORS "simple request", so a page on any
 * origin could fire one; browsers always send `Origin` (and `Sec-Fetch-Site`)
 * on POST, so a mismatch means cross-site. Requests without either header —
 * curl, the built client is same-origin, the Vite proxy keeps Host — pass.
 */
function assertSameOrigin(req: Req): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site request')
  const origin = req.headers.origin
  if (origin === undefined) return
  let host: string | null
  try {
    host = new URL(origin).host
  } catch {
    host = null // includes the literal "null" origin
  }
  if (host === null || host.toLowerCase() !== req.headers.host?.toLowerCase()) {
    throw new HttpError(403, 'cross-site request')
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

function buildRoutes({ store, orchestrator, config }: Deps): Route[] {
  const exact = (p: string) => (path: string) => (path === p ? {} : null)
  const interrupt = /^\/api\/agents\/([^/]+)\/interrupt$/
  const messageBucket = tokenBucket(MESSAGE_BURST, MESSAGE_PER_SEC)
  const lifetimeSpend = () => store.lifetimeCostUsd()

  /** `guard` runs before the body is read, so refusals cost nothing. */
  const command = (fn: (body: unknown) => Promise<void> | void, guard?: (req: Req) => void): Route['handle'] => {
    return async (req, res) => {
      guard?.(req)
      const body = await readJson(req)
      await fn(body)
      json(res, 200, { ok: true, seq: store.seq() })
    }
  }

  return [
    { method: 'GET', match: exact(API.events), handle: (req, res) => streamEvents(req, res, store) },
    { method: 'GET', match: exact(API.state), handle: (_req, res) => json(res, 200, store.snapshot()) },
    {
      method: 'POST',
      match: exact(API.message),
      handle: command(
        async (body) => {
          const { text, target } = parseMessage(body)
          await orchestrator.humanMessage(text, target)
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
        orchestrator.interrupt(params.id)
        json(res, 200, { ok: true, seq: store.seq() })
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function streamEvents(req: Req, res: Res, store: RunStore): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  req.socket.setTimeout(0)
  req.socket.setNoDelay(true)
  req.socket.setKeepAlive(true)
  res.flushHeaders()

  const send = (e: RunEvent) => {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\nid: ${e.seq}\n\n`)
  }

  // A reconnecting client (Last-Event-ID set) gets the same fresh snapshot as a
  // new one — state is small, so there is no replay buffer to consult.
  const snapshot = store.snapshot()
  send({ type: 'snapshot', seq: snapshot.seq, snapshot })

  const unsubscribe = store.subscribe(send)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  req.on('close', close)
  req.on('error', close)
  res.on('error', close)
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
