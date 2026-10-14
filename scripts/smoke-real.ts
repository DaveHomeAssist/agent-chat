import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { LLM } from '../server/contracts.js'
import type { ServerConfig } from '../server/config.js'
import { createAnthropicLLM } from '../server/llm/anthropic.js'
import { createOpenAILLM } from '../server/llm/openai.js'
import { acceptanceConfig, redact, runAcceptance } from './real-acceptance.js'

const USAGE = `Usage: npm run smoke:real -- --check | --execute
--check validates environment only (no network). --execute runs two billable attempts, stopping on failure.
Required: LLM_PROVIDER (anthropic or openai), that provider's API key (ANTHROPIC_API_KEY or OPENAI_API_KEY),
RUN_BUDGET_USD, LIFETIME_BUDGET_USD. Optional: ANTHROPIC_MODEL / OPENAI_MODEL, AGENT_MODEL_*, EFFORT.
Uses exported environment only, not .env. Reports: runs/acceptance-*/`

/** The billed credential is the exported API key itself, never an ambient token or login profile. */
function liveProvider(config: ServerConfig, env: NodeJS.ProcessEnv): LLM {
  if (config.llm === 'anthropic') return createAnthropicLLM(config, new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, authToken: null, maxRetries: 3 }))
  return createOpenAILLM(config)
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !['--check', '--execute'].includes(args[0])) {
    console.log(USAGE)
    return args.length ? 2 : 0
  }
  const config = acceptanceConfig(process.env)
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 1_500_000)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_500_000) throw new Error('SMOKE_TIMEOUT_MS must be an integer from 1000 to 1500000')
  if (args[0] === '--check') {
    const models = [...new Set(Object.values(config.models))].join(', ')
    console.log(`Preflight passed for ${config.llm} (${models}; effort ${config.effort}; run $${config.budgetUsd}, lifetime $${config.lifetimeBudgetUsd}). No network request made; account/model access remains unverified.`)
    return 0
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const secrets = Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? '').filter(Boolean)
    const result = await runAcceptance({ config, provider: () => liveProvider(config, process.env), outputDir: resolve('runs'), revision, proof: 'live', timeoutMs, signal: controller.signal, secrets })
    console.log(`${result.passed ? 'PASS' : 'FAIL'}: ${result.reports.filter(r => r.passed).length}/2 accepted runs. Reports: ${result.directory}`)
    for (const report of result.reports) console.log(`Attempt ${report.attempt}: ${report.reason} ($${report.costUsd.toFixed(4)})`)
    return result.passed ? 0 : 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}
main().then(code => process.exit(code), error => {
  // Do not echo environment values, request headers or raw SDK objects.
  console.error(redact(error instanceof Error ? error.message : 'Acceptance failed', Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value ?? '')))
  process.exit(2)
})
