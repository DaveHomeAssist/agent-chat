// Production modules and HTTP/SSE transport, with deterministic mock-only composition.
// Deliberately do not import server/index: it reads .env and probes real providers.
import { resolve } from 'node:path'
import { PERSONAS } from '../../dist-server/server/agents.js'
import { loadConfig } from '../../dist-server/server/config.js'
import { createServer } from '../../dist-server/server/http.js'
import { createMockLLM } from '../../dist-server/server/llm/mock.js'
import { createOrchestrator } from '../../dist-server/server/orchestrator.js'
import { createRunStore } from '../../dist-server/server/run.js'
import { createToolRegistry } from '../../dist-server/server/tools.js'
import { createWorkspace } from '../../dist-server/server/workspace.js'

if (!process.send) throw new Error('Browser fixture requires private IPC')
const config = loadConfig({
  MOCK_LLM: '1', LLM_PROVIDER: 'mock', AUTO_START: '0', MOCK_SPEED: '0.02',
  HOST: '127.0.0.1', PORT: '18787', STATIC_DIR: resolve('dist'),
})
const store = createRunStore(PERSONAS, config.models)
const orchestrator = createOrchestrator({
  store, workspace: createWorkspace(), tools: createToolRegistry(),
  config, llm: createMockLLM(config), personas: PERSONAS,
})
const server = createServer({ store, orchestrator, config })
const streams = new Set()
let lastAppend
store.subscribe((event) => { if (event.type === 'thread.append') lastAppend = event })
server.on('request', (req, res) => {
  if (req.url !== '/api/events') return
  streams.add(res)
  res.once('close', () => streams.delete(res))
})
process.on('message', ({ id, command }) => {
  try {
    if (command === 'disconnect') {
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
  orchestrator.dispose()
  for (const stream of streams) stream.destroy()
  server.closeAllConnections()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('disconnect', stop)
