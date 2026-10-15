import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspace } from '../server/workspace.js'
import { buildFeature, ready } from './helpers.js'

test('merge requires a push, positive review and passing full e2e evidence', async () => {
  const ws = createWorkspace()
  assert.match(ws.pr.merge().reason!, /no commits/)
  buildFeature(ws)
  assert.match(ws.pr.merge().reason!, /positive review/)
  ws.pr.review('sentry', 'request_changes', 'fix first')
  assert.equal(ws.pr.merge().ok, false)
  ws.pr.review('sentry', 'approve', 'reviewed')
  assert.match(ws.pr.merge().reason!, /full e2e/)
  await ws.run('pnpm test')
  assert.equal(ws.pr.merge().ok, false, 'unit tests are not full e2e')
  await ws.run('pnpm e2e --grep windowsHello')
  assert.equal(ws.pr.merge().ok, false, 'partial coverage is not sufficient')
  await ws.run('pnpm e2e --grep missing')
  assert.equal(ws.pr.merge().ok, false, 'zero coverage is not sufficient')
  await ws.run('pnpm e2e --grep passkey')
  assert.equal(ws.pr.merge().ok, true, 'a filter selecting all 24 cases is full coverage')
})

test('failed e2e prevents merge despite positive review', async () => {
  const ws = createWorkspace()
  buildFeature(ws, true)
  assert.equal((await ws.run('pnpm e2e')).tests?.failed, 2)
  ws.pr.review('sentry', 'approve', 'approved')
  assert.equal(ws.pr.merge().ok, false)
  assert.equal(ws.pr.state().merged, false)
})

for (const change of ['write', 'patch', 'remove', 'docs', 'migration', 'push', 'rollback', 'newline'] as const) {
  test(`${change} invalidates revision evidence`, async () => {
    const ws = createWorkspace()
    await ready(ws)
    const before = ws.revision()
    const path = 'services/auth/webauthn/register.ts'
    switch (change) {
      case 'write': ws.write('extra.ts', 'export const x = 1'); break
      case 'patch': ws.patch(path, [{ find: 'true', replace: 'false' }]); break
      case 'remove': ws.remove(path); break
      case 'docs': ws.docs.write('note.md', 'new decision'); break
      case 'migration': ws.migrations.apply('0044_extra', 'CREATE TABLE extra (id INT);'); break
      case 'push': ws.push('same content, different revision'); break
      case 'rollback': ws.rollback(); break
      case 'newline': ws.write(path, ws.read(path)!.trimEnd()); break
    }
    assert.ok(ws.revision() > before)
    assert.equal(ws.pr.state().review, 'none')
    assert.equal(ws.lastTests(), null)
    assert.equal(ws.pr.merge().ok, false)
    if (change === 'newline') {
      assert.equal(ws.diff().files, 0, 'the display diff omits final newlines')
      await ws.run('pnpm e2e')
      ws.pr.review('sentry', 'approve', 'review')
      assert.match(ws.pr.merge().reason!, /unpushed/, 'byte differences still block merge')
    }
  })
}

test('blocking comments hold merge and returned evidence cannot be edited externally', async () => {
  const ws = createWorkspace()
  await ready(ws)
  const comment = ws.pr.comment('sentry', 'blocking finding', true)
  comment.resolved = true
  ws.pr.state().comments[0].resolved = true
  assert.equal(ws.pr.merge().ok, false)
  ws.pr.resolve(comment.id)
  assert.equal(ws.pr.merge().ok, true)
})

test('an unpushed fix cannot green the last pushed revision', async () => {
  const ws = createWorkspace()
  buildFeature(ws, true)
  ws.patch('services/auth/webauthn/verify.ts', [{ find: '>=', replace: '>' }])
  assert.equal((await ws.run('pnpm e2e')).tests?.failed, 2)
  ws.pr.review('sentry', 'approve', 'review')
  assert.equal(ws.pr.merge().ok, false)
  ws.push('fixed')
  await ws.run('pnpm e2e')
  assert.equal(ws.pr.merge().ok, false, 'old review is stale after push')
  ws.pr.review('sentry', 'approve', 'review new revision')
  assert.equal(ws.pr.merge().ok, true)
})

// First paid M1 run, October 14: Opus 5.5 built services/auth/passkey/* with
// /auth/passkey/* routes and a webauthn_credentials table. The suite then failed all
// 24 cases with 404 because it looked only for services/auth/webauthn/{register,verify}.ts.
function buildRun1Layout(ws: ReturnType<typeof createWorkspace>, options: { replayGuard?: '>' | '>='; credIdType?: 'BYTEA' | 'TEXT' } = {}) {
  ws.write('services/auth/passkey/register.ts', [
    "import type { FastifyInstance } from 'fastify'",
    "import { flag } from '../../../config/flags'",
    'export async function passkeyRegisterRoutes(app: FastifyInstance): Promise<void> {',
    "  if (!flag('auth.passkeys')) return",
    "  app.post('/auth/passkey/register/options', async () => ({ challenge: 'c' }))",
    "  app.post('/auth/passkey/register', async () => ({ ok: true }))",
    '}',
    '',
  ].join('\n'))
  ws.write('services/auth/passkey/login.ts', [
    "import type { FastifyInstance } from 'fastify'",
    "import { flag } from '../../../config/flags'",
    "import { counterAdvanced } from './counter'",
    'export async function passkeyLoginRoutes(app: FastifyInstance): Promise<void> {',
    "  if (!flag('auth.passkeys')) return",
    "  app.post('/auth/passkey/login', async () => ({ ok: counterAdvanced(1, 0) }))",
    '}',
    '',
  ].join('\n'))
  ws.write('services/auth/passkey/counter.ts', `// WebAuthn sign counter guard\nexport const counterAdvanced = (signCount: number, stored: number) => signCount ${options.replayGuard ?? '>'} stored\n`)
  assert.equal(ws.migrations.apply('0043_webauthn', `CREATE TABLE IF NOT EXISTS webauthn_credentials (credential_id ${options.credIdType ?? 'BYTEA'} PRIMARY KEY, sign_count INTEGER NOT NULL);`).ok, true)
  ws.push('feat(auth): passkey register/login behind auth.passkeys')
}

test('the e2e suite judges the pushed passkey layout, not a fixed webauthn directory', async () => {
  const ws = createWorkspace()
  buildRun1Layout(ws)
  const result = await ws.run('pnpm e2e')
  assert.equal(result.tests?.passed, 24, result.stdout)
  assert.equal(result.tests?.failed, 0)
  ws.pr.review('sentry', 'approve', 'reviewed the passkey layout')
  assert.equal(ws.pr.merge().ok, true)
})

test('the seed tree and non-passkey routes still fail every case with 404', async () => {
  const ws = createWorkspace()
  const seed = await ws.run('pnpm e2e')
  assert.equal(seed.tests?.failed, 24)
  assert.ok(seed.tests?.failures.every((f) => /404 route not mounted/.test(f)), seed.tests?.failures.join('\n'))
  // The seed's own /auth/login and /auth/otp/verify routes, and a login spec, carry no passkey word.
  ws.write('e2e/passkey-login.spec.ts', "test('passkey login', () => fetch('/auth/passkey/login'))\n")
  ws.write('services/auth/routes.ts', ws.read('services/auth/routes.ts')! + '\n// TODO: mount passkey routes\n')
  ws.push('notes only')
  const after = await ws.run('pnpm e2e')
  // The pushed passkey-login spec is collected and judged like the login group: 25 cases, all 404.
  assert.equal(after.tests?.total, 25)
  assert.equal(after.tests?.failed, 25)
  assert.equal(ws.lastTests()?.suite.passed, 0)
  assert.ok(after.tests?.failures.every((f) => /404 route not mounted/.test(f)), after.tests?.failures.join('\n'))
})

test('the suite collects the specs the branch pushes, so --grep on their names selects them', async () => {
  const ws = createWorkspace()
  buildRun1Layout(ws)
  const before = await ws.run('pnpm e2e')
  ws.write('e2e/playwright.config.ts', "export default { projects: [{ name: 'flag-on' }, { name: 'flag-off' }] }\n")
  ws.write('e2e/passkey-flags.spec.ts', [
    "import { test, expect } from '@playwright/test'",
    "test.describe('passkey', () => {",
    "  test('passkey.flag_off → 404', async () => { expect(1).toBe(1) })",
    "  test('passkey.counter.zero_zero', async () => { expect(1).toBe(1) })",
    "})",
    "test('healthz still answers', async () => {})",
    '',
  ].join('\n'))
  ws.push('probe specs')
  const grep = await ws.run('pnpm e2e --grep passkey.flag_off')
  assert.equal(grep.tests?.total, 1, grep.stdout)
  assert.match(grep.stdout, /\[flag-on\] › e2e\/passkey-flags\.spec\.ts:3:3 › passkey › passkey\.flag_off → 404/)
  assert.equal((await ws.run('pnpm e2e --grep healthz')).tests?.total, 1)
  assert.equal((await ws.run('pnpm e2e --grep nothing-like-this')).tests?.total, 0)
  const full = await ws.run('pnpm e2e')
  assert.equal(full.tests?.total, 27, full.stdout)
  assert.equal(full.tests?.failed, 0)
  assert.deepEqual(ws.lastTests()?.suite, { passed: 24, total: 24 })
  assert.equal(ws.lastTests()?.fullSuite, true)
  assert.notEqual(before.stdout.split('\n').slice(4, 8).join('\n'), full.stdout.split('\n').slice(4, 8).join('\n'), 'per-case durations change with the sha under test')
  ws.pr.review('sentry', 'approve', 'reviewed')
  assert.equal(ws.pr.merge().ok, true, 'collected specs do not change the gate when the canonical suite is green')
})

test('a collected passkey spec is judged by the step rules of its group', async () => {
  const ws = createWorkspace()
  // Register mounted, login not: the canonical register cases pass, every login case fails 404, including the branch's own.
  ws.write('services/auth/passkey/register.ts', "export const route = '/auth/passkey/register'\n")
  assert.equal(ws.migrations.apply('0043_passkeys', 'CREATE TABLE passkeys (credential_id BYTEA);').ok, true)
  ws.write('e2e/passkey-login.spec.ts', "test('passkey login via windows hello', async () => {})\ntest('healthz', async () => {})\n")
  ws.push('register only')
  const run = await ws.run('pnpm e2e')
  assert.equal(run.tests?.total, 26)
  assert.ok(run.tests?.failures.includes('passkey login via windows hello → 404 route not mounted'), run.tests?.failures.join('\n'))
  assert.ok(!run.tests?.failures.some((f) => /^register\./.test(f) || /^healthz/.test(f)), run.tests?.failures.join('\n'))
  assert.equal(ws.lastTests()?.suite.passed, 12)
})

test('pnpm test lists only the test files the tree holds and counts their cases', async () => {
  const ws = createWorkspace()
  const none = await ws.run('pnpm test')
  assert.equal(none.exitCode, 0)
  assert.match(none.stdout, /No test files found/)
  assert.equal(none.tests?.total, 0)
  assert.doesNotMatch(none.stdout, /services\/auth\/routes\.test\.ts/, 'no phantom file for a source file without a test')
  ws.write('services/auth/passkeys/policy.test.ts', "import { it } from 'vitest'\nit('limits', () => {})\nit('ttl', () => {})\ntest.skip('later', () => {})\n")
  const some = await ws.run('pnpm test')
  assert.match(some.stdout, /✓ services\/auth\/passkeys\/policy\.test\.ts \(3 tests\)/)
  assert.equal(some.tests?.total, 3)
  assert.equal(some.stdout.split('\n').filter((l) => /\.test\.ts/.test(l)).length, 1)
})

test('replay and credential-id rules follow the pushed layout', async () => {
  const replay = createWorkspace()
  buildRun1Layout(replay, { replayGuard: '>=' })
  const result = await replay.run('pnpm e2e')
  assert.deepEqual(result.tests?.failures.map((f) => f.split(' ')[0]).sort(), ['login.windowsHello', 'register.reregister'])
  assert.match(replay.artifact('trace-latest.zip') ?? '', /services\/auth\/passkey\/counter\.ts: sign counter guard/)
  const textId = createWorkspace()
  buildRun1Layout(textId, { credIdType: 'TEXT' })
  assert.deepEqual((await textId.run('pnpm e2e')).tests?.failures.map((f) => f.split(' ')[0]), ['login.windowsHello'])
  assert.ok(textId.secScan().some((f) => f.level === 'RISK' && /credential_id stored as text/.test(f.msg)))
})
