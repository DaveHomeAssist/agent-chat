import test from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { loadConfig } from '../server/config.js'
import { LLMAbortedError, LLMRequestError, type LLMRequest } from '../server/contracts.js'
import { createOpenAILLM, normalizeUsage } from '../server/llm/openai.js'
import { createLLM } from '../server/llm/index.js'
import { costUsd } from '../server/llm/pricing.js'
import { createToolRegistry } from '../server/tools.js'
import { apiUsage, call, clientWith, completed, encode, eventsFor, message, reasoning, sse } from './openai-fixtures.js'

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`)
const config = loadConfig({ LLM_PROVIDER: 'openai' })
const request = (): LLMRequest => ({ agent: 'atlas', model: 'gpt-5.6-sol', system: 'test', tools: createToolRegistry().definitionsFor('atlas'), messages: [{ role: 'user', content: 'test' }], maxTokens: 1000, effort: 'high', signal: new AbortController().signal })

test('provider config defaults, precedence, model isolation and real-provider auto-start', () => {
  assert.equal(loadConfig({}).llm, 'anthropic')
  assert.equal(loadConfig({}).models.atlas, 'claude-opus-5')
  assert.equal(loadConfig({ OPENAI_MODEL: 'ignored' }).models.atlas, 'claude-opus-5')
  assert.equal(config.autoStart, false)
  assert.ok(Object.values(config.models).every((m) => m === 'gpt-5.6-sol'))
  assert.equal(loadConfig({ LLM_PROVIDER: 'mock' }).autoStart, true)
  assert.equal(loadConfig({ MOCK_LLM: '1', LLM_PROVIDER: 'invalid', OPENAI_MODEL: 'ignored' }).llm, 'mock')
  assert.equal(loadConfig({ LLM_PROVIDER: 'openai', AGENT_MODEL_FORGE: 'gpt-5.6-sol' }).models.forge, 'gpt-5.6-sol')
  assert.equal(loadConfig({ AGENT_MODEL_FORGE: 'claude-sonnet-5' }).models.forge, 'claude-sonnet-5')
  assert.equal(createLLM(config).kind, 'openai', 'construction does not read credentials or make requests')
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(loadConfig({ LLM_PROVIDER: 'openai', EFFORT: effort }).effort, effort)
  for (const env of [{ LLM_PROVIDER: 'wrong' }, { LLM_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4o' }, { LLM_PROVIDER: 'openai', AGENT_MODEL_PROBE: 'claude-opus-5' }, { LLM_PROVIDER: 'openai', EFFORT: 'minimal' }, { EFFORT: 'none' }]) assert.throws(() => loadConfig(env))
})

test('OpenAI streams text, translates strict tools, and executes complete calls only once with opaque continuation', async () => {
  const payloads: Record<string, unknown>[] = []
  const toolUses = [{ type: 'tool_use' as const, id: 'call_test', name: 'run_read_status', input: {} }]
  const llm = createOpenAILLM(config, clientWith(async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)))
    return sse(payloads.length === 1 ? eventsFor({ content: toolUses, toolUses, text: 'hello', stopReason: 'tool_use' }) : [completed([message('continued')])])
  }))
  let text = ''
  const req = request()
  const result = await llm.complete({ ...req, onText: (delta) => { text += delta } })
  assert.equal(text, 'hello')
  assert.equal(result.toolUses.length, 1)
  assert.equal(result.toolUses[0].id, 'call_test')
  assert.equal(result.text, 'hello')
  assert.ok(!JSON.stringify(result.content).includes('opaque-reasoning'))
  await llm.complete({ ...req, messages: [...req.messages, { role: 'assistant', content: result.content, continuation: result.continuation }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_test', content: 'status result' }] }] })
  assert.equal(payloads[0].store, false)
  assert.equal(payloads[0].stream, true)
  assert.equal(payloads[0].service_tier, 'default')
  assert.deepEqual(payloads[0].reasoning, { effort: 'high' })
  assert.deepEqual(payloads[0].include, ['reasoning.encrypted_content'])
  assert.deepEqual(payloads[0].tools, req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: true })))
  const input = payloads[1].input as Record<string, unknown>[]
  assert.deepEqual(input[1], result.continuation?.items[0])
  assert.equal(input.filter((i) => i.type === 'function_call').length, 1)
  assert.deepEqual(input.at(-1), { type: 'function_call_output', call_id: 'call_test', output: 'status result' })
  assert.deepEqual(result.usage, { model: req.model, provider: 'openai', inputTokens: 700, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100 })
})

for (const [label, events, expected] of [
  ['incomplete', [completed([call()], apiUsage, 'incomplete')], /incomplete/],
  ['failed', [completed([call()], apiUsage, 'failed')], /failed/],
  ['malformed arguments', [completed([call('run_read_status', '{')])], /malformed arguments/],
  ['array arguments', [completed([call('run_read_status', '[]')])], /JSON object/],
  ['duplicate call', [completed([call(), call()])], /duplicate/],
  ['missing reasoning', [completed([{ ...reasoning, encrypted_content: '' }])], /encrypted content/],
  ['refusal', [completed([{ type: 'message', id: 'refused', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }])], /refused/],
] as const) {
  test(`OpenAI ${label} rejects the whole response and retains usage`, async () => {
    const llm = createOpenAILLM(config, clientWith(async () => sse([...events])))
    await assert.rejects(llm.complete(request()), (error: unknown) => {
      assert.ok(error instanceof LLMRequestError)
      assert.match(error.message, expected)
      assert.equal(error.usage?.outputTokens, 100)
      close(costUsd(error.usage!), 0.00538)
      return true
    })
  })
}

test('truncated stream and stream errors fail without inventing usage', async () => {
  for (const events of [[], [{ type: 'response.function_call_arguments.delta', delta: '{' }], [{ type: 'error', code: 'server_error', message: 'private raw response' }]]) {
    const llm = createOpenAILLM(config, clientWith(async () => sse(events)))
    await assert.rejects(llm.complete(request()), (error: unknown) => { assert.ok(error instanceof LLMRequestError); assert.equal(error.usage, undefined); assert.ok(!error.message.includes('private raw')); return true })
  }
})

for (const [status, match] of [[401, /credentials rejected/], [403, /model .* unavailable/], [404, /model .* unavailable/], [429, /quota limit/], [500, /API error 500/]] as const) {
  test(`OpenAI ${status} has actionable errors and no retry or fallback`, async () => {
    let requests = 0
    const llm = createOpenAILLM(config, clientWith(async () => { requests++; return new Response(JSON.stringify({ error: { message: 'private diagnostic' } }), { status }) }))
    assert.match((await llm.healthcheck(config.models.atlas))!, match)
    await assert.rejects(llm.complete(request()), match)
    assert.equal(requests, 2)
  })
}

test('transport failures are explicit and redact arbitrary diagnostics', async () => {
  const llm = createOpenAILLM(config, clientWith(async () => { throw new Error('private secret') }))
  await assert.rejects(llm.complete(request()), /transport failed/)
})

test('mixed provider continuation fails before transport', async () => {
  const llm = createOpenAILLM(config, clientWith(async () => { assert.fail('must not request') }))
  await assert.rejects(llm.complete({ ...request(), messages: [{ role: 'assistant', content: [], continuation: { provider: 'anthropic', items: [] } }] }), /mix provider/)
})

test('OpenAI pre-abort and mid-stream cancellation retain reported usage when available', async () => {
  const ac = new AbortController()
  ac.abort()
  const noRequest = createOpenAILLM(config, clientWith(async () => { assert.fail('must not request') }))
  await assert.rejects(noRequest.complete({ ...request(), signal: ac.signal }), LLMAbortedError)
  for (const reported of [false, true]) {
    const abort = new AbortController()
    const llm = createOpenAILLM(config, clientWith(async () => new Response(new ReadableStream({
      start(controller) {
        const terminal = completed([], reported ? apiUsage : null)
        controller.enqueue(new TextEncoder().encode(encode(terminal)))
        setTimeout(() => { abort.abort(); controller.error(new DOMException('aborted', 'AbortError')) }, 20)
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } })))
    await assert.rejects(llm.complete({ ...request(), signal: abort.signal }), (error: unknown) => {
      assert.ok(error instanceof LLMAbortedError)
      assert.equal(error.usage?.inputTokens, reported ? 700 : undefined)
      return true
    })
  }
})

test('OpenAI pricing covers normal, cached, cache write and long-context boundaries without reasoning double count', () => {
  const base = normalizeUsage(apiUsage, config.models.atlas)
  close(costUsd(base), 0.00538)
  for (const total of [272000, 272001]) {
    const u = normalizeUsage({ ...apiUsage, input_tokens: total, input_tokens_details: { cached_tokens: 100000, cache_write_tokens: 100000 } }, config.models.atlas)
    const multiplier = total > 272000 ? 2 : 1
    close(costUsd(u), ((total - 200000) * 4 + 100000 * .4 + 100000 * 5) * multiplier / 1e6 + 100 * 20 * (total > 272000 ? 1.5 : 1) / 1e6)
  }
  assert.throws(() => costUsd({ ...base, model: 'unsupported' }), /No OpenAI pricing/)
  assert.throws(() => costUsd({ ...base, provider: undefined, model: 'gpt-unknown' }), /No OpenAI pricing/)
  assert.throws(() => normalizeUsage({ ...apiUsage, input_tokens: 1 }, config.models.atlas), /invalid usage/)
  close(costUsd({ model: 'claude-opus-5', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100 }), .008225)
})


test('OpenAI missing credentials and production endpoint isolation use only an offline child transport', () => {
  const code = `
    import { createLLM } from './server/llm/index.ts';
    import { loadConfig } from './server/config.ts';
    const config = loadConfig({LLM_PROVIDER:'openai'});
    const missing = await createLLM(config).healthcheck(config.models.atlas);
    process.env.OPENAI_API_KEY = 'offline-child-key';
    process.env.OPENAI_BASE_URL = 'https://unexpected.invalid';
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({id:'gpt-5.6-sol',object:'model',owned_by:'openai',created:0}),{headers:{'Content-Type':'application/json'}});
    };
    const healthy = await createLLM(config).healthcheck(config.models.atlas);
    console.log(JSON.stringify({missing,healthy,urls}));
  `
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: { PATH: process.env.PATH, OPENAI_API_KEY: '' }, encoding: 'utf8' }))
  assert.match(result.missing, /set OPENAI_API_KEY on the server/)
  assert.equal(result.healthy, null)
  assert.deepEqual(result.urls, ['https://api.openai.com/v1/models/gpt-5.6-sol'])
})

for (const [input, read, write, expected] of [[1000, 0, 0, .004], [0, 1000, 0, .0004], [0, 0, 1000, .005]]) {
  test(`OpenAI disjoint input category ${input}/${read}/${write} is priced exactly once`, () => {
    close(costUsd({ provider: 'openai', model: 'gpt-5.6-sol', inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: 0 }), expected)
  })
}
