import type { LLMUsage } from '../contracts.js'
import { OPENAI_MODEL } from './openai-profile.js'

/**
 * USD per 1M tokens, from https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-14).
 * `cacheRead` is the cache-hit multiplier on input; cache writes (5-minute) bill at 1.25x input.
 * `longPrompt` applies every rate of a request whose prompt (input + cache reads + cache writes)
 * exceeds `aboveTokens`, as Claude Haiku 5.5 is priced.
 */
export interface Rates {
  input: number
  output: number
  cacheRead: number
  longPrompt?: { aboveTokens: number; input: number; output: number }
}

export const PRICING: Record<string, Rates> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.1, longPrompt: { aboveTokens: 100_000, input: 0.5, output: 2.5 } },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.1 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}

const OPENAI_RATES: Rates = { input: 4, output: 20, cacheRead: 0.1 }
const CACHE_WRITE = 1.25
const FALLBACK_RATES = PRICING['claude-opus-5']

const DATED = Object.keys(PRICING).map((k) => [k, new RegExp(`^${k}-\\d{8}$`)] as const)

/** Catalogue id for an exact id or its dated snapshot (`claude-opus-5-20260901`); never a looser prefix. */
function exactKey(model: string): string | undefined {
  return Object.hasOwn(PRICING, model) ? model : DATED.find(([, dated]) => dated.test(model))?.[0]
}

/**
 * True only when `costUsd` bills this model at its own published rates. Paid acceptance
 * requires this for every configured and served model; the app itself keeps the
 * fallback below so an unlisted id still runs (overstated against the fallback rates).
 */
export function hasExactPricing(model: string): boolean {
  return model === OPENAI_MODEL || exactKey(model) !== undefined
}

/** Exact or dated id first, then the longest catalogue id that prefixes the model, then the fallback. */
export function ratesFor(model: string): Rates {
  if (model === OPENAI_MODEL) return OPENAI_RATES
  if (/^(gpt-|o[1-9]|chatgpt-)/.test(model)) throw new Error(`No OpenAI pricing profile for ${model}`)
  const key = exactKey(model) ?? Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? PRICING[key] : FALLBACK_RATES
}

export function costUsd(u: LLMUsage): number {
  if (u.provider === 'openai' && u.model !== OPENAI_MODEL) throw new Error(`No OpenAI pricing profile for ${u.model}`)
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol (2026-09-05).
  // Promotional rates through at least 2026-11-21; >272K input bills the whole
  // request at 2x input (including caches), 1.5x output. Reasoning is in output.
  const rates = ratesFor(u.model)
  const prompt = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
  let input = rates.input
  let output = rates.output
  if (u.model === OPENAI_MODEL && prompt > 272_000) {
    input *= 2
    output *= 1.5
  } else if (rates.longPrompt && prompt > rates.longPrompt.aboveTokens) {
    input = rates.longPrompt.input
    output = rates.longPrompt.output
  }
  const perTokenIn = input / 1e6
  const perTokenOut = output / 1e6
  return (
    u.inputTokens * perTokenIn +
    u.outputTokens * perTokenOut +
    u.cacheReadTokens * perTokenIn * rates.cacheRead +
    u.cacheWriteTokens * perTokenIn * CACHE_WRITE
  )
}
