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
