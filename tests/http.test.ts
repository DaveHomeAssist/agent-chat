import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from '../server/http.js'
import { deferred, harness, reply, settle, until, usage } from './helpers.js'
import type { LLMResult } from '../server/contracts.js'

async function serve(t: TestContext, h: ReturnType<typeof harness>) {
  const server = createServer(h)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

test('inherited HTTP origin, body, method and rate protections remain enforced', async (t) => {
  const h = harness(t, async () => reply())
  const url = await serve(t, h)
  const post = (path: string, body = '{}', headers: Record<string, string> = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
  assert.equal((await post('/api/run/start', '{}', { Origin: 'https://elsewhere.example' })).status, 403)
  assert.equal((await post('/api/run/start', '{}', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await post('/api/run/start', '{')).status, 400)
  assert.equal((await post('/api/run/start', JSON.stringify({ text: 'x'.repeat(65536) }))).status, 413)
  assert.equal((await fetch(url + '/api/run/start')).status, 405)
  assert.equal((await post('/api/message', '{}', { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await post('/api/run/start', '{}', { Origin: url })).status, 200)
  for (let n = 0; n < 5; n++) assert.equal((await post('/api/message', JSON.stringify({ body: `hello ${n}`, target: 'all' }))).status, 200)
  assert.equal((await post('/api/message', JSON.stringify({ body: 'overflow', target: 'all' }))).status, 429)
})

test('lifetime protection includes late old-run usage and survives multiple resets', async (t) => {
  const pending = deferred<LLMResult>()
  let calls = 0
  const h = harness(t, async () => ++calls === 1 ? pending.promise : reply(), { env: { LIFETIME_BUDGET_USD: '1' } })
  const url = await serve(t, h)
  const start = () => fetch(url + '/api/run/start', { method: 'POST' })
  assert.equal((await start()).status, 200)
  await until(() => calls === 1)
  assert.equal((await start()).status, 200)
  await settle()
  pending.resolve(reply([], 200_000))
  await until(() => h.store.lifetimeCostUsd() === 1)
  assert.equal(h.store.stats().costUsd, 0)
  assert.equal((await start()).status, 403)
  h.store.reset({ status: 'live' })
  assert.equal((await start()).status, 403)
})

test('ordinary reported spend also blocks later starts across resets', async (t) => {
  const h = harness(t, async () => reply(), { env: { LIFETIME_BUDGET_USD: '1' } })
  const url = await serve(t, h)
  h.store.addUsage(usage(100_000))
  h.store.reset({ status: 'live' })
  h.store.addUsage(usage(100_000))
  const result = await fetch(url + '/api/run/start', { method: 'POST' })
  assert.equal(result.status, 403)
  assert.match((await result.json() as { error: string }).error, /lifetime budget/)
})
