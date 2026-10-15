import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acceptanceConfig, redact, runAcceptance } from '../scripts/real-acceptance.js'
import { LLMAbortedError, type LLM } from '../server/contracts.js'
import { costUsd } from '../server/llm/pricing.js'
import { anthropicUsage, scriptedAnthropic } from './anthropic-fixtures.js'
import { scriptedOpenAI } from './openai-fixtures.js'

const env = { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'offline-only', RUN_BUDGET_USD: '1', LIFETIME_BUDGET_USD: '3' }
const anthropicEnv = { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'offline-only', ANTHROPIC_MODEL: 'claude-opus-5-5', RUN_BUDGET_USD: '1', LIFETIME_BUDGET_USD: '3' }
function fixture(t: { after(fn: () => void): void }, selected: NodeJS.ProcessEnv = env) {
  const outputDir = mkdtempSync(join(tmpdir(), 'acceptance-test-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const config = { ...acceptanceConfig(selected), mockSpeed: 0 }
  return { config, outputDir, revision: 'test-revision', proof: 'offline' as const, timeoutMs: 3000 }
}

test('acceptance preflight requires explicit credentials and budgets and refuses mock selection', () => {
  assert.throws(() => acceptanceConfig({}), /LLM_PROVIDER, RUN_BUDGET_USD, LIFETIME_BUDGET_USD/)
  assert.equal(acceptanceConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'offline-only', RUN_BUDGET_USD: '1', LIFETIME_BUDGET_USD: '3' }).idleRunFailsAfterMs, 60_000, 'headless runs end instead of waiting for a human')
  assert.throws(() => acceptanceConfig({ OPENAI_API_KEY: 'offline-only', RUN_BUDGET_USD: '1', LIFETIME_BUDGET_USD: '3' }), /LLM_PROVIDER/)
  assert.throws(() => acceptanceConfig({ ...env, MOCK_LLM: '1' }), /refuses MOCK/)
  assert.throws(() => acceptanceConfig({ ...env, LLM_PROVIDER: 'mock' }), /requires LLM_PROVIDER/)
  assert.throws(() => acceptanceConfig({ ...env, RUN_BUDGET_USD: 'NaN-secret' }), error => error instanceof Error && !error.message.includes('NaN-secret'))
  assert.throws(() => acceptanceConfig({ ...env, LIFETIME_BUDGET_USD: '0.5' }), /at least/)
  assert.equal(acceptanceConfig(env).autoStart, false)
  // October 14 run 1: Atlas spent the shared 12-wake cap and stranded the workers' reports.
  assert.equal(acceptanceConfig(env).maxTurnsPerAgent, 12)
  assert.equal(acceptanceConfig(env).maxTurnsOrchestrator, 48)
  assert.equal(acceptanceConfig({ ...env, MAX_TURNS_ORCHESTRATOR: '20' }).maxTurnsOrchestrator, 20)
})

test('two offline SDK stories reach a held gate with artifacts and cumulative usage', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, provider: () => scriptedOpenAI(options.config) })
  assert.equal(result.passed, true)
  assert.equal(result.proof, 'offline')
  assert.equal(result.reports.length, 2)
  assert.notEqual(result.reports[0].runId, result.reports[1].runId)
  assert.ok(result.reports[1].cumulativeCostUsd > result.reports[0].costUsd)
  for (const report of result.reports) {
    assert.equal(report.status, 'needs_approval')
    assert.equal(report.snapshot.run.approvalGate, true)
    assert.equal(report.snapshot.typing.length, 0)
    assert.equal(report.snapshot.stats.toolCalls, 59)
  }
  assert.equal(readdirSync(result.directory).length, 7)
  const log = readFileSync(join(result.directory, 'run-1.jsonl'), 'utf8')
  assert.ok(log.split('\n').filter(Boolean).every(line => JSON.parse(line).event))
  assert.ok(!log.includes('opaque-reasoning-fixture'))
  assert.equal(statSync(join(result.directory, 'result.json')).mode & 0o777, 0o600)
})

test('unreachable provider stops before model requests and produces failure report', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, provider: () => ({ kind: 'openai', healthcheck: async () => 'no access', complete: async () => { throw Error('must not generate') } }) })
  assert.equal(result.passed, false)
  assert.equal(result.reports.length, 1)
  assert.match(result.reports[0].reason, /no access/)
  assert.equal(Object.values(result.reports[0].requests).reduce((a,b) => a+b), 0)
})

test('run timeout cancels in-flight work and records unknown usage', async t => {
  const options = fixture(t)
  let aborted = false
  const provider: LLM = { kind: 'openai', healthcheck: async () => null, complete: req => new Promise((_, reject) => {
    req.signal.addEventListener('abort', () => { aborted = true; reject(new LLMAbortedError()) }, { once: true })
  }) }
  const result = await runAcceptance({ ...options, timeoutMs: 50, provider: () => provider })
  assert.equal(result.passed, false)
  assert.equal(aborted, true)
  assert.equal(result.reports[0].accountingComplete, false)
  assert.equal(result.reports.length, 1)
})

test('missing usage fails acceptance even if the provider can finish the story', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, provider: () => {
    const script = scriptedOpenAI(options.config)
    return { ...script, complete: async req => ({ ...await script.complete(req), usage: undefined }) }
  } })
  assert.equal(result.passed, false)
  assert.ok(result.reports[0].unreportedRequests > 0)
})

test('budget failure prevents automatic retry and preserves reported cost', async t => {
  const options = fixture(t)
  options.config.budgetUsd = 0.00001
  const result = await runAcceptance({ ...options, provider: () => scriptedOpenAI(options.config) })
  assert.equal(result.passed, false)
  assert.equal(result.reports.length, 1)
  assert.ok(result.reports[0].costUsd > options.config.budgetUsd)
})

test('second run is refused when remaining cumulative budget is below run allowance', async t => {
  const options = fixture(t)
  options.config.lifetimeBudgetUsd = 1
  const result = await runAcceptance({ ...options, provider: () => scriptedOpenAI(options.config) })
  assert.equal(result.passed, false)
  assert.equal(result.reports[0].passed, true)
  assert.match(result.reports[1].reason, /Insufficient remaining/)
  assert.equal(Object.values(result.reports[1].requests).reduce((a,b) => a+b), 0)
})

test('already interrupted run does not contact provider', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, signal: AbortSignal.abort(), provider: () => ({ kind: 'openai', healthcheck: async () => { throw Error('must not run') }, complete: async () => { throw Error('must not run') } }) })
  assert.equal(result.passed, false)
  assert.match(result.reports[0].reason, /Interrupted/)
})

test('transcript and reports redact credentials in surfaced errors', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, secrets: ['private-token'], provider: () => ({ kind: 'openai', healthcheck: async () => 'private-token sk-private123', complete: async () => { throw Error('must not run') } }) })
  for (const name of readdirSync(result.directory)) {
    const text = readFileSync(join(result.directory, name), 'utf8')
    assert.ok(!text.includes('private-token'))
    assert.ok(!text.includes('sk-private123'))
  }
  assert.equal(redact('x private-token y', ['private-token']), 'x [REDACTED] y')
})

test('a stalled model healthcheck times out without generating', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, timeoutMs: 30, provider: () => ({ kind: 'openai', healthcheck: () => new Promise(() => {}), complete: async () => { throw Error('must not generate') } }) })
  assert.equal(result.passed, false)
  assert.match(result.reports[0].reason, /Healthcheck timeout/)
})

test('a signal during a live run cancels the request and writes a failed result', async t => {
  const options = fixture(t)
  const controller = new AbortController()
  const result = await runAcceptance({ ...options, signal: controller.signal, provider: () => ({
    kind: 'openai', healthcheck: async () => null,
    complete: req => new Promise((_, reject) => {
      req.signal.addEventListener('abort', () => reject(new LLMAbortedError()), { once: true })
      controller.abort()
    }),
  }) })
  assert.equal(result.passed, false)
  assert.equal(result.reports.length, 1)
  assert.equal(result.reports[0].accountingComplete, false)
  assert.equal(JSON.parse(readFileSync(join(result.directory, 'result.json'), 'utf8')).state, 'finished')
})

test('provider ignoring cancellation cannot pass or trigger another run', async t => {
  const options = fixture(t)
  const result = await runAcceptance({ ...options, timeoutMs: 30, drainMs: 10, provider: () => ({
    kind: 'openai', healthcheck: async () => null, complete: () => new Promise(() => {}),
  }) })
  assert.equal(result.passed, false)
  assert.equal(result.reports.length, 1)
  assert.equal(result.reports[0].accountingComplete, false)
  assert.match(result.reports[0].reason, /Outstanding requests/)
})

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`)

test('acceptance preflight selects Anthropic only with its own key and exactly priced models', () => {
  assert.throws(() => acceptanceConfig({ ...anthropicEnv, ANTHROPIC_API_KEY: '' }), /Missing required environment variables: ANTHROPIC_API_KEY$/)
  assert.throws(() => acceptanceConfig({ ...anthropicEnv, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'wrong-account' }), /ANTHROPIC_API_KEY/)
  assert.throws(() => acceptanceConfig({ ...anthropicEnv, LLM_PROVIDER: 'toString' }), /requires LLM_PROVIDER/)
  assert.throws(() => acceptanceConfig({ ...anthropicEnv, AGENT_MODEL_PROBE: 'claude-opus-5-6' }), /No exact pricing for the model configured for probe;/)
  assert.throws(() => acceptanceConfig({ ...anthropicEnv, ANTHROPIC_MODEL: 'claude-sonnet-5-5-preview' }), /No exact pricing for the model configured for atlas, vector, forge, probe, sentry;/)
  const config = acceptanceConfig({ ...anthropicEnv, AGENT_MODEL_VECTOR: 'claude-sonnet-5-5' })
  assert.equal(config.llm, 'anthropic')
  assert.equal(config.effort, 'medium')
  assert.deepEqual(config.models, { atlas: 'claude-opus-5-5', vector: 'claude-sonnet-5-5', forge: 'claude-opus-5-5', probe: 'claude-opus-5-5', sentry: 'claude-opus-5-5' })
  assert.equal(acceptanceConfig({ ...anthropicEnv, ANTHROPIC_MODEL: undefined }).models.atlas, 'claude-opus-5')
})

test('two offline Anthropic SDK stories reach a held gate billed at the served model rates', async t => {
  const options = fixture(t, anthropicEnv)
  const payloads: Record<string, unknown>[] = []
  const result = await runAcceptance({ ...options, provider: () => scriptedAnthropic(options.config, { payloads }) })
  assert.equal(result.passed, true, result.reports.map(r => r.reason).join('; '))
  assert.equal(result.settings.provider, 'anthropic')
  assert.equal(result.reports.length, 2)
  const perRequest = costUsd({ model: 'claude-opus-5-5', inputTokens: anthropicUsage.input_tokens, outputTokens: anthropicUsage.output_tokens, cacheReadTokens: anthropicUsage.cache_read_input_tokens, cacheWriteTokens: anthropicUsage.cache_creation_input_tokens })
  close(perRequest, (1000 * 4 + 100 * 20 + 200 * 4 * 0.05 + 100 * 4 * 1.25) / 1e6)
  for (const report of result.reports) {
    assert.equal(report.status, 'needs_approval')
    assert.equal(report.snapshot.run.llm, 'anthropic')
    assert.equal(report.snapshot.stats.toolCalls, 59)
    assert.deepEqual(report.unpricedModels, [])
    close(report.costUsd, Object.values(report.requests).reduce((a, b) => a + b) * perRequest)
  }
  assert.ok(payloads.length > 0 && payloads.every(p => p.model === 'claude-opus-5-5'))
  assert.deepEqual(payloads[0].thinking, { type: 'adaptive' })
  assert.deepEqual(payloads[0].output_config, { effort: 'medium' })
  assert.ok(payloads.every(p => p.tool_choice === undefined))
  const log = readFileSync(join(result.directory, 'run-1.jsonl'), 'utf8')
  assert.ok(!log.includes('opaque-anthropic-fixture'))
  assert.match(readFileSync(join(result.directory, 'run-1.md'), 'utf8'), /provider: anthropic;[\s\S]*atlas=claude-opus-5-5/)
})

test('a server-side fallback to an unpriced model fails acceptance instead of guessing spend', async t => {
  const options = fixture(t, anthropicEnv)
  const result = await runAcceptance({ ...options, provider: () => scriptedAnthropic(options.config, { servedModel: () => 'claude-unlisted-1' }) })
  assert.equal(result.passed, false)
  assert.equal(result.reports.length, 1)
  assert.deepEqual(result.reports[0].unpricedModels, ['claude-unlisted-1'])
  assert.match(result.reports[0].reason, /without exact pricing/)
})

test('a provider identity that does not match LLM_PROVIDER is refused before any request', async t => {
  const options = fixture(t, anthropicEnv)
  await assert.rejects(runAcceptance({ ...options, provider: () => scriptedOpenAI(options.config) }), /does not match LLM_PROVIDER/)
})
