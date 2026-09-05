import type { LLMUsage } from '../contracts.js'
import { OPENAI_MODEL } from './openai-profile.js'

/** USD per 1M tokens. Cache reads bill at 0.1× input, cache writes at 1.25× input. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 },
}

const FALLBACK_RATES = PRICING['claude-opus-5']

/** Longest catalogue id that prefixes the model (so dated ids like `claude-opus-5-20260901` still match). */
export function ratesFor(model: string): { input: number; output: number } {
  if (model === OPENAI_MODEL) return { input: 4, output: 20 }
  if (/^(gpt-|o[1-9]|chatgpt-)/.test(model)) throw new Error(`No OpenAI pricing profile for ${model}`)
  const key = Object.keys(PRICING)
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
  const longContext = u.model === OPENAI_MODEL && u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens > 272_000
  const input = rates.input * (longContext ? 2 : 1)
  const output = rates.output * (longContext ? 1.5 : 1)
  const perTokenIn = input / 1e6
  const perTokenOut = output / 1e6
  return (
    u.inputTokens * perTokenIn +
    u.outputTokens * perTokenOut +
    u.cacheReadTokens * perTokenIn * 0.1 +
    u.cacheWriteTokens * perTokenIn * 1.25
  )
}
