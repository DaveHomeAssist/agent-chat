import type { Agent, AgentId } from '../types'

/**
 * The five agents shipping the passkey-auth feature. Static fixture data —
 * a real deployment would stream this from the run's agent registry.
 */
export const AGENTS: Agent[] = [
  {
    id: 'atlas',
    name: 'Atlas',
    initials: 'AT',
    role: 'Orchestrator · lead',
    model: 'opus',
    color: '#7C9BFF',
    status: 'working',
    pct: 44,
    subtask: 'coordinating 5 subtasks · merge gate held',
    subtaskTitle:
      'Keep the run on plan: sequence build → test → review, hold merge until the human gate clears',
    eta: '~9 min',
    queueCount: 2,
    io: ['plan/run-04.yaml', '5 subtasks', '2 blockers'],
    queue: [
      { title: 'Recompute critical path after patch', meta: 'queued' },
      { title: 'Draft run summary for PR body', meta: 'queued' },
    ],
    log: [
      { t: '14:38:02', level: 'INFO', msg: 'subtask forge/register → 72%' },
      { t: '14:38:04', level: 'INFO', msg: 'merge gate = HELD (human)' },
      { t: '14:38:11', level: 'WARN', msg: 'probe/e2e failing 2/24 — waiting on patch' },
      { t: '14:38:30', level: 'INFO', msg: 're-sequenced review after test' },
      { t: '14:38:52', level: 'INFO', msg: 'broadcast to #feature-passkey-auth' },
    ],
    tools: [
      { name: 'run.plan', arg: 'run-04 · 5 subtasks', dur: '0.4s', status: 'ok' },
      { name: 'agent.assign', arg: 'forge ← migration', dur: '0.2s', status: 'ok' },
      { name: 'gate.hold', arg: 'merge · human', dur: '0.1s', status: 'ok' },
      { name: 'run.summarize', arg: 'pending', dur: '—', status: 'queued' },
    ],
  },
  {
    id: 'vector',
    name: 'Vector',
    initials: 'VC',
    role: 'Spec & design',
    model: 'sonnet',
    color: '#A78BFA',
    status: 'idle',
    pct: 100,
    subtask: 'spec complete · ADR-0142 merged',
    subtaskTitle: 'Write the WebAuthn L2 spec and threat model, land it as ADR-0142',
    eta: 'done',
    queueCount: 1,
    io: ['ADR-0142.md', 'threat-model.md', '3 decisions'],
    queue: [{ title: 'Update spec if bytea change lands', meta: 'watching' }],
    log: [
      { t: '14:09:41', level: 'INFO', msg: 'resident keys required, no SMS fallback' },
      { t: '14:11:07', level: 'INFO', msg: 'wrote ADR-0142-passkey-auth.md' },
      { t: '14:11:09', level: 'INFO', msg: 'handoff → forge' },
      { t: '14:12:02', level: 'INFO', msg: 'idle · watching for spec deltas' },
    ],
    tools: [
      { name: 'docs.write', arg: 'ADR-0142-passkey-auth.md', dur: '1.2s', status: 'ok' },
      { name: 'repo.read', arg: 'schema.prisma', dur: '0.3s', status: 'ok' },
      { name: 'web.fetch', arg: 'w3c webauthn L2', dur: '2.1s', status: 'ok' },
    ],
  },
  {
    id: 'forge',
    name: 'Forge',
    initials: 'FG',
    role: 'Implementation',
    model: 'sonnet',
    color: '#3ED8C4',
    status: 'working',
    pct: 72,
    subtask: 'POST /webauthn/register · migration 0043',
    subtaskTitle:
      'POST /webauthn/register + credentials table migration behind auth.passkeys flag',
    eta: '~3 min',
    queueCount: 2,
    io: ['ADR-0142', '7 files', '+318 −24', 'migration 0043'],
    queue: [
      { title: 'Credential store rollback path', meta: 'next' },
      { title: 'Rate-limit register endpoint', meta: 'queued' },
    ],
    log: [
      { t: '14:31:02', level: 'INFO', msg: 'patch applied · 7 files' },
      { t: '14:31:04', level: 'INFO', msg: 'running pnpm typecheck' },
      { t: '14:31:19', level: 'WARN', msg: 'unused import in webauthn/verify.ts' },
      { t: '14:31:41', level: 'INFO', msg: 'typecheck passed · 0 errors' },
      { t: '14:32:03', level: 'INFO', msg: 'writing 0043_credentials.sql' },
      { t: '14:33:18', level: 'INFO', msg: 'fixed off-by-one in sign_count guard' },
      { t: '14:34:02', level: 'INFO', msg: 'pushed 4f9c1ad to feat/passkey-auth' },
      { t: '14:35:10', level: 'INFO', msg: 'awaiting probe/e2e re-run' },
    ],
    tools: [
      { name: 'repo.patch', arg: '7 files · +318 −24', dur: '4.1s', status: 'ok' },
      { name: 'shell.run', arg: 'pnpm typecheck', dur: '22.8s', status: 'ok' },
      { name: 'db.migrate', arg: '0043_credentials', dur: '1.9s', status: 'ok' },
      { name: 'repo.push', arg: '4f9c1ad', dur: '0.8s', status: 'ok' },
    ],
  },
  {
    id: 'probe',
    name: 'Probe',
    initials: 'PB',
    role: 'QA & tests',
    model: 'haiku',
    color: '#F2B457',
    status: 'thinking',
    pct: 58,
    subtask: 'e2e suite 18/24 · isolating 2 failures',
    subtaskTitle:
      'Register/login e2e across Chrome, Safari, Windows Hello — isolate the 2 replay-guard failures',
    eta: '~5 min',
    queueCount: 2,
    io: ['e2e/passkey.spec.ts', '24 cases', '2 failing'],
    queue: [
      { title: 'Add sign_count replay fixture', meta: 'next' },
      { title: 'Coverage report for #482', meta: 'queued' },
    ],
    log: [
      { t: '14:29:55', level: 'INFO', msg: 'suite start · 24 cases' },
      { t: '14:30:40', level: 'FAIL', msg: 'register.reregister → 400 replay' },
      { t: '14:30:44', level: 'FAIL', msg: 'login.windowsHello → cred_id mismatch' },
      { t: '14:31:10', level: 'INFO', msg: 'bisecting to sign_count guard' },
      { t: '14:33:20', level: 'INFO', msg: 'forge patch detected · re-queue suite' },
      { t: '14:35:02', level: 'INFO', msg: 'waiting for build 4f9c1ad' },
    ],
    tools: [
      { name: 'shell.run', arg: 'pnpm e2e --grep passkey', dur: '118.4s', status: 'ok' },
      { name: 'repo.read', arg: 'webauthn/verify.ts', dur: '0.3s', status: 'ok' },
      { name: 'artifact.get', arg: 'trace-0041.zip', dur: '1.1s', status: 'ok' },
      { name: 'shell.run', arg: 're-run suite', dur: '—', status: 'queued' },
    ],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    initials: 'SY',
    role: 'Review & security',
    model: 'opus',
    color: '#F472B6',
    status: 'blocked',
    pct: 20,
    subtask: 'blocked · waiting on green suite',
    subtaskTitle:
      'Diff review of #482 with a security pass on credential storage and replay protection',
    eta: 'blocked',
    queueCount: 2,
    io: ['PR #482', '412 LOC', '1 blocking note'],
    queue: [
      { title: 'Blocking comment: cred_id → bytea', meta: 'drafting' },
      { title: 'Threat-model diff vs ADR-0142', meta: 'queued' },
    ],
    log: [
      { t: '14:36:12', level: 'INFO', msg: 'pre-read diff · 412 LOC' },
      { t: '14:36:40', level: 'RISK', msg: 'cred_id stored as text — base64 round-trip' },
      { t: '14:37:02', level: 'INFO', msg: 'drafting blocking comment on #482' },
      { t: '14:37:30', level: 'INFO', msg: 'review blocked until suite green' },
    ],
    tools: [
      { name: 'repo.diff', arg: '#482 · 412 LOC', dur: '0.9s', status: 'ok' },
      { name: 'sec.scan', arg: 'deps + secrets', dur: '7.4s', status: 'ok' },
      { name: 'pr.comment', arg: 'blocking · cred_id', dur: '—', status: 'drafting' },
    ],
  },
]

export const AGENTS_BY_ID: Record<AgentId, Agent> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a]),
) as Record<AgentId, Agent>
