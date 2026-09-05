import Anthropic from '@anthropic-ai/sdk'
import type { Config, LLM, LLMRequest, LLMResult, LLMUsage } from '../contracts.js'
import { LLMAbortedError } from '../contracts.js'

const CREDENTIALS_MESSAGE = 'Anthropic credentials rejected — set ANTHROPIC_API_KEY or run `ant auth login`'
const NO_CREDENTIALS_MESSAGE = 'No Anthropic credentials found — set ANTHROPIC_API_KEY or run `ant auth login`'

/** The SDK throws this before any request when it finds no key, token or profile. */
const missingCredentials = (err: unknown): boolean =>
  err instanceof Error && !(err instanceof Anthropic.APIError) && /authentication method/i.test(err.message)

/** Gates the `fallbacks: 'default'` scalar form; the array form needs a different header. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export function createAnthropicLLM(_config: Config): LLM {
  // Zero-arg: the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
  // maxRetries covers 429s and 5xx so the orchestrator never sees a transient failure.
  const client = new Anthropic({ maxRetries: 3 })

  return {
    kind: 'anthropic',

    async complete(req: LLMRequest): Promise<LLMResult> {
      if (req.signal.aborted) throw new LLMAbortedError()

      const stream = client.beta.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort: req.effort },
          // Explicit marker on the frozen system prefix, plus top-level automatic caching so the
          // breakpoint also moves along the growing conversation (last tool_result / text block).
          cache_control: { type: 'ephemeral' },
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          tools: req.tools,
          messages: req.messages,
        },
        { signal: req.signal },
      )
      const onText = req.onText
      if (onText) stream.on('text', (delta) => onText(delta))

      let msg: Anthropic.Beta.BetaMessage
      try {
        msg = await stream.finalMessage()
      } catch (err) {
        throw translateError(err, req.signal)
      }
      return toResult(msg, req.model)
    },

    async healthcheck(model: string): Promise<string | null> {
      try {
        await client.models.retrieve(model)
        return null
      } catch (err) {
        if (missingCredentials(err)) return NO_CREDENTIALS_MESSAGE
        if (err instanceof Anthropic.AuthenticationError) return CREDENTIALS_MESSAGE
        if (err instanceof Anthropic.NotFoundError) return `model ${model} not found for this account`
        return err instanceof Error ? err.message : String(err)
      }
    },
  }
}

function toResult(msg: Anthropic.Beta.BetaMessage, requestedModel: string): LLMResult {
  const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const result: LLMResult = {
    content: msg.content,
    toolUses,
    text,
    stopReason: msg.stop_reason,
    usage: toUsage(msg, requestedModel),
  }
  if (msg.stop_reason === 'refusal') {
    result.refusal = {
      category: msg.stop_details?.category ?? null,
      explanation: msg.stop_details?.explanation ?? null,
    }
  }
  return result
}

function toUsage(msg: Anthropic.Beta.BetaMessage, requestedModel: string): LLMUsage {
  const u = msg.usage
  // A fallback_message iteration means another model served the turn; price at that model's rates.
  const fellBack = (u.iterations ?? []).some((it) => it.type === 'fallback_message')
  return {
    model: fellBack ? msg.model : requestedModel,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  }
}

function translateError(err: unknown, signal: AbortSignal): Error {
  if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return new LLMAbortedError()
  if (err instanceof Error && err.name === 'AbortError') return new LLMAbortedError()
  if (missingCredentials(err)) return new Error(NO_CREDENTIALS_MESSAGE)
  if (err instanceof Anthropic.AuthenticationError) return new Error(CREDENTIALS_MESSAGE)
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}
