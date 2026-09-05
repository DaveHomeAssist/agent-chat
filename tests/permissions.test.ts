import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_IDS } from '../shared/protocol.js'
import { TOOL_CATALOGUE, toolNamesFor } from '../server/contracts.js'
import { createToolRegistry } from '../server/tools.js'
import { harness, reply, settle, tool, until } from './helpers.js'

test('direct registry execution enforces every catalogue permission before validation or effects', async (t) => {
  const h = harness(t, async () => reply())
  await h.orchestrator.start()
  await settle()
  for (const agent of AGENT_IDS) {
    for (const [name, entry] of Object.entries(TOOL_CATALOGUE)) {
      if (toolNamesFor(agent).includes(name)) continue
      const before = h.workspace.describe()
      const result = await h.tools.byApiName(entry.apiName)!.execute({ path: 'unauthorized.ts', content: 'bad' }, { agent, workspace: h.workspace, run: h.store, signal: new AbortController().signal })
      assert.equal(result.ok, false, `${agent} -> ${name}`)
      assert.match(result.result, /not authorized/)
      assert.equal(result.effect, undefined)
      assert.equal(h.workspace.describe(), before)
    }
  }
  assert.equal(h.workspace.read('unauthorized.ts'), null)
  assert.deepEqual(toolNamesFor('unknown' as never), [])
})

test('orchestrator rejects Atlas repo_write even when a registry executor lacks its own guard', async (t) => {
  const tools = createToolRegistry()
  let executed = false
  tools.byApiName('repo_write')!.execute = async () => { executed = true; return { ok: true, result: 'bad' } }
  const h = harness(t, async (req) => req.messages.length === 1 ? reply([tool('repo_write', { path: 'bad', content: 'bad' })]) : reply(), { tools })
  await h.orchestrator.start()
  await until(() => h.requests.length === 2)
  assert.equal(executed, false)
  assert.match(JSON.stringify(h.requests[1].messages), /not authorized/)
  assert.equal(h.workspace.read('bad'), null)
})

for (const status of ['done', 'failed'] as const) {
  test(`direct execution rejects tools in ${status} runs`, async (t) => {
    const h = harness(t, async () => reply())
    h.store.setRun({ status })
    const result = await h.tools.byApiName('repo_write')!.execute({ path: 'bad', content: 'bad' }, { agent: 'forge', workspace: h.workspace, run: h.store, signal: new AbortController().signal })
    assert.equal(result.ok, false)
    assert.equal(h.workspace.read('bad'), null)
  })
}
