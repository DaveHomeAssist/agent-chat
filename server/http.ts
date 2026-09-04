import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { AGENT_IDS, API, type AgentId, type MessageTarget, type RunEvent } from '../shared/protocol.js'
import type { Config, Orchestrator, RunStore } from './contracts.js'

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_CHARS = 4000
const HEARTBEAT_MS = 15_000

interface Deps {
  store: RunStore
  orchestrator: Orchestrator
  config: Config
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
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    res.once('finish', () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`))

    dispatch(req, res, path, routes, staticDir).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error(`${req.method} ${path} failed:`, err)
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (status === 413) {
        res.setHeader('Connection', 'close')
        res.once('finish', () => req.destroy())
      }
      json(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
    })
  })
}

async function dispatch(req: Req, res: Res, path: string, routes: Route[], staticDir: string | null): Promise<void> {
  const method = req.method ?? 'GET'
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

function buildRoutes({ store, orchestrator }: Deps): Route[] {
  const exact = (p: string) => (path: string) => (path === p ? {} : null)
  const interrupt = /^\/api\/agents\/([^/]+)\/interrupt$/

  const command = (fn: (body: unknown) => Promise<void> | void): Route['handle'] => {
    return async (req, res) => {
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
      handle: command(async (body) => {
        const { text, target } = parseMessage(body)
        await orchestrator.humanMessage(text, target)
      }),
    },
    {
      method: 'POST',
      match: exact(API.start),
      handle: command(() => {
        // start() may resolve only when the run ends, so the request does not wait on it.
        orchestrator.start().catch((err: unknown) => console.error('run failed:', err))
      }),
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
  const target = resolve(root, `.${decodeURIComponent(path)}`)
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
