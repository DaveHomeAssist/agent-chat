// Production modules and HTTP/SSE transport, with deterministic mock-only composition.
// Deliberately do not import server/index: it reads .env and probes real providers.
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { createAuthService } from '../../dist-server/server/auth.js'
import { PERSONAS } from '../../dist-server/server/agents.js'
import { loadConfig } from '../../dist-server/server/config.js'
import { createServer, createRequestHandler } from '../../dist-server/server/http.js'
import { createMockLLM } from '../../dist-server/server/llm/mock.js'
import { createOrchestrator } from '../../dist-server/server/orchestrator.js'
import { createRunStore } from '../../dist-server/server/run.js'
import { createToolRegistry } from '../../dist-server/server/tools.js'
import { createWorkspace } from '../../dist-server/server/workspace.js'

if (!process.send) throw new Error('Browser fixture requires private IPC')
const authMode = process.argv[2] ?? 'local'
const secure = authMode === 'session-https'
const token = Buffer.alloc(32, 71).toString('base64url') // Synthetic test credential only.
const config = loadConfig({
  ...(authMode === 'local' ? {} : {
    AUTH_MODE: 'session', PUBLIC_ORIGIN: `${secure ? 'https' : 'http'}://127.0.0.1:18787`, AGENT_CHAT_OPERATOR_TOKEN: token,
  }),
  MOCK_LLM: '1', LLM_PROVIDER: 'mock', AUTO_START: '0', MOCK_SPEED: '0.02',
  HOST: '127.0.0.1', PORT: '18787', STATIC_DIR: resolve('dist'),
})
const store = createRunStore(PERSONAS, config.models)
const orchestrator = createOrchestrator({
  store, workspace: createWorkspace(), tools: createToolRegistry(),
  config, llm: createMockLLM(config), personas: PERSONAS,
})
let clockOffset = 0
const timers = new Map()
const auth = createAuthService(config.auth, { runtime: {
  now: () => Date.now() + clockOffset,
  setTimer: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref()
    timers.set(timer, { callback, at: Date.now() + clockOffset + delay })
    return timer
  },
  clearTimer: (timer) => { clearTimeout(timer); timers.delete(timer) },
} })
const deps = { store, orchestrator, config, auth }
// Self-signed synthetic TLS material lives in the parent's owned temp directory.
const server = secure
  ? https.createServer({ cert: readFileSync(process.argv[3]), key: readFileSync(process.argv[4]) }, createRequestHandler(deps))
  : createServer(deps)
const streams = new Set()
let eventRequests = 0
let stateRequests = 0
let lastAppend
store.subscribe((event) => { if (event.type === 'thread.append') lastAppend = event })
server.on('request', (req, res) => {
  if (req.url === '/api/state') stateRequests++
  if (req.url !== '/api/events') return
  eventRequests++
  streams.add(res)
  res.once('close', () => streams.delete(res))
})
process.on('message', ({ id, command }) => {
  try {
    if (command === 'stats') {
      process.send({ id, ok: true, eventRequests, stateRequests, activeStreams: streams.size }); return
    } else if (command === 'expire') {
      clockOffset += 28_800_001
      for (const [timer, entry] of timers) if (entry.at <= Date.now() + clockOffset) {
        clearTimeout(timer); timers.delete(timer); entry.callback()
      }
    } else if (command === 'dispose') {
      auth.dispose()
    } else if (command === 'disconnect') {
      for (const stream of streams) stream.destroy()
    } else if (command === 'replay') {
      if (!lastAppend || streams.size === 0) throw new Error('No live event to replay')
      const frame = `event: ${lastAppend.type}\ndata: ${JSON.stringify(lastAppend)}\nid: ${lastAppend.seq}\n\n`
      for (const stream of streams) stream.write(frame + frame)
    } else throw new Error('Unknown fixture command')
    process.send({ id, ok: true, replayedBody: command === 'replay' ? lastAppend.item.body : undefined })
  } catch (error) { process.send({ id, error: error.message }) }
})
server.once('error', (error) => { console.error(error); process.exit(1) })
server.listen(config.port, config.host, () => process.send({ ready: true }))
const stop = () => {
  auth.dispose()
  orchestrator.dispose()
  for (const stream of streams) stream.destroy()
  server.closeAllConnections()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('disconnect', stop)
