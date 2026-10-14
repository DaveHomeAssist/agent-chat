import Anthropic from '@anthropic-ai/sdk'
import { setTimeout as delay } from 'node:timers/promises'
import type { Config, LLM, LLMResult } from '../server/contracts.js'
import { createAnthropicLLM } from '../server/llm/anthropic.js'
import { createMockLLM } from '../server/llm/mock.js'

export const anthropicUsage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 }
const encode = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

let messageSeq = 0
/** Messages API stream events for one scripted result: opaque thinking, narration, then tool calls. */
export function anthropicEventsFor(result: LLMResult, model: string, servedModel = model): Record<string, unknown>[] {
  const id = ++messageSeq
  const blocks: Record<string, unknown>[] = [{ type: 'redacted_thinking', data: `opaque-anthropic-fixture-${id}` }]
  const events: Record<string, unknown>[] = [{
    type: 'message_start',
    message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: servedModel, content: [], stop_reason: null, stop_sequence: null, usage: { ...anthropicUsage, output_tokens: 0 } },
  }]
  events.push({ type: 'content_block_start', index: 0, content_block: blocks[0] }, { type: 'content_block_stop', index: 0 })
  let index = 1
  if (result.text) {
    events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    for (const delta of result.text.match(/[\s\S]{1,24}/g) ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } })
    events.push({ type: 'content_block_stop', index })
    index++
  }
  for (const tool of result.toolUses) {
    const json = JSON.stringify(tool.input)
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 4) } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(4) } },
      { type: 'content_block_stop', index },
    )
    index++
  }
  const fallback = servedModel !== model ? { iterations: [{ type: 'fallback_message' }] } : {}
  events.push(
    { type: 'message_delta', delta: { stop_reason: result.toolUses.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: anthropicUsage.output_tokens, ...fallback } },
    { type: 'message_stop' },
  )
  return events
}

interface ScriptOptions {
  payloads?: Record<string, unknown>[]
  /** Model reported as having served each turn; differing from the request simulates a server-side fallback. */
  servedModel?: (requested: string) => string
}

/** Scripted story over the real Anthropic SDK and adapter. No network transport is available. */
export function scriptedAnthropic(config: Config, options: ScriptOptions = {}): LLM {
  const script = createMockLLM(config)
  const payloads = options.payloads ?? []
  const clientFor = (fetch: NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch']) => new Anthropic({ apiKey: 'offline-fixture-only', authToken: null, maxRetries: 0, fetch })
  return {
    kind: 'anthropic',
    healthcheck: model => createAnthropicLLM(config, clientFor(async url => {
      const requested = decodeURIComponent(String(url).split('/').pop() ?? '')
      return Response.json({ type: 'model', id: requested, display_name: requested, created_at: '2026-01-01T00:00:00Z' })
    })).healthcheck(model),
    async complete(req) {
      const client = clientFor(async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)))
        const result = await script.complete({ ...req, onText: undefined })
        const events = anthropicEventsFor(result, req.model, options.servedModel?.(req.model))
        if (!config.mockSpeed) return new Response(events.map(encode).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        return new Response(new ReadableStream({
          async start(controller) {
            try {
              for (const event of events) {
                await delay(25 * config.mockSpeed, undefined, { signal: req.signal })
                controller.enqueue(new TextEncoder().encode(encode(event)))
              }
              controller.close()
            } catch (error) { controller.error(error) }
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      })
      return createAnthropicLLM(config, client).complete(req)
    },
  }
}
