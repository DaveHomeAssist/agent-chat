/**
 * Composition root. Loads .env and config, wires the modules together, listens,
 * and — with a real key — checks the API is reachable before auto-starting.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PERSONAS } from './agents.js'
import { loadConfig, repoRoot } from './config.js'
import { createServer } from './http.js'
import { createLLM } from './llm/index.js'
import { createOrchestrator } from './orchestrator.js'
import { createRunStore } from './run.js'
import { createToolRegistry } from './tools.js'
import { createWorkspace } from './workspace.js'
import type { Config } from './contracts.js'

const EXIT_GRACE_MS = 1500

/** KEY=VALUE lines; existing environment wins. No dotenv dependency. */
function loadDotEnv(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]
    if (quoted) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function banner(config: Config): string {
  const models = Object.entries(config.models)
    .map(([id, m]) => `${id}=${m}`)
    .join(' ')
  return [
    `agent-chatroom http://localhost:${config.port}`,
    `llm=${config.llm}`,
    models,
    `effort=${config.effort}`,
    `budget=$${config.budgetUsd.toFixed(2)}`,
    `static=${config.staticDir ?? 'off (vite dev server serves the client)'}`,
  ].join(' · ')
}

async function main(): Promise<void> {
  loadDotEnv(resolve(repoRoot(), '.env'))
  const config = loadConfig()

  const store = createRunStore(PERSONAS, config.models)
  // The store defaults to `mock`; the UI reads `run.llm` before any run has started.
  store.setRun({ llm: config.llm })
  const workspace = createWorkspace()
  const tools = createToolRegistry()
  const llm = createLLM(config)
  const orchestrator = createOrchestrator({ store, llm, workspace, tools, config, personas: PERSONAS })
  const server = createServer({ store, orchestrator, config })

  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(config.port, () => {
      server.off('error', fail)
      done()
    })
  })
  console.log(banner(config))

  let healthy = true
  if (config.llm === 'anthropic') {
    const problem = await llm.healthcheck(config.models.atlas)
    if (problem) {
      healthy = false
      console.error(`llm healthcheck failed: ${problem}`)
      store.setRun({ status: 'failed', error: problem })
    }
  }

  if (config.autoStart && healthy) {
    console.log('auto-starting the run')
    orchestrator.start().catch((err: unknown) => console.error('run failed:', err))
  }

  let exiting = false
  const shutdown = (signal: string) => {
    if (exiting) return
    exiting = true
    console.log(`${signal} received, shutting down`)
    try {
      orchestrator.dispose()
    } catch (err) {
      console.error('dispose failed:', err)
    }
    server.close(() => process.exit(0))
    // Open SSE streams would otherwise keep close() waiting.
    server.closeAllConnections()
    setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  server.on('error', (err) => console.error('server error:', err))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
