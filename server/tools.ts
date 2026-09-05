/**
 * Executes TOOL_CATALOGUE entries against a Workspace.
 *
 * Workspace tools (repo.*, shell.run, db.migrate, docs.*, web.fetch,
 * artifact.get, sec.scan, pr.*) act on `ctx.workspace` and return compact
 * results — the result string goes straight back into the model's context.
 * Orchestration tools (run.*, agent.*) only validate their input and return
 * the matching ToolEffect; the orchestrator applies it.
 *
 * Every handler runs inside a try/catch: a thrown error becomes
 * `{ ok: false, result: 'error: …' }` so the orchestrator can send an
 * is_error tool result instead of crashing the agent's turn.
 */

import type { AgentId, LogLevel, Phase, ToolOutputLine } from '../shared/protocol.js'
import { TOOL_CATALOGUE, toolNamesFor } from './contracts.js'
import type { LLMTool, ToolInputSchema, DiffStat, ToolContext, ToolEffect, ToolOutcome, ToolRegistry, ToolSpec } from './contracts.js'
import type { TestSummary, WorkspaceWithHistory } from './workspace.js'

const TEAL = '#3ED8C4'
const PINK = '#F472B6'
const AMBER = '#F2B457'
const GREY = '#8C95A9'

const FILE_READ_CAP = 6 * 1024
const COMMAND_OUTPUT_CAP = 3 * 1024
const MAX_CARD_LINES = 40

const AGENT_IDS: readonly AgentId[] = ['atlas', 'vector', 'forge', 'probe', 'sentry']
const WORKER_IDS: readonly AgentId[] = ['vector', 'forge', 'probe', 'sentry']
const PHASES: readonly Phase[] = ['spec', 'build', 'test', 'review', 'ship']

type Input = Record<string, unknown>

interface Handler {
  summarize(input: Input): string
  execute(input: Input, ctx: ToolContext): ToolOutcome | Promise<ToolOutcome>
}

// ---------------------------------------------------------------------------
// Input validation — defensive, since the mock driver may be sloppy
// ---------------------------------------------------------------------------

class InputError extends Error {}

function str(input: Input, key: string): string {
  const v = input[key]
  if (typeof v !== 'string') throw new InputError(`missing required string field "${key}"`)
  return v
}

function optStr(input: Input, key: string): string | undefined {
  const v = input[key]
  return typeof v === 'string' && v.trim() ? v : undefined
}

function bool(input: Input, key: string): boolean {
  const v = input[key]
  if (typeof v === 'boolean') return v
  if (v === 'true' || v === 'false') return v === 'true'
  throw new InputError(`missing required boolean field "${key}"`)
}

function int(input: Input, key: string, min: number, max: number): number {
  const v = input[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new InputError(`missing required integer field "${key}"`)
  return Math.min(max, Math.max(min, Math.round(n)))
}

function strList(input: Input, key: string): string[] {
  const v = input[key]
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return v ? [v] : []
  if (!Array.isArray(v)) throw new InputError(`field "${key}" must be an array of strings`)
  return v.filter((x): x is string => typeof x === 'string')
}

function oneOf<T extends string>(input: Input, key: string, values: readonly T[]): T {
  const v = str(input, key).trim() as T
  if (!values.includes(v)) throw new InputError(`field "${key}" must be one of ${values.join(', ')} (got "${v}")`)
  return v
}

function edits(input: Input): { find: string; replace: string }[] {
  const v = input.edits
  if (!Array.isArray(v) || !v.length) throw new InputError('missing required array field "edits"')
  return v.map((e, i) => {
    if (!e || typeof e !== 'object') throw new InputError(`edits[${i}] must be an object`)
    const o = e as Input
    if (typeof o.find !== 'string' || typeof o.replace !== 'string') throw new InputError(`edits[${i}] needs string "find" and "replace"`)
    return { find: o.find, replace: o.replace }
  })
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

/** First `n` characters on one line, with an ellipsis when cut. */
function head(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function capTail(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n…truncated (${s.length - max} more bytes)`
}

/** Keeps head and tail so a command's summary survives the cap. */
function capMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const headLen = Math.floor(max * 0.65)
  const tailLen = max - headLen
  return `${s.slice(0, headLen)}\n…truncated (${s.length - max} bytes)…\n${s.slice(-tailLen)}`
}

function lineCount(s: string): number {
  return s === '' ? 0 : s.replace(/\n$/, '').split('\n').length
}

function firstLines(content: string, n: number, color = GREY): ToolOutputLine[] {
  return content
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, n)
    .map((l) => ({ text: l, color }))
}

function statLine(line: string): ToolOutputLine {
  const add = Number(/\+(\d+)/.exec(line)?.[1] ?? 0)
  const del = Number(/−(\d+)/.exec(line)?.[1] ?? 0)
  return { text: line, color: add >= del ? TEAL : PINK }
}

function diffLines(stat: DiffStat): ToolOutputLine[] {
  return stat.lines.slice(0, MAX_CARD_LINES).map(statLine)
}

function statSummary(stat: DiffStat): string {
  return `${stat.files} file${stat.files === 1 ? '' : 's'} · +${stat.additions} −${stat.deletions}`
}

function levelColor(level: LogLevel): string {
  return level === 'RISK' || level === 'FAIL' ? PINK : level === 'WARN' ? AMBER : GREY
}

function lastTestsOf(ws: ToolContext['workspace']): TestSummary | null {
  const maybe = ws as Partial<WorkspaceWithHistory>
  return typeof maybe.lastTests === 'function' ? maybe.lastTests() : null
}

const WEBAUTHN_REFERENCE = [
  '[simulated fetch] W3C WebAuthn Level 2 + FIDO2 CTAP — curated summary',
  '1. Registration: server issues a random challenge (≥16 bytes, single-use, ~2 min TTL); client returns attestationObject + clientDataJSON. Verify origin, rpIdHash, challenge, then store credential id, COSE public key and the sign counter.',
  '2. Authentication: server issues a challenge; client returns an assertion. Verify the signature with the stored public key over authenticatorData || sha256(clientDataJSON).',
  '3. Sign counter: authenticatorData.signCount. Treat an assertion as a cloned authenticator only when the new count is NOT strictly greater than the stored one and both are non-zero. Use `new > stored`; `>=` wrongly rejects authenticators that report 0 (Windows Hello, many platform authenticators) and fresh re-registrations.',
  '4. Resident keys (discoverable credentials): residentKey: "required" + userVerification: "required" for usernameless sign-in. Roaming-only keys are not enough for a passkey UX.',
  '5. Attestation: "none" is the recommended default unless you must enforce authenticator models; enterprise attestation needs explicit policy.',
  '6. Credential id: opaque bytes up to 1023 long. Store raw bytes (Postgres bytea), never a base64 string — base64 vs base64url mismatches make lookups fail; Windows Hello ids are 32+ bytes and hit this first.',
  '7. Origin pinning: expected origin must match exactly; rp.id must be a registrable-domain suffix of the origin (helios.app).',
  '8. Re-registration: use excludeCredentials to stop duplicates; a genuine second registration starts a new counter at 0 and must not trip the replay guard.',
  '9. Challenge binding: bind the challenge to the session or a signed cookie; reject reuse.',
  '10. User verification: require UV for passkeys; check the UP flag on every ceremony.',
  '11. Recovery: keep at least one other credential or a recovery code path; do not fall back to SMS OTP (SIM swap).',
  '12. Rate limit registration and login per user and per IP.',
  '13. Refs: https://www.w3.org/TR/webauthn-2/ · https://fidoalliance.org/specs/fido-v2.1-ps-20210615/ · https://passkeys.dev/docs/',
].join('\n')

const REFERENCE_TOPICS = /webauthn|passkey|fido|resident\s*key|attestation|ctap|authenticator/i

// ---------------------------------------------------------------------------
// Handlers, one per catalogue entry
// ---------------------------------------------------------------------------

const HANDLERS: Record<string, Handler> = {
  // --- orchestration (Atlas) -----------------------------------------------
  'run.assign': {
    summarize: (i) => `${text(i.agent)} ← ${head(text(i.title), 40)}`,
    execute(i) {
      const effect: ToolEffect = {
        kind: 'assign',
        agent: oneOf(i, 'agent', WORKER_IDS),
        phase: oneOf(i, 'phase', PHASES),
        title: str(i, 'title'),
        subtask: str(i, 'subtask'),
        eta: optStr(i, 'eta'),
      }
      return { ok: true, result: `ok · ${effect.agent} assigned "${effect.title}" (${effect.phase})`, effect }
    },
  },
  'run.handoff': {
    summarize: (i) => `${text(i.from)} → ${text(i.to)}`,
    execute(i) {
      const effect: ToolEffect = { kind: 'handoff', from: oneOf(i, 'from', AGENT_IDS), to: oneOf(i, 'to', WORKER_IDS), note: str(i, 'note') }
      return { ok: true, result: `ok · ${effect.to} woken with the handoff note`, effect }
    },
  },
  'run.set_phase': {
    summarize: (i) => text(i.phase),
    execute(i) {
      const phase = oneOf(i, 'phase', PHASES)
      return { ok: true, result: `ok · phase → ${phase}`, effect: { kind: 'set_phase', phase } }
    },
  },
  'run.read_status': {
    summarize: () => 'agents · diff · tests · PR',
    execute(_i, ctx) {
      const snap = ctx.run.snapshot()
      const diff = ctx.workspace.diff()
      const pr = ctx.workspace.pr.state()
      const status = {
        run: { status: snap.run.status, phase: snap.pipeline.phase, approvalGate: snap.run.approvalGate },
        agents: Object.fromEntries(snap.agents.map((a) => [a.id, { status: a.status, pct: a.pct, subtask: a.subtask }])),
        diff: { files: diff.files, additions: diff.additions, deletions: diff.deletions, lines: diff.lines.map((l) => l.replace(/\s+/g, ' ')) },
        lastE2e: lastTestsOf(ctx.workspace),
        pr: {
          number: pr.number,
          review: pr.review,
          revision: ctx.workspace.revision(),
          reviewRevision: pr.reviewRevision,
          mergeReady: ctx.workspace.pr.checkMerge(),
          merged: pr.merged,
          commits: pr.commits.length,
          openComments: pr.comments.filter((c) => !c.resolved).map((c) => ({ id: c.id, author: c.author, blocking: c.blocking, body: head(c.body, 160) })),
        },
      }
      const lines: ToolOutputLine[] = snap.agents.map((a) => ({ text: `${a.name.padEnd(7)} ${a.status.padEnd(9)} ${String(a.pct).padStart(3)}%  ${a.subtask}`, color: GREY }))
      return { ok: true, result: JSON.stringify(status), lines }
    },
  },
  'run.request_merge': {
    summarize: () => 'PR #482 · merge',
    execute(i) {
      const summary = str(i, 'summary')
      return { ok: true, result: 'ok · merge requested', effect: { kind: 'request_merge', summary } }
    },
  },
  'run.finish': {
    summarize: () => 'run complete',
    execute(i) {
      const summary = str(i, 'summary')
      return { ok: true, result: 'ok · run finished', effect: { kind: 'finish_run', summary } }
    },
  },

  // --- common (every worker) ---------------------------------------------
  'agent.progress': {
    summarize: (i) => `${text(i.pct)}% · ${head(text(i.subtask), 40)}`,
    execute(i) {
      // The strict schema cannot carry minimum/maximum, so the range is enforced here: `int` clamps to 0..100.
      const effect: ToolEffect = { kind: 'progress', pct: int(i, 'pct', 0, 100), subtask: optStr(i, 'subtask'), eta: optStr(i, 'eta'), io: strList(i, 'io') }
      return { ok: true, result: 'ok', effect }
    },
  },
  'agent.done': {
    summarize: (i) => head(text(i.summary), 48),
    execute(i) {
      const effect: ToolEffect = { kind: 'done', summary: str(i, 'summary'), io: strList(i, 'io') }
      return { ok: true, result: 'ok · Atlas notified', effect }
    },
  },
  'agent.blocked': {
    summarize: (i) => `blocked · ${head(text(i.reason), 40)}`,
    execute(i) {
      const waiting = oneOf(i, 'waiting_on', [...AGENT_IDS, 'human'] as const)
      // The effect cannot express "human" — the orchestrator sees an unqualified block instead.
      const effect: ToolEffect = { kind: 'blocked', reason: str(i, 'reason'), waitingOn: waiting === 'human' ? undefined : waiting }
      return { ok: true, result: `ok · Atlas notified (waiting on ${waiting})`, effect, log: { level: 'WARN', msg: `blocked · ${head(effect.reason, 60)}` } }
    },
  },
  'agent.queue': {
    summarize: (i) => head(text(i.title), 48),
    execute(i) {
      const effect: ToolEffect = { kind: 'queue_add', title: str(i, 'title'), meta: oneOf(i, 'meta', ['next', 'queued', 'watching', 'drafting'] as const) }
      return { ok: true, result: 'ok', effect }
    },
  },

  // --- repository ----------------------------------------------------------
  'repo.list': {
    summarize: () => 'tree',
    execute(_i, ctx) {
      const files = ctx.workspace.list()
      return { ok: true, result: files.join('\n'), lines: files.slice(0, MAX_CARD_LINES).map((f) => ({ text: f, color: GREY })) }
    },
  },
  'repo.read': {
    summarize: (i) => text(i.path),
    execute(i, ctx) {
      const path = str(i, 'path')
      const content = ctx.workspace.read(path)
      if (content === null) return { ok: false, result: `error: no such file: ${path}` }
      return { ok: true, result: capTail(content, FILE_READ_CAP), lines: firstLines(content, 8) }
    },
  },
  'repo.write': {
    summarize: (i) => text(i.path),
    execute(i, ctx) {
      const path = str(i, 'path')
      const content = str(i, 'content')
      const { created } = ctx.workspace.write(path, content)
      const stat = ctx.workspace.diff()
      return { ok: true, result: `${created ? 'created' : 'replaced'} ${path} (${lineCount(content)} lines) · working tree: ${statSummary(stat)}`, lines: diffLines(stat) }
    },
  },
  'repo.patch': {
    summarize: (i) => `${text(i.path)} · ${Array.isArray(i.edits) ? i.edits.length : 0} edit${Array.isArray(i.edits) && i.edits.length === 1 ? '' : 's'}`,
    execute(i, ctx) {
      const path = str(i, 'path')
      const list = edits(i)
      const { applied, missing } = ctx.workspace.patch(path, list)
      const stat = ctx.workspace.diff()
      if (missing.length) {
        const detail = missing.map((m) => JSON.stringify(head(m, 80))).join(', ')
        return {
          ok: false,
          result: `error: ${applied}/${list.length} edits applied to ${path}; ${missing.length} find string${missing.length === 1 ? '' : 's'} not found verbatim: ${detail}`,
          lines: diffLines(stat),
          log: { level: 'WARN', msg: `patch ${path} · ${missing.length} find string${missing.length === 1 ? '' : 's'} missing` },
        }
      }
      return { ok: true, result: `applied ${applied}/${list.length} edits to ${path} · working tree: ${statSummary(stat)}`, lines: diffLines(stat) }
    },
  },
  'repo.diff': {
    summarize: () => 'working tree vs last push',
    execute(_i, ctx) {
      const stat = ctx.workspace.diff()
      const body = stat.lines.length ? stat.lines.join('\n') : 'working tree clean'
      return { ok: true, result: `${statSummary(stat)}\n${body}`, lines: diffLines(stat) }
    },
  },
  'repo.push': {
    summarize: (i) => head(text(i.message), 48),
    execute(i, ctx) {
      const message = str(i, 'message')
      const { sha, stat } = ctx.workspace.push(message)
      return {
        ok: true,
        result: `pushed ${sha} to ${ctx.workspace.branch} · ${statSummary(stat)}`,
        lines: diffLines(stat),
        log: { level: 'INFO', msg: `pushed ${sha} to ${ctx.workspace.branch}` },
        effect: { kind: 'pushed', sha },
      }
    },
  },
  'repo.rollback': {
    summarize: () => 'to last push',
    execute(_i, ctx) {
      const before = ctx.workspace.diff()
      const { sha } = ctx.workspace.rollback()
      return { ok: true, result: `rolled back ${before.files} file${before.files === 1 ? '' : 's'} to ${sha ?? 'the seed tree'}`, lines: before.lines.map((l) => ({ text: l, color: PINK })) }
    },
  },
  'shell.run': {
    summarize: (i) => head(text(i.command), 48),
    async execute(i, ctx) {
      const command = str(i, 'command')
      const r = await ctx.workspace.run(command)
      const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
      const result = `$ ${command.trim()}\nexit ${r.exitCode} · ${(r.durationMs / 1000).toFixed(1)}s\n${capMiddle(output, COMMAND_OUTPUT_CAP)}`
      const ok = r.exitCode === 0
      if (r.tests && /\be2e\b/.test(command)) {
        const t = r.tests
        const lines: ToolOutputLine[] = t.failures.slice(0, MAX_CARD_LINES - 1).map((f) => ({ text: `FAIL ${f}`, color: PINK }))
        lines.push({ text: `${t.passed}/${t.total} passed · ${t.failed} failed · ${(r.durationMs / 1000).toFixed(1)}s`, color: t.failed ? AMBER : TEAL })
        return {
          ok,
          result,
          lines,
          log: { level: t.failed ? 'FAIL' : 'INFO', msg: `e2e ${t.passed}/${t.total}${t.failed ? ` · ${t.failed} failing` : ' · green'}` },
          effect: { kind: 'tests', passed: t.passed, failed: t.failed, total: t.total },
        }
      }
      const noise = output.split('\n').filter((l) => /error|warning|failed|passed|problem|Found \d/.test(l))
      const lines: ToolOutputLine[] = noise.slice(0, MAX_CARD_LINES).map((l) => ({
        text: l,
        color: /error|failed/i.test(l) && !/0 errors|Found 0 errors/.test(l) ? PINK : /warning/.test(l) && !/0 warnings/.test(l) ? AMBER : GREY,
      }))
      const warnings = (output.match(/warning/g) ?? []).length
      const log = !ok ? { level: 'FAIL' as const, msg: `${command.trim()} failed · exit ${r.exitCode}` } : warnings ? { level: 'WARN' as const, msg: `${command.trim()} · ${warnings} warning${warnings === 1 ? '' : 's'}` } : undefined
      return { ok, result, lines, log }
    },
  },
  'db.migrate': {
    summarize: (i) => text(i.name),
    execute(i, ctx) {
      const name = str(i, 'name')
      const sql = str(i, 'sql')
      const r = ctx.workspace.migrations.apply(name, sql)
      return {
        ok: r.ok,
        result: r.ok ? r.message : `error: ${r.message}`,
        lines: [...firstLines(sql, 4), { text: r.message, color: r.ok ? TEAL : PINK }],
        log: r.ok ? { level: 'INFO', msg: `applied migration ${name}` } : { level: 'FAIL', msg: `migration ${name} rejected` },
      }
    },
  },
  'docs.write': {
    summarize: (i) => text(i.name),
    execute(i, ctx) {
      const name = str(i, 'name')
      const content = str(i, 'content')
      const { created } = ctx.workspace.docs.write(name, content)
      return { ok: true, result: `${created ? 'wrote' : 'updated'} docs/${name.replace(/^docs\//, '')} (${lineCount(content)} lines)`, lines: firstLines(content, 4) }
    },
  },
  'docs.read': {
    summarize: (i) => text(i.name),
    execute(i, ctx) {
      const name = str(i, 'name')
      const content = ctx.workspace.docs.read(name)
      if (content === null) {
        const available = ctx.workspace.docs.list()
        return { ok: false, result: `error: no such doc: ${name}${available.length ? ` (available: ${available.join(', ')})` : ''}` }
      }
      return { ok: true, result: capTail(content, FILE_READ_CAP), lines: firstLines(content, 4) }
    },
  },
  'web.fetch': {
    summarize: (i) => head(text(i.query), 48),
    execute(i) {
      const query = str(i, 'query')
      if (!REFERENCE_TOPICS.test(query)) {
        return { ok: true, result: `no curated reference for that query (simulated fetch): ${head(query, 80)}`, lines: [{ text: 'no curated reference (simulated)', color: GREY }] }
      }
      return { ok: true, result: WEBAUTHN_REFERENCE, lines: firstLines(WEBAUTHN_REFERENCE, 4).map((l) => ({ ...l, text: head(l.text, 96) })) }
    },
  },
  'artifact.get': {
    summarize: (i) => text(i.name),
    execute(i, ctx) {
      const name = str(i, 'name')
      const content = ctx.workspace.artifact(name)
      if (content === null) return { ok: false, result: `error: no artifact named ${name} — run "pnpm e2e" first; the latest trace is trace-latest.zip` }
      return { ok: true, result: capTail(content, FILE_READ_CAP), lines: firstLines(content, 6).map((l) => ({ text: l.text, color: l.text.startsWith('---') ? PINK : GREY })) }
    },
  },
  'sec.scan': {
    summarize: () => 'deps + secrets',
    execute(_i, ctx) {
      const findings = ctx.workspace.secScan()
      const risk = findings.find((f) => f.level === 'RISK')
      return {
        ok: true,
        result: findings.map((f) => `[${f.level}] ${f.path} — ${f.msg}`).join('\n'),
        lines: findings.slice(0, MAX_CARD_LINES).map((f) => ({ text: `${f.level.padEnd(4)} ${f.path} — ${f.msg}`, color: levelColor(f.level) })),
        log: risk ? { level: 'RISK', msg: risk.msg } : { level: 'INFO', msg: `scan clean · ${findings.length} finding${findings.length === 1 ? '' : 's'}` },
        effect: risk ? { kind: 'risk', msg: risk.msg } : undefined,
      }
    },
  },
  'pr.comment': {
    summarize: (i) => (i.blocking === true || i.blocking === 'true' ? `blocking · ${head(text(i.body), 24)}` : head(text(i.body), 32)),
    execute(i, ctx) {
      const body = str(i, 'body')
      const blocking = bool(i, 'blocking')
      const c = ctx.workspace.pr.comment(ctx.agent, body, blocking)
      return {
        ok: true,
        result: `comment ${c.id} (${blocking ? 'blocking' : 'non-blocking'}) posted on PR #${ctx.workspace.pr.state().number}`,
        lines: firstLines(body, 4, blocking ? PINK : GREY),
        log: { level: blocking ? 'WARN' : 'INFO', msg: `${blocking ? 'blocking ' : ''}comment ${c.id} on #${ctx.workspace.pr.state().number}` },
      }
    },
  },
  'pr.resolve': {
    summarize: (i) => text(i.id),
    execute(i, ctx) {
      const id = str(i, 'id')
      const done = ctx.workspace.pr.resolve(id)
      const open = ctx.workspace.pr.state().comments.filter((c) => !c.resolved)
      return done
        ? { ok: true, result: `resolved ${id} · ${open.length} open comment${open.length === 1 ? '' : 's'} left` }
        : { ok: false, result: `error: no open comment with id ${id}${open.length ? ` (open: ${open.map((c) => c.id).join(', ')})` : ''}` }
    },
  },
  'pr.review': {
    summarize: (i) => text(i.verdict),
    execute(i, ctx) {
      const verdict = oneOf(i, 'verdict', ['approve', 'request_changes'] as const)
      const summary = str(i, 'summary')
      ctx.workspace.pr.review(ctx.agent, verdict, summary)
      const open = ctx.workspace.pr.state().comments.filter((c) => c.blocking && !c.resolved)
      return {
        ok: true,
        result: `review submitted: ${verdict}${open.length ? ` · note: ${open.length} blocking comment${open.length === 1 ? '' : 's'} still open` : ''}`,
        lines: [{ text: verdict === 'approve' ? 'APPROVED' : 'CHANGES REQUESTED', color: verdict === 'approve' ? TEAL : PINK }, ...firstLines(summary, 3)],
        log: { level: verdict === 'approve' ? 'INFO' : 'WARN', msg: `review: ${verdict.replace('_', ' ')}` },
        effect: { kind: 'pr_review', verdict },
      }
    },
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** JSON Schema keywords strict mode rejects; each is folded into the node's description instead. */
const STRICT_UNSUPPORTED: readonly string[] = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format']

/** Schema keywords whose value maps arbitrary names to sub-schemas (a property may itself be called "pattern"). */
const SCHEMA_MAPS: readonly string[] = ['properties', '$defs', 'definitions']

function constraintNote(key: string, value: unknown, node: Record<string, unknown>): string | null {
  switch (key) {
    case 'minimum':
      return 'maximum' in node ? `Range ${String(value)}–${String(node.maximum)}.` : `Minimum ${String(value)}.`
    case 'maximum':
      return 'minimum' in node ? null : `Maximum ${String(value)}.`
    case 'multipleOf':
      return `Multiple of ${String(value)}.`
    case 'minLength':
      return `At least ${String(value)} characters.`
    case 'maxLength':
      return `At most ${String(value)} characters.`
    case 'pattern':
      return `Matches /${String(value)}/.`
    case 'format':
      return `Format: ${String(value)}.`
    default:
      return null
  }
}

/** Whether `desc` already states the note (a range counts in either dash style). */
function mentions(desc: string, note: string): boolean {
  return desc.includes(note) || desc.includes(note.replace('–', '-'))
}

/**
 * Deep copy of a schema with the keywords strict mode does not support removed.
 * Ranges and formats survive as description text so the model still sees them;
 * enum/type/required/additionalProperties/properties/items/description are kept.
 */
function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema)
  if (!node || typeof node !== 'object') return node
  const src = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const notes: string[] = []
  for (const [key, value] of Object.entries(src)) {
    if (STRICT_UNSUPPORTED.includes(key)) {
      const note = constraintNote(key, value, src)
      if (note) notes.push(note)
      continue
    }
    const isMap = SCHEMA_MAPS.includes(key) && !!value && typeof value === 'object' && !Array.isArray(value)
    out[key] = isMap
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strictSchema(v)]))
      : strictSchema(value)
  }
  if (notes.length) {
    const desc = typeof out.description === 'string' ? out.description.trim() : ''
    const missing = notes.filter((n) => !mentions(desc, n))
    if (missing.length) out.description = [desc, ...missing].filter(Boolean).join(' ')
  }
  return out
}

function buildSpec(name: string): ToolSpec {
  const entry = TOOL_CATALOGUE[name]
  const handler = HANDLERS[name]
  if (!handler) throw new Error(`tools.ts has no handler for catalogue entry ${name}`)
  return {
    name,
    apiName: entry.apiName,
    description: entry.description,
    inputSchema: entry.inputSchema,
    summarize(input) {
      try {
        return handler.summarize(input ?? {})
      } catch {
        return name
      }
    },
    async execute(input, ctx) {
      if (!toolNamesFor(ctx.agent).includes(name)) return { ok: false, result: `error: ${ctx.agent} is not authorized to execute ${name}` }
      if ((name === 'pr.review' || name === 'run.request_merge') && ctx.revision !== undefined && ctx.revision !== ctx.workspace.revision()) {
        return { ok: false, result: 'error: revision changed during the model request; inspect the current revision first' }
      }
      if (ctx.signal.aborted) return { ok: false, result: 'error: interrupted before the tool ran' }
      if (!['live', 'paused', 'needs_approval'].includes(ctx.run.snapshot().run.status)) {
        return { ok: false, result: 'error: run is not active' }
      }
      try {
        const outcome = await handler.execute(input ?? {}, ctx)
        if (ctx.signal.aborted) return { ok: false, result: 'error: tool interrupted' }
        return outcome
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { ok: false, result: `error: ${msg}`, log: { level: 'FAIL', msg: `${name} · ${head(msg, 60)}` } }
      }
    },
  }
}

export function createToolRegistry(): ToolRegistry {
  const specs = new Map<string, ToolSpec>(Object.keys(TOOL_CATALOGUE).map((name) => [name, buildSpec(name)]))
  const byApi = new Map<string, ToolSpec>([...specs.values()].map((s) => [s.apiName, s]))
  const perAgent = new Map<AgentId, ToolSpec[]>()
  const definitions = new Map<AgentId, LLMTool[]>()

  function forAgent(agent: AgentId): ToolSpec[] {
    let list = perAgent.get(agent)
    if (!list) {
      list = toolNamesFor(agent).map((n) => specs.get(n)!)
      perAgent.set(agent, list)
    }
    return list
  }

  return {
    forAgent,
    definitionsFor(agent) {
      let defs = definitions.get(agent)
      if (!defs) {
        defs = forAgent(agent).map((s) => ({
          name: s.apiName,
          description: s.description,
          input_schema: strictSchema(s.inputSchema) as ToolInputSchema,
          strict: true,
        }))
        definitions.set(agent, defs)
      }
      return defs
    },
    byApiName: (apiName) => byApi.get(apiName),
  }
}
