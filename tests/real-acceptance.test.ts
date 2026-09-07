import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acceptanceConfig, redact, runAcceptance } from '../scripts/real-acceptance.js'
import { LLMAbortedError, type LLM } from '../server/contracts.js'
import { scriptedOpenAI } from './openai-fixtures.js'

const env = { OPENAI_API_KEY: 'offline-only', RUN_BUDGET_USD: '1', LIFETIME_BUDGET_USD: '3' }
function fixture(t: { after(fn: () => void): void }) {
  const outputDir = mkdtempSync(join(tmpdir(), 'acceptance-test-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const config = { ...acceptanceConfig(env), mockSpeed: 0 }
  return { config, outputDir, revision: 'test-revision', proof: 'offline' as const, timeoutMs: 3000 }
}

test('acceptance preflight requires explicit credentials and budgets and refuses mock selection', () => {
  assert.throws(() => acceptanceConfig({}), /OPENAI_API_KEY, RUN_BUDGET_USD, LIFETIME_BUDGET_USD/)
  assert.throws(() => acceptanceConfig({ ...env, MOCK_LLM: '1' }), /refuses MOCK/)
  assert.throws(() => acceptanceConfig({ ...env, LLM_PROVIDER: 'mock' }), /requires LLM_PROVIDER/)
  assert.throws(() => acceptanceConfig({ ...env, RUN_BUDGET_USD: 'NaN-secret' }), error => error instanceof Error && !error.message.includes('NaN-secret'))
  assert.throws(() => acceptanceConfig({ ...env, LIFETIME_BUDGET_USD: '0.5' }), /at least/)
  assert.equal(acceptanceConfig(env).autoStart, false)
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
