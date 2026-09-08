import { z } from 'zod'
import type { CommandResult, RunEvent, RunSnapshot, ThreadItem } from '../../shared/protocol.js'

const text = z.string()
const number = z.number().finite()
const seq = number.int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const agentId = z.enum(['atlas', 'vector', 'forge', 'probe', 'sentry'])
const target = z.union([z.literal('all'), agentId])
const toolStatus = z.enum(['ok', 'queued', 'drafting', 'running', 'error'])
const log = z.object({ t: text, level: z.enum(['INFO', 'WARN', 'FAIL', 'RISK']), msg: text }).passthrough()
const tool = z.object({ id: text, name: text, arg: text, dur: text, status: toolStatus }).passthrough()
const agent = z.object({
  id: agentId, name: text, initials: text, role: text, model: text, color: text,
  status: z.enum(['working', 'thinking', 'idle', 'blocked']), pct: number,
  subtask: text, subtaskTitle: text, eta: text, io: z.array(text), queueCount: number,
  queue: z.array(z.object({ title: text, meta: text })), log: z.array(log), tools: z.array(tool),
}).passthrough()
const base = { id: text, time: text }
const message = z.object({ ...base, kind: z.literal('message'), who: agentId, badge: text.optional(), body: text, chips: z.array(text).optional(), streaming: z.boolean().optional() }).passthrough()
const threadTool = z.object({ ...base, kind: z.literal('tool'), who: agentId, tool: text, body: text, dur: text, status: toolStatus, lines: z.array(z.object({ text, color: text })) }).passthrough()
const thread = z.discriminatedUnion('kind', [
  message, threadTool,
  z.object({ ...base, kind: z.literal('human'), body: text, target }).passthrough(),
  z.object({ ...base, kind: z.literal('divider'), body: text }).passthrough(),
  z.object({ ...base, kind: z.literal('handoff'), body: text }).passthrough(),
])
const run = z.object({
  id: text.min(1), label: text, status: z.enum(['idle', 'live', 'paused', 'needs_approval', 'done', 'failed']),
  approvalGate: z.boolean(), channel: text, repo: text, branch: text, goal: text, startedAt: text,
  toolServers: number, llm: z.enum(['anthropic', 'openai', 'mock']), error: text.optional(),
}).passthrough()
const stats = z.object({
  elapsedSec: number, inputTokens: number, outputTokens: number, cacheReadTokens: number,
  cacheWriteTokens: number, costUsd: number, unreportedRequests: number,
  lifetimeUnreportedRequests: number, budgetUsd: number, messages: number, toolCalls: number,
  handoffs: number, decisions: number,
}).passthrough()
const pipeline = z.object({
  phase: z.enum(['spec', 'build', 'test', 'review', 'ship', 'done']), pr: text,
  lanes: z.array(z.object({ name: text, color: text, state: text, tasks: z.array(z.object({ title: text, owner: agentId, meta: text })) })),
  steps: z.array(z.object({ title: text, state: z.enum(['done', 'active', 'wait']), detail: text, meta: text, pct: number })),
}).passthrough()
const snapshot = z.object({ seq, run, stats, agents: z.array(agent), thread: z.array(thread), pipeline, typing: z.array(agentId) }).passthrough()
const event = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), seq, snapshot }),
  z.object({ type: z.literal('run'), seq, run: run.partial() }),
  z.object({ type: z.literal('stats'), seq, stats }),
  z.object({ type: z.literal('agent'), seq, id: agentId, patch: agent.omit({ id: true }).partial() }),
  z.object({ type: z.literal('agent.log'), seq, id: agentId, line: log }),
  z.object({ type: z.literal('agent.tool'), seq, id: agentId, call: tool }),
  z.object({ type: z.literal('thread.append'), seq, item: thread }),
  z.object({ type: z.literal('thread.patch'), seq, id: text, patch: z.union([message.partial(), threadTool.partial()]) }),
  z.object({ type: z.literal('pipeline'), seq, pipeline }),
  z.object({ type: z.literal('typing'), seq, typing: z.array(agentId) }),
])

export function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
}

export type ParsedJson = { parsed: true; value: unknown } | { parsed: false }
export function parseJson(raw: string): ParsedJson {
  try { return { parsed: true, value: JSON.parse(raw) as unknown } } catch { return { parsed: false } }
}

export function validateAcknowledgement(ok: boolean, parsed: ParsedJson, fallback: string): CommandResult {
  const value = parsed.parsed ? parsed.value : null
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (record?.ok === false && typeof record.error === 'string' && record.error.trim()) throw new Error(record.error.slice(0, 240))
  if (!ok) throw new Error(fallback.slice(0, 240))
  if (!record || record.ok !== true || !isSequence(record.seq)) throw new Error('The run server returned an invalid command response.')
  return { ok: true, seq: record.seq }
}

export function validateSnapshot(value: unknown): RunSnapshot | null {
  const result = snapshot.safeParse(value)
  if (!result.success) return null
  const data = result.data
  if (new Set(data.agents.map((a) => a.id)).size !== data.agents.length || new Set(data.thread.map((t) => t.id)).size !== data.thread.length) return null
  const ids = new Set(data.agents.map((a) => a.id))
  if (data.typing.some((id) => !ids.has(id)) || data.thread.some((t) => (t.kind === 'message' || t.kind === 'tool') && !ids.has(t.who))) return null
  return data as RunSnapshot
}

export function validateEvent(value: unknown): RunEvent | null {
  const result = event.safeParse(value)
  if (!result.success) return null
  if (result.data.type === 'snapshot') {
    const full = validateSnapshot(result.data.snapshot)
    return full && full.seq === result.data.seq ? { type: 'snapshot', seq: full.seq, snapshot: full } : null
  }
  return result.data as RunEvent
}

/** Reject known fields belonging to a different variant, even if the merged item parses. */
export function patchThread(item: ThreadItem, patch: Record<string, unknown>): ThreadItem | null {
  if (item.kind !== 'message' && item.kind !== 'tool') return null
  if (('id' in patch && patch.id !== item.id) || ('kind' in patch && patch.kind !== item.kind)) return null
  const incompatible = item.kind === 'message' ? ['tool', 'dur', 'status', 'lines', 'target'] : ['badge', 'chips', 'streaming', 'target']
  if (incompatible.some((key) => key in patch)) return null
  const result = (item.kind === 'message' ? message : threadTool).safeParse({ ...item, ...patch })
  return result.success ? result.data as ThreadItem : null
}
