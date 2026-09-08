import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request, type IncomingMessage } from 'node:http'
import { createServer } from '../server/http.js'
import { deferred, harness, reply, settle, until, usage } from './helpers.js'
import type { LLMResult } from '../server/contracts.js'

async function serve(t: TestContext, h: ReturnType<typeof harness>, onRequest?: (req: IncomingMessage) => void) {
  const server = createServer(h)
  if (onRequest) server.on('request', onRequest)
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

test('message and interrupt return explicit conflicts for unavailable runs without effects', async (t) => {
  for (const state of ['idle', 'done', 'failed', 'disposed'] as const) {
    const h = harness(t, async () => reply())
    if (state === 'disposed') { await h.orchestrator.start(); await settle(); h.orchestrator.dispose() }
    else h.store.setRun({ status: state })
    const url = await serve(t, h)
    const before = h.store.snapshot()
    const events: unknown[] = []
    h.store.subscribe((event) => events.push(event))
    for (const path of ['/api/message', '/api/agents/atlas/interrupt']) {
      const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Keep draft', target: 'all' }) })
      assert.equal(response.status, 409, `${state}: ${path}`)
      assert.deepEqual(await response.json(), { ok: false, error: 'run is not active' })
    }
    assert.deepEqual(h.store.snapshot(), before)
    assert.deepEqual(events, [])
  }
})

test('HTTP accepts paused messages and one live interrupt, then refuses the aborted operation', async (t) => {
  const pending = deferred<LLMResult>()
  let aborts = 0
  const h = harness(t, async (req) => {
    req.signal.addEventListener('abort', () => { aborts++ })
    return pending.promise
  })
  const url = await serve(t, h)
  await h.orchestrator.start()
  await until(() => h.requests.length === 1)
  h.orchestrator.pause()
  const post = (path: string, body = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const message = await post('/api/message', { body: 'Accepted while paused', target: 'forge' })
  assert.equal(message.status, 200)
  assert.equal((await message.json() as { ok: boolean }).ok, true)
  assert.equal(h.requests.length, 1)
  assert.equal(h.store.snapshot().thread.filter((item) => item.kind === 'human' && item.body === 'Accepted while paused').length, 1)
  const interrupted = await post('/api/agents/atlas/interrupt')
  assert.equal(interrupted.status, 200)
  assert.equal((await interrupted.json() as { ok: boolean }).ok, true)
  assert.equal(aborts, 1)
  const before = h.store.snapshot()
  const again = await post('/api/agents/atlas/interrupt')
  assert.equal(again.status, 409)
  assert.deepEqual(await again.json(), { ok: false, error: 'agent has no active operation' })
  assert.equal(aborts, 1)
  assert.deepEqual(h.store.snapshot(), before)
  pending.resolve(reply())
})

for (const command of ['message', 'interrupt'] as const) {
  test(`${command} held body refuses a run or operation that became unavailable before acceptance`, async (t) => {
    const pending = deferred<LLMResult>()
    const h = harness(t, async () => pending.promise)
    let incoming: IncomingMessage | undefined
    const url = await serve(t, h, (req) => { incoming = req })
    await h.orchestrator.start()
    await until(() => h.requests.length === 1)
    assert.equal(h.store.snapshot().run.status, 'live')
    assert.equal(h.requests[0].signal.aborted, false)
    const body = JSON.stringify(command === 'message' ? { body: 'State changed while uploading', target: 'forge' } : {})
    const path = command === 'message' ? '/api/message' : '/api/agents/atlas/interrupt'
    let held!: ReturnType<typeof request>
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      held = request(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let result = ''
        res.on('data', (chunk: Buffer) => { result += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode!, body: result }))
        res.on('error', reject)
      })
      held.on('error', reject)
    })
    t.after(() => held.destroy())
    held.flushHeaders()
    await until(() => !!incoming && incoming.listenerCount('data') > 0, 'authorized handler waiting for command body')
    if (command === 'message') h.orchestrator.dispose()
    pending.resolve(reply())
    await settle()
    const before = h.store.snapshot()
    const events: unknown[] = []
    h.store.subscribe((event) => events.push(event))
    held.end(body)
    const denied = await response
    assert.equal(denied.status, 409)
    assert.deepEqual(JSON.parse(denied.body), { ok: false, error: command === 'message' ? 'run is not active' : 'agent has no active operation' })
    assert.deepEqual(h.store.snapshot(), before)
    assert.deepEqual(events, [])
    assert.equal(h.requests.length, 1)
  })
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
