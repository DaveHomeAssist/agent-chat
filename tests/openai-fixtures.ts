import OpenAI from 'openai'
import { setTimeout as delay } from 'node:timers/promises'
import type { ResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses'
import type { Config, LLM, LLMResult } from '../server/contracts.js'
import { createMockLLM } from '../server/llm/mock.js'
import { createOpenAILLM } from '../server/llm/openai.js'

export const apiUsage: ResponseUsage = {
  input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
  output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 }, total_tokens: 1100,
}
export const encode = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
export const message = (text = 'hello'): ResponseOutputItem => ({ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] })
export const reasoning: Extract<ResponseOutputItem, { type: 'reasoning' }> = { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-reasoning-fixture' }
export const call = (name = 'run_read_status', args = '{}', id = 'call_test'): ResponseOutputItem => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: args, status: 'completed' })
export const completed = (output: ResponseOutputItem[] = [message()], usage: ResponseUsage | null = apiUsage, status = 'completed') => ({
  type: `response.${status}`, response: { id: 'resp_test', object: 'response', model: 'gpt-5.6-sol', status, output, usage, error: status === 'failed' ? { code: 'server_error' } : null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null },
})
export function sse(events: Record<string, unknown>[]): Response {
  return new Response(events.map(encode).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
}
export const clientWith = (fetch: NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch']) => new OpenAI({ apiKey: 'offline-fixture-only', maxRetries: 0, fetch })

let responseSeq = 0
export function eventsFor(result: LLMResult): Record<string, unknown>[] {
  const id = ++responseSeq
  const output = [{ ...reasoning, id: `rs_${id}` }, ...(result.text ? [{ ...message(result.text), id: `msg_${id}` }] : []), ...result.toolUses.map((t) => call(t.name, JSON.stringify(t.input), t.id))]
  return [
    ...(result.text.match(/[\s\S]{1,24}/g) ?? []).map((delta) => ({ type: 'response.output_text.delta', delta })),
    ...output.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item: item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' } : item },
      ...(item.type === 'function_call' ? [
        { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments.slice(0, 4) },
        { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments.slice(4) },
        { type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: item.arguments },
      ] : []),
      { type: 'response.output_item.done', output_index, item },
    ]), completed(output),
  ]
}

/** Scripted story over the real SDK/adapter. No network transport is available. */
export function scriptedOpenAI(config: Config, payloads: Record<string, unknown>[] = []): LLM {
  const script = createMockLLM(config)
  return {
    kind: 'openai', healthcheck: async () => null,
    async complete(req) {
      const client = clientWith(async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)))
        const result = await script.complete({ ...req, onText: undefined })
        const events = eventsFor(result)
        if (!config.mockSpeed) return sse(events)
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
      return createOpenAILLM(config, client).complete(req)
    },
  }
}
