import test from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import { loadConfig } from '../server/config.js'
import { LLMRequestError } from '../server/contracts.js'
import { createAnthropicLLM } from '../server/llm/anthropic.js'

const config = loadConfig({ MOCK_LLM: '1' })
const encode = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const start = { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 } } }
const request = { agent: 'atlas' as const, model: config.models.atlas, system: 'test', tools: [], messages: [{ role: 'user' as const, content: 'test' }], maxTokens: 16, effort: 'medium' as const, signal: new AbortController().signal }

test('Anthropic adapter sends configured effort and reads final reported usage through the real SDK without network', async () => {
  let payload: Record<string, unknown> | undefined
  const client = new Anthropic({ apiKey: 'test-only', maxRetries: 0, fetch: async (_url, init) => {
    payload = JSON.parse(String(init?.body))
    const events = [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' }]
    return new Response(events.map(encode).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  const result = await createAnthropicLLM(config, client).complete(request)
  assert.deepEqual(payload?.output_config, { effort: 'medium' })
  assert.deepEqual(payload?.cache_control, { type: 'ephemeral' })
  assert.equal(payload?.fallbacks, 'default')
  assert.equal(result.text, 'hello')
  assert.deepEqual(result.usage, { model: config.models.atlas, inputTokens: 100, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 10 })
})

test('Anthropic stream failure retains the last known usage', async () => {
  const client = new Anthropic({ apiKey: 'test-only', maxRetries: 0, fetch: async () => new Response(
    encode(start) + encode({ type: 'error', error: { type: 'overloaded_error', message: 'stream failed' } }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  ) })
  await assert.rejects(createAnthropicLLM(config, client).complete(request), (error: unknown) => {
    assert.ok(error instanceof LLMRequestError)
    assert.equal(error.usage?.inputTokens, 100)
    assert.equal(error.usage?.cacheReadTokens, 20)
    return true
  })
})
