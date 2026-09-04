import type { Config, LLM } from '../contracts.js'
import { createAnthropicLLM } from './anthropic.js'
import { createMockLLM } from './mock.js'

export { LLMAbortedError } from '../contracts.js'
export { costUsd, PRICING } from './pricing.js'

export function createLLM(config: Config): LLM {
  return config.llm === 'mock' ? createMockLLM(config) : createAnthropicLLM(config)
}
