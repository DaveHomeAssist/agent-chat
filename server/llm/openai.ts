import OpenAI from 'openai'
import type { Response as ModelResponse, ResponseInput, ResponseUsage } from 'openai/resources/responses/responses'
import type { Config, LLM, LLMRequest, LLMResult, LLMToolCall, LLMUsage } from '../contracts.js'
import { LLMAbortedError, LLMRequestError } from '../contracts.js'
import { validateOpenAIProfile } from './openai-profile.js'

const NO_KEY = 'No OpenAI credentials found — set OPENAI_API_KEY on the server and restart'

/** Injection is for offline SDK tests. Production always uses the official endpoint. */
export function createOpenAILLM(_config: Config, injectedClient?: OpenAI): LLM {
  let client = injectedClient
  function getClient(): OpenAI {
    if (client) return client
    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) throw new LLMRequestError(NO_KEY)
    // Explicit endpoint prevents OPENAI_BASE_URL from redirecting production credentials.
    // Do not retry ambiguous failures: usage may already have been incurred.
    client = new OpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: 120_000 })
    return client
  }

  return {
    kind: 'openai',
    async healthcheck(model) {
      try {
        validateOpenAIProfile(model, 'high')
        await getClient().models.retrieve(model)
        return null
      } catch (error) {
        return problem(error, model)
      }
    },
    async complete(req): Promise<LLMResult> {
      if (req.signal.aborted) throw new LLMAbortedError()
      let reportedUsage: LLMUsage | undefined
      try {
        validateOpenAIProfile(req.model, req.effort)
        const input = toInput(req)
        const stream = await getClient().responses.create({
          model: req.model,
          instructions: req.system,
          input,
          tools: req.tools.map((tool) => ({
            type: 'function', name: tool.name, description: tool.description,
            parameters: { ...tool.input_schema }, strict: tool.strict,
          })),
          reasoning: { effort: req.effort },
          max_output_tokens: req.maxTokens,
          store: false,
          include: ['reasoning.encrypted_content'],
          service_tier: 'default',
          stream: true,
        }, { signal: req.signal })
        let final: ModelResponse | undefined
        for await (const event of stream) {
          if ('response' in event && event.response.usage) {
            reportedUsage = normalizeUsage(event.response.usage, req.model)
          }
          if (req.signal.aborted) throw new LLMAbortedError(reportedUsage)
          if (event.type === 'response.output_text.delta') req.onText?.(event.delta)
          if (event.type === 'response.completed') final = event.response
          if (event.type === 'response.failed') throw new LLMRequestError(`OpenAI response failed (${event.response.error?.code ?? 'unknown'}); retry after checking account and service status`, reportedUsage)
          if (event.type === 'response.incomplete') throw new LLMRequestError(`OpenAI response incomplete (${event.response.incomplete_details?.reason ?? 'unknown'}); no tools executed`, reportedUsage)
          if (event.type === 'error') throw new LLMRequestError(`OpenAI stream error (${event.code ?? 'unknown'}); no tools executed`, reportedUsage)
        }
        if (req.signal.aborted) throw new LLMAbortedError(reportedUsage)
        if (!final || final.status !== 'completed') throw new LLMRequestError('OpenAI stream ended without a completed response; usage may be unknown', reportedUsage)
        return toResult(final, req, reportedUsage)
      } catch (error) {
        if (req.signal.aborted || error instanceof OpenAI.APIUserAbortError || (error instanceof Error && error.name === 'AbortError')) {
          throw new LLMAbortedError(reportedUsage)
        }
        throw new LLMRequestError(problem(error, req.model), reportedUsage)
      }
    },
  }
}

function toInput(req: LLMRequest): ResponseInput {
  const input: ResponseInput = []
  for (const message of req.messages) {
    if (message.continuation) {
      if (message.continuation.provider !== 'openai') throw new LLMRequestError('Cannot mix provider conversation state')
      // Only the adapter constructs this opaque continuation, from complete API output.
      input.push(...message.continuation.items as ResponseInput)
      continue
    }
    if (typeof message.content === 'string') {
      input.push({ role: message.role, content: message.content })
      continue
    }
    for (const block of message.content) {
      if (block.type === 'text') input.push({ role: message.role, content: block.text })
      else if (block.type === 'tool_use') input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) })
      else input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content })
    }
  }
  return input
}

function toResult(response: ModelResponse, req: LLMRequest, usage?: LLMUsage): LLMResult {
  const toolUses: LLMToolCall[] = []
  const text: string[] = []
  const seen = new Set(req.messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content.filter((b) => b.type === 'tool_use').map((b) => b.id)))
  for (const item of response.output) {
    if (item.type === 'reasoning') {
      if (!item.encrypted_content) throw new LLMRequestError('OpenAI reasoning continuation is missing encrypted content', usage)
    } else if (item.type === 'message') {
      if (item.status !== 'completed') throw new LLMRequestError('OpenAI returned an incomplete message', usage)
      for (const block of item.content) {
        if (block.type === 'refusal') throw new LLMRequestError('OpenAI refused this request; revise the task before retrying', usage)
        text.push(block.text)
      }
    } else if (item.type === 'function_call') {
      if (item.status && item.status !== 'completed') throw new LLMRequestError('OpenAI returned an incomplete function call', usage)
      if (!item.call_id || seen.has(item.call_id)) throw new LLMRequestError('OpenAI returned a missing or duplicate function call ID', usage)
      seen.add(item.call_id)
      let args: unknown
      try { args = JSON.parse(item.arguments) } catch { throw new LLMRequestError(`OpenAI returned malformed arguments for ${item.name}`, usage) }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new LLMRequestError(`OpenAI arguments for ${item.name} must be a JSON object`, usage)
      toolUses.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args as Record<string, unknown> })
    } else {
      throw new LLMRequestError(`OpenAI returned unsupported output type ${item.type}`, usage)
    }
  }
  const body = text.join('')
  return {
    content: [...(body ? [{ type: 'text' as const, text: body }] : []), ...toolUses],
    toolUses, text: body, stopReason: toolUses.length ? 'tool_use' : 'end_turn', usage,
    continuation: { provider: 'openai', items: response.output },
  }
}

/** API input totals include both cache categories; output already includes reasoning. */
export function normalizeUsage(usage: ResponseUsage, model: string): LLMUsage {
  const read = usage.input_tokens_details?.cached_tokens
  const write = usage.input_tokens_details?.cache_write_tokens
  const input = usage.input_tokens - read - write
  const values = [input, usage.output_tokens, read, write]
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0)) throw new LLMRequestError('OpenAI returned invalid usage counters; cost is unknown')
  return { provider: 'openai', model, inputTokens: input, outputTokens: usage.output_tokens, cacheReadTokens: read, cacheWriteTokens: write }
}

function problem(error: unknown, model: string): string {
  if (error instanceof OpenAI.AuthenticationError) return 'OpenAI credentials rejected — check OPENAI_API_KEY on the server and restart'
  if (error instanceof OpenAI.PermissionDeniedError || error instanceof OpenAI.NotFoundError) return `OpenAI model ${model} is unavailable to this account; check project model access`
  if (error instanceof OpenAI.RateLimitError) return 'OpenAI rate or quota limit reached — check account quota and retry later'
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'OpenAI request timed out; usage may be unknown'
  if (error instanceof OpenAI.APIConnectionError) return 'OpenAI transport failed; check connectivity before retrying; usage may be unknown'
  if (error instanceof OpenAI.APIError) return `OpenAI API error ${error.status ?? 'unknown'}; check the configured model and request before retrying`
  if (error instanceof LLMRequestError) return error.message
  // Avoid exposing arbitrary transport responses, request content or credentials.
  return 'OpenAI request failed; check server configuration and transport'
}
