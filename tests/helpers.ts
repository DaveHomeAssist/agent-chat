import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { PERSONAS } from '../server/agents.js'
import { loadConfig } from '../server/config.js'
import type { LLM, LLMRequest, LLMResult, LLMUsage, ToolRegistry } from '../server/contracts.js'
import { createOrchestrator } from '../server/orchestrator.js'
import { createRunStore } from '../server/run.js'
import { createToolRegistry } from '../server/tools.js'
import { createWorkspace } from '../server/workspace.js'

export const usage = (inputTokens = 0): LLMUsage => ({ model: 'claude-opus-5', inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
let toolId = 0
export const tool = (name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use' as const, id: `test_${++toolId}`, name, input })
export function reply(toolUses: ReturnType<typeof tool>[] = [], tokens = 0, text = ''): LLMResult {
  return { content: [...(text ? [{ type: 'text' as const, text, citations: null }] : []), ...toolUses], toolUses, text, stopReason: toolUses.length ? 'tool_use' : 'end_turn', usage: usage(tokens) }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function until(check: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await setImmediate()
  assert.ok(check(), `timed out waiting for ${label}`)
}
export async function settle() {
  for (let n = 0; n < 25; n++) await setImmediate()
}
export function harness(t: TestContext, complete: LLM['complete'], options: { env?: NodeJS.ProcessEnv; tools?: ToolRegistry; llm?: LLM } = {}) {
  const config = loadConfig({ MOCK_LLM: '1', MOCK_SPEED: '0', AUTO_START: '0', ...options.env })
  const store = createRunStore(PERSONAS, config.models)
  const workspace = createWorkspace()
  const requests: LLMRequest[] = []
  const llm: LLM = options.llm ?? { kind: 'mock', healthcheck: async () => null, complete: async (req) => { requests.push(req); return complete(req) } }
  const tools = options.tools ?? createToolRegistry()
  const orchestrator = createOrchestrator({ store, workspace, tools, config, llm, personas: PERSONAS })
  t.after(() => orchestrator.dispose())
  return { config, store, workspace, tools, orchestrator, requests }
}
export function buildFeature(ws: ReturnType<typeof createWorkspace>, broken = false) {
  ws.write('services/auth/webauthn/register.ts', 'export const register = true\n')
  ws.write('services/auth/webauthn/verify.ts', `export const fresh = signCount ${broken ? '>=' : '>'} stored.signCount\n`)
  assert.equal(ws.migrations.apply('0043_credentials', 'CREATE TABLE credentials (cred_id BYTEA);').ok, true)
  ws.push('simulated passkey fixture')
}
export async function ready(ws: ReturnType<typeof createWorkspace>) {
  buildFeature(ws)
  assert.equal((await ws.run('pnpm e2e')).tests?.passed, 24)
  ws.pr.review('sentry', 'approve', 'reviewed current pushed revision')
}
export const assign = (agent = 'forge') => tool('run_assign', { agent, phase: 'build', title: `Task ${agent}`, subtask: 'Exercise lifecycle', eta: 'soon' })
