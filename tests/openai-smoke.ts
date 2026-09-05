/** Test-only browser fixture. No env file, API keys, production endpoint or healthcheck. */
import { resolve } from 'node:path'
import { PERSONAS } from '../server/agents.js'
import { loadConfig } from '../server/config.js'
import { createServer } from '../server/http.js'
import { createOrchestrator } from '../server/orchestrator.js'
import { createRunStore } from '../server/run.js'
import { createToolRegistry } from '../server/tools.js'
import { createWorkspace } from '../server/workspace.js'
import { createOpenAILLM } from '../server/llm/openai.js'
import { clientWith, completed, sse, scriptedOpenAI } from './openai-fixtures.js'

const config = loadConfig({ LLM_PROVIDER: 'openai', AUTO_START: '0', HOST: '127.0.0.1', PORT: '8791', MOCK_SPEED: process.env.MOCK_SPEED ?? '1', STATIC_DIR: resolve('dist') })
const store = createRunStore(PERSONAS, config.models)
store.setRun({ llm: 'openai' })
const llm = process.env.SMOKE_FAIL === '1'
  ? createOpenAILLM(config, clientWith(async () => sse([completed([], null, 'failed')])))
  : scriptedOpenAI(config)
const orchestrator = createOrchestrator({ store, llm, workspace: createWorkspace(), tools: createToolRegistry(), config, personas: PERSONAS })
const server = createServer({ store, orchestrator, config })
server.listen(config.port, config.host, () => console.log(`Offline OpenAI browser fixture: http://${config.host}:${config.port}`))
const shutdown = () => { orchestrator.dispose(); server.close(); server.closeAllConnections() }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
