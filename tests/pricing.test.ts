import assert from 'node:assert/strict'
import { test } from 'node:test'
import { costUsd, hasExactPricing, ratesFor } from '../server/llm/pricing.js'

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
const usage = (model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })

test('5.5 models bill at their published rates and cache-hit multipliers', () => {
  close(costUsd(usage('claude-opus-5-5', 1e6, 1e6, 1e6, 1e6)), 4 + 20 + 4 * 0.05 + 4 * 1.25)
  close(costUsd(usage('claude-sonnet-5-5', 1e6, 1e6, 1e6, 1e6)), 2 + 10 + 2 * 0.05 + 2 * 1.25)
  close(costUsd(usage('claude-fable-5-1', 1e6, 1e6, 1e6, 1e6)), 10 + 50 + 10 * 0.025 + 10 * 1.25)
  // Earlier models keep the 0.1x cache hit.
  close(costUsd(usage('claude-opus-5', 1e6, 1e6, 1e6, 1e6)), 5 + 25 + 0.5 + 6.25)
  close(costUsd(usage('claude-sonnet-5', 0, 0, 1e6)), 0.2)
})

test('Haiku 5.5 bills a whole request at the long-prompt rates above 100k prompt tokens', () => {
  close(costUsd(usage('claude-haiku-5-5', 100_000, 1000)), (100_000 * 0.1 + 1000 * 0.5) / 1e6)
  // Cache reads and writes count toward prompt length and switch every rate.
  close(costUsd(usage('claude-haiku-5-5', 50_000, 1000, 40_000, 10_001)), (50_000 * 0.5 + 1000 * 2.5 + 40_000 * 0.5 * 0.1 + 10_001 * 0.5 * 1.25) / 1e6)
})

test('exact pricing accepts catalogue and dated ids only; the app fallback stays lenient', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-20260901', 'gpt-5.6-sol']) assert.equal(hasExactPricing(model), true, model)
  for (const model of ['claude-opus-5-6', 'claude-opus-5-5-preview', 'claude-unlisted-1']) assert.equal(hasExactPricing(model), false, model)
  // An unlisted Opus 5 point release is still billed by its family prefix, never below a known rate.
  assert.equal(ratesFor('claude-opus-5-6'), ratesFor('claude-opus-5'))
  assert.equal(ratesFor('claude-opus-5-5-20261001'), ratesFor('claude-opus-5-5'))
})
