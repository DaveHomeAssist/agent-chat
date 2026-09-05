import { LLMRequestError } from '../contracts.js'
import type { Effort } from '../contracts.js'

export const OPENAI_MODEL = 'gpt-5.6-sol'
export const OPENAI_EFFORTS: readonly Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

export function validateOpenAIProfile(model: string, effort: Effort, source = 'OpenAI model'): void {
  if (model !== OPENAI_MODEL) throw new LLMRequestError(`${source}: unsupported OpenAI model "${model}"; use ${OPENAI_MODEL}`)
  if (!OPENAI_EFFORTS.includes(effort)) throw new LLMRequestError(`EFFORT for ${model} must be ${OPENAI_EFFORTS.join(', ')}`)
}
