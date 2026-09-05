import type { Config, LLM } from '../contracts.js'
import { createAnthropicLLM } from './anthropic.js'
import { createOpenAILLM } from './openai.js'
import { createMockLLM } from './mock.js'

export { LLMAbortedError } from '../contracts.js'
export { costUsd, PRICING } from './pricing.js'

export function createLLM(config: Config): LLM {
  if (config.llm === 'mock') return createMockLLM(config)
  if (config.llm === 'openai') return createOpenAILLM(config)
  return createAnthropicLLM(config)
}
