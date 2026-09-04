import type { LLMUsage } from '../contracts.js'

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
  const key = Object.keys(PRICING)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? PRICING[key] : FALLBACK_RATES
}

export function costUsd(u: LLMUsage): number {
  const { input, output } = ratesFor(u.model)
  const perTokenIn = input / 1e6
  const perTokenOut = output / 1e6
  return (
    u.inputTokens * perTokenIn +
    u.outputTokens * perTokenOut +
    u.cacheReadTokens * perTokenIn * 0.1 +
    u.cacheWriteTokens * perTokenIn * 1.25
  )
}
