/**
 * Scripted LLM: plays the canonical passkey-sign-in scenario through real tool
 * calls so the whole server + UI can be exercised without an API key.
 *
 * Each `complete()` call decides one assistant turn from:
 *   - which agent is asking,
 *   - the wake message (the last user message carrying a `[TAG]` first line),
 *   - the tools this agent has already called (in this wake and overall),
 *   - the tool results it has received.
 *
 * The story lives in `STORY` below, as a table of scenes per agent. A scene is
 * picked by its `when` predicate; the turn played is `turns[n]` where `n` is the
 * number of assistant turns already taken since the wake. Anything off-script
 * gets a one-line, in-character reply so the run never stalls.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { AgentId } from '../../shared/protocol.js'
import type { Config, LLM, LLMRequest, LLMResult, LLMUsage } from '../contracts.js'
import { LLMAbortedError } from '../contracts.js'

// ---------------------------------------------------------------------------
// Turn vocabulary
// ---------------------------------------------------------------------------

interface ToolCallSpec {
  name: string
  input: Record<string, unknown>
}

interface Turn {
  text?: string
  tools: ToolCallSpec[]
}

/** A tool this agent called, with the result the orchestrator sent back. */
interface Call {
  name: string
  input: Record<string, unknown>
  result: string
}

interface Ctx {
  agent: AgentId
  /** `RUN_START`, `ASSIGNMENT`, `HANDOFF`, `REPORT`, `HUMAN`, `GATE_APPROVED`, or '' when unrecognised. */
  tag: string
  /** `from=`, `kind=`, `target=` attributes parsed out of the tag line. */
  attrs: Record<string, string>
  /** Full text of the wake message, including any [ROOM] / [TREE] sections. */
  wake: string
  /** Tools called since the wake message. */
  wakeCalls: Call[]
  /** Every tool this agent has called in the conversation. */
  calls: Call[]
  /** Tools called before this wake — what had already happened when the agent was woken. */
  prior: Call[]
  /** Assistant turns already taken since the wake message. */
  wakeTurn: number
  /** Assistant turns in the whole conversation — seeds the deterministic delays. */
  totalTurns: number
}

type TurnFn = (c: Ctx) => Turn

interface Scene {
  name: string
  when: (c: Ctx) => boolean
  turns: TurnFn[]
}

const say = (text: string, ...tools: ToolCallSpec[]): TurnFn => () => ({ text, tools })
const call = (name: string, input: Record<string, unknown>): TurnFn => () => ({ tools: [{ name, input }] })
const calls = (...tools: ToolCallSpec[]): TurnFn => () => ({ tools })
const tool = (name: string, input: Record<string, unknown>): ToolCallSpec => ({ name, input })

const did = (list: Call[], name: string): boolean => list.some((c) => c.name === name)
const count = (list: Call[], name: string): number => list.filter((c) => c.name === name).length
const last = (list: Call[], name: string): Call | undefined => [...list].reverse().find((c) => c.name === name)

const isTag = (c: Ctx, ...tags: string[]): boolean => tags.includes(c.tag)
const wakeHas = (c: Ctx, re: RegExp): boolean => re.test(c.wake)
const report = (c: Ctx, from: AgentId, kind: 'done' | 'blocked'): boolean =>
  c.tag === 'REPORT' && c.attrs.from === from && c.attrs.kind === kind

// ---------------------------------------------------------------------------
// Human messages — every agent answers the same way
// ---------------------------------------------------------------------------

const ACK_BROADCAST =
  'Ack — relayed to the room. Forge and Probe are re-prioritising; I will report back the moment the suite is green.'
const ACK_DIRECT = 'Ack, taken directly. Adding it to the front of my queue and reporting back in this thread.'

const ackFor = (c: Ctx): string => (c.attrs.target === 'all' ? ACK_BROADCAST : ACK_DIRECT)

const humanScene: Scene = {
  name: 'human',
  when: (c) => c.tag === 'HUMAN',
  turns: [(c) => ({ text: ackFor(c), tools: [] })],
}

// ---------------------------------------------------------------------------
// Fixture content the agents write into the workspace
// ---------------------------------------------------------------------------

const DOCS = {
  adr: `# ADR-0142 — Passkey sign-in

Status: accepted · Owner: Vector · Flag: auth.passkeys

## Decision
+ resident keys REQUIRED (no roaming-only)
+ attestation: none · origin pinned to helios.app
- fallback: SMS OTP (rejected — see threat model §3)

## Context
helios/api signs users in with password + SMS OTP. The OTP channel is our
largest phishing surface and the SMS provider is the slowest call on the login
path. WebAuthn Level 2 with discoverable (resident) credentials replaces both.

## Consequences
- New credentials table (migration 0043): user_id, unique cred_id, public_key, sign_count.
- POST /webauthn/register and POST /webauthn/verify behind the auth.passkeys flag.
- Replay protection: an assertion is only accepted when its sign_count moves forward.
- services/auth/legacy/otp.ts loses its SMS fallback export; the module stays until the flag is 100%.

## Open questions (answered)
1. Do we accept non-resident credentials? No — resident keys only, so login is username-less.
2. Do we keep SMS as a recovery channel? No — recovery is the existing email magic link.
`,
  threatModel: `# Threat model — passkey sign-in (ADR-0142)

## §1 Assets
- Credential public keys and sign counters (credentials table)
- Session issuance on POST /webauthn/verify

## §2 Threats and mitigations
| Threat | Mitigation |
| --- | --- |
| Phishing / origin spoofing | Origin pinned to https://helios.app, RP id helios.app |
| Cloned authenticator replay | sign_count must strictly increase per credential |
| Credential id confusion | cred_id unique per user; stored as raw bytes |
| Attestation privacy leak | attestation: none |

## §3 Fallback channels
SMS OTP is rejected as a fallback: it reintroduces the phishing surface the
passkey rollout removes. Recovery stays on the email magic link.
`,
}

const FILES = {
  register: `import { randomBytes } from 'node:crypto'
import { db } from '../../db'
import { flags } from '../../flags'
import { AuthError } from '../errors'
import { decodeAttestation, type RegistrationResponse } from './attestation'

export const RP_ID = 'helios.app'
export const ORIGIN = 'https://helios.app'

export interface RegisterChallenge {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' }
  attestation: 'none'
}

export async function beginRegistration(userId: string): Promise<RegisterChallenge> {
  if (!flags.enabled('auth.passkeys', userId)) throw new AuthError('feature_disabled')
  const user = await db.users.findUniqueOrThrow({ where: { id: userId } })
  const challenge = randomBytes(32).toString('base64url')
  await db.challenges.create({ data: { userId, challenge, kind: 'register' } })
  return {
    challenge,
    rp: { id: RP_ID, name: 'Helios' },
    user: { id: user.id, name: user.email, displayName: user.name ?? user.email },
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
  }
}

export async function finishRegistration(userId: string, response: RegistrationResponse) {
  const pending = await db.challenges.findFirst({ where: { userId, kind: 'register' } })
  if (!pending) throw new AuthError('challenge_missing')
  const att = decodeAttestation(response, { origin: ORIGIN, rpId: RP_ID, challenge: pending.challenge })
  const credential = await db.credentials.create({
    data: { userId, credId: att.credentialId, publicKey: att.publicKey, signCount: att.signCount, transports: att.transports },
  })
  await db.challenges.delete({ where: { id: pending.id } })
  return { credentialId: credential.credId }
}
`,
  verify: `import { db } from '../../db'
import { flags } from '../../flags'
import { AuthError } from '../errors'
import { issueSession } from '../session'
import { decodeAssertion, type AssertionResponse } from './assertion'
import { ORIGIN, RP_ID } from './register'

export async function verifyLogin(response: AssertionResponse) {
  const stored = await db.credentials.findUnique({ where: { credId: response.id } })
  if (!stored) throw new AuthError('unknown_credential')
  if (!flags.enabled('auth.passkeys', stored.userId)) throw new AuthError('feature_disabled')

  const pending = await db.challenges.findFirst({ where: { userId: stored.userId, kind: 'login' } })
  if (!pending) throw new AuthError('challenge_missing')
  const assertion = decodeAssertion(response, {
    origin: ORIGIN,
    rpId: RP_ID,
    challenge: pending.challenge,
    publicKey: stored.publicKey,
  })

  // Replay guard: the authenticator counter has to move forward on every assertion.
  if (assertion.signCount >= stored.signCount) {
    await db.credentials.update({
      where: { id: stored.id },
      data: { signCount: assertion.signCount, lastUsedAt: new Date() },
    })
    await db.challenges.delete({ where: { id: pending.id } })
    return issueSession(stored.userId)
  }
  throw new AuthError('replay_detected')
}
`,
  migration: `-- 0043_credentials: WebAuthn credential store (behind auth.passkeys)
CREATE TABLE credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cred_id      TEXT NOT NULL UNIQUE,
  public_key   BYTEA NOT NULL,
  sign_count   INTEGER NOT NULL DEFAULT 0,
  transports   TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX credentials_user_id_idx ON credentials (user_id);
`,
}

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

const RUN_START_TEXT =
  'Run started. Goal: ship passkey sign-in behind the auth.passkeys flag. Split into 5 subtasks, owners assigned. Gate: human approval before merge.'

const ATLAS: Scene[] = [
  {
    name: 'run start → spec phase, Vector on the ADR',
    when: (c) => isTag(c, 'RUN_START'),
    turns: [
      say(RUN_START_TEXT, tool('run_set_phase', { phase: 'spec' })),
      call('run_assign', {
        agent: 'vector',
        phase: 'spec',
        title: 'Auth flow spec + ADR',
        subtask:
          'Write the WebAuthn L2 sign-in spec and threat model as ADR-0142: resident keys, attestation policy, fallback decision. Done when the ADR and threat model are in docs/.',
        eta: '~6 min',
      }),
      say('Vector has the spec. Build owners get assigned the moment ADR-0142 lands.'),
    ],
  },
  {
    name: 'Vector done → build phase, Forge + Probe assigned',
    when: (c) => report(c, 'vector', 'done'),
    turns: [
      call('run_handoff', { from: 'vector', to: 'forge', note: 'ADR-0142 accepted' }),
      call('run_set_phase', { phase: 'build' }),
      call('run_assign', {
        agent: 'forge',
        phase: 'build',
        title: 'POST /webauthn/register',
        subtask:
          'Implement the register and verify endpoints plus the credentials migration 0043, all behind the auth.passkeys flag. Done when typecheck passes and the branch is pushed.',
        eta: '~8 min',
      }),
      call('run_assign', {
        agent: 'probe',
        phase: 'test',
        title: 'Register / login e2e',
        subtask:
          "Wait for Forge's push, then run the passkey e2e suite and isolate any failures down to the responsible change.",
        eta: '~5 min',
      }),
      say("Build is on. Probe, hold for Forge's first push."),
    ],
  },
  {
    name: 'Probe blocked on the guard → Forge fixes, Sentry pre-reads',
    when: (c) => report(c, 'probe', 'blocked') && !assignedSentry(c),
    turns: [
      call('run_handoff', { from: 'probe', to: 'forge', note: 'sign_count guard off-by-one' }),
      call('run_assign', {
        agent: 'sentry',
        phase: 'review',
        title: 'Diff review · 412 LOC',
        subtask:
          'Pre-read the diff and run a security pass on credential storage and replay protection. Block on anything storage-unsafe.',
        eta: '~6 min',
      }),
      say('Forge takes the guard; Sentry starts the pre-read.'),
    ],
  },
  {
    name: 'Sentry blocked on cred_id → test phase, gate held, Forge on bytea',
    when: (c) => report(c, 'sentry', 'blocked'),
    turns: [
      call('run_set_phase', { phase: 'test' }),
      say(
        'Merge gate held. Forge: cred_id → bytea, then push. Probe re-runs the suite on the next push.',
        tool('run_handoff', { from: 'atlas', to: 'forge', note: 'cred_id → bytea (Sentry blocking)' }),
      ),
      say('Holding until Probe is green and Sentry clears the comment.'),
    ],
  },
  {
    name: 'Forge done → Probe re-runs',
    when: (c) => report(c, 'forge', 'done'),
    turns: [
      call('run_handoff', { from: 'forge', to: 'probe', note: 're-run on latest push' }),
      say('Probe re-runs on the latest push.'),
    ],
  },
  {
    name: 'Probe done → Sentry reviews',
    when: (c) => report(c, 'probe', 'done'),
    turns: [
      call('run_handoff', { from: 'probe', to: 'sentry', note: 'suite green, review' }),
      say('Suite green. Sentry, the review is yours.'),
    ],
  },
  {
    name: 'Sentry done → review, ship, request merge',
    when: (c) => report(c, 'sentry', 'done'),
    turns: [
      call('run_set_phase', { phase: 'review' }),
      call('run_set_phase', { phase: 'ship' }),
      call('run_request_merge', {
        summary: 'passkey sign-in behind auth.passkeys; ADR-0142; migration 0043; 24/24 e2e; security review approved',
      }),
      say('Requesting merge. Gate is with the human.'),
    ],
  },
  {
    name: 'gate approved → merge and finish',
    when: (c) => isTag(c, 'GATE_APPROVED'),
    turns: [
      say(
        'Approved. Merging #482 and rolling the canary to 5%.',
        tool('run_finish', { summary: 'Shipped: passkey sign-in behind auth.passkeys. Canary 5%.' }),
      ),
      say('Run complete.'),
    ],
  },
  humanScene,
  {
    name: 'any other blocked report → route to Forge',
    when: (c) => c.tag === 'REPORT' && c.attrs.kind === 'blocked',
    turns: [
      (c) => ({
        text: `Noted — ${c.attrs.from ?? 'someone'} is blocked. Routing to ${c.attrs.from === 'forge' ? 'Probe' : 'Forge'}.`,
        tools: [
          tool('run_handoff', {
            from: c.attrs.from ?? 'atlas',
            to: c.attrs.from === 'forge' ? 'probe' : 'forge',
            note: trim(wakeBody(c), 80) || 'unblock',
          }),
        ],
      }),
      say('Waiting on the fix.'),
    ],
  },
  {
    name: 'any other done report',
    when: (c) => c.tag === 'REPORT',
    turns: [(c) => ({ text: `Noted — ${c.attrs.from ?? 'agent'} reports done. Nothing to reassign yet.`, tools: [] })],
  },
]

const VECTOR: Scene[] = [
  {
    name: 'assignment → research, ADR-0142, threat model, done',
    when: (c) => isTag(c, 'ASSIGNMENT', 'HANDOFF') && !did(c.prior, 'agent_done'),
    turns: [
      call('web_fetch', { query: 'webauthn level 2 resident keys' }),
      call('repo_read', { path: 'prisma/schema.prisma' }),
      say(
        'Spec locked — WebAuthn L2, resident keys required, no SMS fallback. Both open questions from the threat model are answered; writing them into ADR-0142.',
        tool('docs_write', { name: 'ADR-0142-passkey-auth.md', content: DOCS.adr }),
      ),
      call('docs_write', { name: 'threat-model.md', content: DOCS.threatModel }),
      call('agent_progress', {
        pct: 100,
        subtask: 'ADR-0142 + threat model',
        eta: 'done',
        io: ['ADR-0142.md', 'threat-model.md', '3 decisions'],
      }),
      call('agent_done', {
        summary: 'ADR-0142 + threat model landed',
        io: ['ADR-0142.md', 'threat-model.md', '3 decisions'],
      }),
      say('Handing off to Forge.'),
    ],
  },
  humanScene,
  {
    name: 'anything else',
    when: () => true,
    turns: [say('Noted — ADR-0142 stands as written; ping me if the threat model needs a revision.')],
  },
]

const FORGE: Scene[] = [
  {
    name: 'assignment → register/verify endpoints, migration 0043, push',
    when: (c) => (isTag(c, 'ASSIGNMENT') || (isTag(c, 'HANDOFF') && wakeHas(c, /ADR-0142/))) && !did(c.prior, 'repo_push'),
    turns: [
      call('docs_read', { name: 'ADR-0142-passkey-auth.md' }),
      say(
        'Implementing POST /webauthn/register. Credential store needs a migration: new credentials table with user_id, unique cred_id, sign_count.',
        tool('repo_write', { path: 'services/auth/webauthn/register.ts', content: FILES.register }),
      ),
      call('repo_write', { path: 'services/auth/webauthn/verify.ts', content: FILES.verify }),
      call('db_migrate', { name: '0043_credentials', sql: FILES.migration }),
      call('repo_read', { path: 'services/auth/legacy/otp.ts' }),
      (c) => ({ tools: [tool('repo_patch', { path: 'services/auth/legacy/otp.ts', edits: [smsExportEdit(c)] })] }),
      call('shell_run', { command: 'pnpm typecheck' }),
      calls(
        tool('agent_progress', {
          pct: 72,
          subtask: 'POST /webauthn/register · migration 0043',
          eta: '~3 min',
          io: ['ADR-0142', '7 files', '+318 −24', 'migration 0043'],
        }),
        tool('repo_push', { message: 'feat(auth): webauthn register + credentials migration' }),
      ),
      say('Pushed. @Probe the suite is yours.', tool('agent_queue', { title: 'Credential store rollback path', meta: 'next' })),
      say("Holding for Probe's run; the rollback path is next in my queue."),
    ],
  },
  {
    name: 'handoff: sign_count guard → strict comparison, push',
    when: (c) => isTag(c, 'HANDOFF') && wakeHas(c, /guard|off-by-one|sign_count/i) && !guardFixed(c),
    turns: [
      say(
        '@Probe that one is mine — off-by-one in the counter comparison. Patching now, then push for a re-run.',
        tool('repo_patch', {
          path: 'services/auth/webauthn/verify.ts',
          edits: [{ find: 'signCount >= stored', replace: 'signCount > stored' }],
        }),
      ),
      call('shell_run', { command: 'pnpm typecheck' }),
      call('repo_push', { message: 'fix(auth): strict sign_count comparison' }),
      call('agent_progress', {
        pct: 85,
        subtask: 'guard fixed · awaiting re-run',
        eta: '~2 min',
        io: ['verify.ts', '7 files', 'migration 0043'],
      }),
      say('Pushed the guard fix.'),
    ],
  },
  {
    name: 'handoff: cred_id → bytea, push, done',
    when: (c) => isTag(c, 'HANDOFF') && wakeHas(c, /bytea|cred_id/i) && !did(c.prior, 'agent_done'),
    turns: [
      call('repo_read', { path: 'db/migrations/0043_credentials.sql' }),
      (c) => ({ tools: [tool('repo_patch', { path: 'db/migrations/0043_credentials.sql', edits: [byteaEdit(c)] })] }),
      call('repo_push', { message: 'fix(db): cred_id bytea' }),
      call('agent_progress', {
        pct: 100,
        subtask: 'register/verify + migration 0043',
        eta: 'done',
        io: ['7 files', '+318 −24', 'migration 0043'],
      }),
      call('agent_done', {
        summary: 'register/verify + migration 0043 landed; guard and bytea fixed',
        io: ['7 files', '+318 −24', 'migration 0043'],
      }),
      say('Landed. Over to Probe for the re-run.'),
    ],
  },
  {
    name: 'human asks for a rollback',
    when: (c) => c.tag === 'HUMAN' && wakeHas(c, /roll\s*-?back/i),
    turns: [call('repo_rollback', {}), (c) => ({ text: `Rolled back to the last push. ${ackFor(c)}`, tools: [] })],
  },
  humanScene,
  {
    name: 'anything else',
    when: () => true,
    turns: [
      (c) => ({
        text: did(c.calls, 'repo_push')
          ? 'Noted — register/verify and migration 0043 are already on the branch; waiting on Probe.'
          : 'Noted — waiting on the build assignment.',
        tools: [],
      }),
    ],
  },
]

const PROBE: Scene[] = [
  {
    name: 'assignment before any push → stand by',
    when: (c) => isTag(c, 'ASSIGNMENT') && !pushSeen(c) && !did(c.prior, 'shell_run'),
    turns: [say("Standing by for Forge's push.")],
  },
  {
    name: 'push seen / handoff / asked to re-run → run the suite',
    when: (c) => (pushSeen(c) || isTag(c, 'HANDOFF') || (c.tag === 'HUMAN' && wakeHas(c, /re-?run|suite|test/i))) && !did(c.wakeCalls, 'shell_run'),
    turns: [call('shell_run', { command: 'pnpm e2e --grep passkey' })],
  },
  {
    name: 'suite failing → trace, isolate, block on Forge',
    when: (c) => did(c.wakeCalls, 'shell_run') && !suiteGreen(c),
    turns: [
      call('shell_run', { command: 'pnpm e2e --grep passkey' }),
      call('artifact_get', { name: 'trace-latest.zip' }),
      (c) => {
        const t = suiteNumbers(c)
        return {
          tools: [
            tool('agent_progress', {
              pct: 58,
              subtask: `e2e suite ${t.passed}/${t.total} · isolating ${t.failed} failures`,
              eta: '~4 min',
              io: ['e2e/passkey.spec.ts', 'trace-latest.zip', `${t.failed} failing`],
            }),
          ],
        }
      },
      (c) => {
        const t = suiteNumbers(c)
        const first = count(c.prior, 'agent_blocked') === 0
        return {
          text: first
            ? `Picked up the e2e suite. ${t.passed} of ${t.total} passing. Two failures look like the sign_count replay guard rejecting a valid re-registration.`
            : `Re-ran on the latest push: still ${t.failed} failing — ${t.failures.join(', ') || 'see trace-latest.zip'}.`,
          tools: [
            tool('agent_blocked', {
              reason: first ? 'replay guard off-by-one in verify.ts' : `${t.failed} passkey e2e cases still failing`,
              waiting_on: 'forge',
            }),
          ],
        }
      },
      say("Blocked on Forge's fix; I re-run on the next push."),
    ],
  },
  {
    name: 'suite green → done',
    when: (c) => did(c.wakeCalls, 'shell_run') && suiteGreen(c),
    turns: [
      call('shell_run', { command: 'pnpm e2e --grep passkey' }),
      call('agent_progress', {
        pct: 100,
        subtask: 'e2e green 24/24',
        eta: 'done',
        io: ['e2e/passkey.spec.ts', '24 cases', '0 failing'],
      }),
      (c) => {
        const t = suiteNumbers(c)
        return {
          text: `Suite green: ${t.total}/${t.total} on the latest push.`,
          tools: [tool('agent_done', { summary: `e2e green ${t.total}/${t.total}`, io: ['e2e/passkey.spec.ts', `${t.total} cases`, '0 failing'] })],
        }
      },
      say('Green across the board. Sentry has the review.'),
    ],
  },
  humanScene,
  {
    name: 'anything else',
    when: () => true,
    turns: [say("Still standing by for Forge's push.")],
  },
]

const SENTRY: Scene[] = [
  {
    name: 'assignment → diff pre-read, sec scan, blocking comment on cred_id',
    when: (c) => isTag(c, 'ASSIGNMENT', 'HANDOFF') && !did(c.prior, 'pr_comment'),
    turns: [
      call('repo_diff', {}),
      call('sec_scan', {}),
      say(
        'Flagging before review: cred_id is stored as text. The base64 round-trip will bite us on Windows Hello — it should be bytea. Blocking unless someone disagrees.',
        tool('pr_comment', {
          body: 'cred_id must be bytea, not text — base64 round-trip corrupts Windows Hello credential ids',
          blocking: true,
        }),
      ),
      call('agent_progress', {
        pct: 20,
        subtask: 'blocked · waiting on green suite',
        eta: '—',
        io: ['PR #482', '412 LOC', '1 blocking'],
      }),
      call('agent_blocked', { reason: 'review blocked until suite green + cred_id fixed', waiting_on: 'forge' }),
      say('Holding the review until the suite is green and cred_id is bytea.'),
    ],
  },
  {
    name: 'handoff after green → re-scan, resolve comment, approve',
    when: (c) => isTag(c, 'HANDOFF') && did(c.prior, 'pr_comment') && !did(c.prior, 'pr_review'),
    turns: [
      call('repo_diff', {}),
      call('sec_scan', {}),
      (c) => ({ tools: [tool('pr_resolve', { id: commentId(c) })] }),
      call('pr_review', { verdict: 'approve', summary: 'storage + replay protection sound' }),
      call('agent_done', { summary: 'review approved', io: ['PR #482', '412 LOC', '0 blocking'] }),
      say('Approved. Nothing blocking on #482.'),
    ],
  },
  humanScene,
  {
    name: 'anything else',
    when: () => true,
    turns: [
      (c) => ({
        text: did(c.calls, 'pr_review') ? 'Review already approved; nothing new to flag.' : 'Noted — still holding until the suite is green.',
        tools: [],
      }),
    ],
  },
]

const STORY: Record<AgentId, Scene[]> = { atlas: ATLAS, vector: VECTOR, forge: FORGE, probe: PROBE, sentry: SENTRY }

const OFF_SCRIPT: Record<AgentId, string> = {
  atlas: 'Noted. Holding position until the next report comes in.',
  vector: 'Noted — nothing further from the spec side.',
  forge: 'Noted — nothing further on my side.',
  probe: 'Noted — standing by.',
  sentry: 'Noted — nothing further to flag.',
}

// ---------------------------------------------------------------------------
// Story predicates that read tool results
// ---------------------------------------------------------------------------

function assignedSentry(c: Ctx): boolean {
  return c.prior.some((k) => k.name === 'run_assign' && k.input.agent === 'sentry')
}

function guardFixed(c: Ctx): boolean {
  return c.prior.some((k) => k.name === 'repo_patch' && JSON.stringify(k.input).includes('signCount > stored'))
}

/** Forge's "Pushed…" line in a [ROOM] section, or a repo.push card. */
function pushSeen(c: Ctx): boolean {
  return /\bPushed\b|repo[._]push/.test(c.wake)
}

interface SuiteNumbers {
  passed: number
  failed: number
  total: number
  failures: string[]
}

/**
 * Parse the e2e result the tool sent back. Formats vary, so try a few shapes;
 * when nothing parses fall back to the story: 2/24 fail on the first run,
 * green after Forge's fix.
 */
function suiteNumbers(c: Ctx): SuiteNumbers {
  const run = last(c.wakeCalls, 'shell_run')
  const out = run?.result ?? ''
  const firstRun = count(c.prior, 'agent_blocked') === 0
  const fallback: SuiteNumbers = firstRun
    ? { passed: 22, failed: 2, total: 24, failures: ['passkey › re-register same authenticator', 'passkey › login after counter reset'] }
    : { passed: 24, failed: 0, total: 24, failures: [] }

  const json = /"failed"\s*:\s*(\d+)[^}]*?"total"\s*:\s*(\d+)/.exec(out) ?? /"total"\s*:\s*(\d+)[^}]*?"failed"\s*:\s*(\d+)/.exec(out)
  const ratio = /(\d+)\s*\/\s*(\d+)\s*(?:pass|green|ok)/i.exec(out)
  const words = { passed: /(\d+)\s+pass(?:ed|ing)?/i.exec(out), failed: /(\d+)\s+fail(?:ed|ing|ures?)?/i.exec(out) }

  let failed: number | null = null
  let total: number | null = null
  let passed: number | null = null
  if (json) {
    const jsonFailedFirst = out.indexOf('"failed"') < out.indexOf('"total"')
    failed = Number(jsonFailedFirst ? json[1] : json[2])
    total = Number(jsonFailedFirst ? json[2] : json[1])
  } else if (ratio) {
    passed = Number(ratio[1])
    total = Number(ratio[2])
  } else if (words.passed || words.failed) {
    passed = words.passed ? Number(words.passed[1]) : null
    failed = words.failed ? Number(words.failed[1]) : 0
  }
  if (failed === null && total === null && passed === null) return fallback

  const t = total ?? (passed ?? 0) + (failed ?? 0)
  const f = failed ?? t - (passed ?? t)
  const p = passed ?? t - f
  const failures = out
    .split('\n')
    .filter((l) => /^\s*(?:✗|✕|×|FAIL|✘)/.test(l))
    .map((l) => l.replace(/^\s*(?:✗|✕|×|FAIL|✘)\s*/, '').trim())
    .slice(0, 4)
  return { passed: p, failed: f, total: t, failures }
}

function suiteGreen(c: Ctx): boolean {
  return suiteNumbers(c).failed === 0
}

/** The id the workspace gave Sentry's blocking comment, from that tool's result. */
function commentId(c: Ctx): string {
  const posted = last(c.calls, 'pr_comment')
  const out = posted?.result ?? ''
  try {
    const parsed = JSON.parse(out) as { id?: unknown }
    if (typeof parsed.id === 'string') return parsed.id
  } catch {
    // not JSON — fall through to the text shapes
  }
  const labelled = /\bid[=:]\s*"?([\w-]+)/i.exec(out)
  if (labelled) return labelled[1]
  const token = /\b([a-z]+[-_]?\d+)\b/i.exec(out)
  return token ? token[1] : 'c1'
}

/** Exact substring of otp.ts to patch — the SMS fallback export — chosen from what repo_read returned. */
function smsExportEdit(c: Ctx): { find: string; replace: string } {
  const src = last(c.wakeCalls, 'repo_read')?.result ?? ''
  const exports = [...src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|let)\s+\w+/g)].map((m) => m[0])
  const target = exports.find((e) => /sms|otp/i.test(e)) ?? exports[0] ?? 'export'
  return {
    find: target,
    replace: `// SMS OTP fallback removed — rejected in ADR-0142 (threat model §3)\n${target.replace(/^export\s+(default\s+)?/, '')}`,
  }
}

/** `cred_id … TEXT` → `… BYTEA`, matched against the migration as read back (tolerates line-number prefixes). */
function byteaEdit(c: Ctx): { find: string; replace: string } {
  const src = last(c.wakeCalls, 'repo_read')?.result ?? ''
  const m = /cred_id\s+TEXT/i.exec(src)
  const find = m ? m[0] : 'cred_id TEXT'
  return { find, replace: find.replace(/TEXT/i, 'BYTEA') }
}

// ---------------------------------------------------------------------------
// Wake-message parsing
// ---------------------------------------------------------------------------

type Block = Anthropic.Beta.BetaContentBlockParam | Anthropic.Beta.BetaContentBlock

function blocksOf(m: Anthropic.Beta.BetaMessageParam): Block[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Block[])
}

function textOf(m: Anthropic.Beta.BetaMessageParam): string {
  return blocksOf(m)
    .filter((b): b is Anthropic.Beta.BetaTextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

function resultText(content: Anthropic.Beta.BetaToolResultBlockParam['content']): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
}

const TAG_RE = /^\[([A-Z_]+)([^\]]*)\]/

function parseTag(text: string): { tag: string; attrs: Record<string, string> } {
  const m = TAG_RE.exec(text.trimStart())
  if (!m) return { tag: '', attrs: {} }
  const attrs: Record<string, string> = {}
  for (const [, k, v] of m[2].matchAll(/(\w+)=([\w-]+)/g)) attrs[k] = v
  return { tag: m[1], attrs }
}

/** The wake text without its tag line and trailing [ROOM]/[TREE] sections. */
function wakeBody(c: Ctx): string {
  return c.wake
    .replace(TAG_RE, '')
    .split(/\n\[(?:ROOM|TREE)\]/)[0]
    .trim()
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function buildCtx(req: LLMRequest): Ctx {
  const msgs = req.messages
  let wakeIndex = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && TAG_RE.test(textOf(msgs[i]).trimStart())) {
      wakeIndex = i
      break
    }
  }
  const wake = wakeIndex >= 0 ? textOf(msgs[wakeIndex]) : ''
  const { tag, attrs } = parseTag(wake)

  const results = new Map<string, string>()
  for (const m of msgs) {
    if (m.role !== 'user') continue
    for (const b of blocksOf(m)) {
      if (b.type === 'tool_result') results.set(b.tool_use_id, resultText(b.content))
    }
  }

  const calls: Call[] = []
  const wakeCalls: Call[] = []
  const prior: Call[] = []
  let totalTurns = 0
  let wakeTurn = 0
  msgs.forEach((m, i) => {
    if (m.role !== 'assistant') return
    totalTurns++
    if (i > wakeIndex) wakeTurn++
    for (const b of blocksOf(m)) {
      if (b.type !== 'tool_use') continue
      const c: Call = { name: b.name, input: (b.input ?? {}) as Record<string, unknown>, result: results.get(b.id) ?? '' }
      calls.push(c)
      if (i > wakeIndex) wakeCalls.push(c)
      else prior.push(c)
    }
  })

  return { agent: req.agent, tag, attrs, wake, wakeCalls, calls, prior, wakeTurn, totalTurns }
}

function chooseTurn(c: Ctx): Turn {
  const scene = STORY[c.agent].find((s) => s.when(c))
  if (!scene) return { text: OFF_SCRIPT[c.agent], tools: [] }
  const fn = scene.turns[c.wakeTurn]
  return fn ? fn(c) : { text: OFF_SCRIPT[c.agent], tools: [] }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const CHUNK_CHARS = 24
const CHUNK_DELAY_MS = 25

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LLMAbortedError())
    if (ms <= 0) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LLMAbortedError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function estimateUsage(req: LLMRequest, c: Ctx, turn: Turn): LLMUsage {
  const historyChars = req.system.length + req.messages.reduce((n, m) => n + JSON.stringify(m.content).length, 0)
  const input = Math.min(6000, Math.max(1800, Math.round(historyChars / 4)))
  const outputChars = (turn.text?.length ?? 0) + turn.tools.reduce((n, t) => n + JSON.stringify(t.input).length, 0)
  const output = Math.min(600, Math.max(80, Math.round(outputChars / 3)))
  const first = c.totalTurns === 0
  return {
    model: req.model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: first ? 0 : Math.round(input * 0.6),
    cacheWriteTokens: first ? Math.round(input * 0.4) : 0,
  }
}

export function createMockLLM(config: Config): LLM {
  const speed = Math.max(0, config.mockSpeed)
  let toolSeq = 0

  return {
    kind: 'mock',

    async complete(req: LLMRequest): Promise<LLMResult> {
      const ctx = buildCtx(req)
      const turn = chooseTurn(ctx)

      const thinkMs = 300 + (hash(`${req.agent}:${ctx.totalTurns}`) % 601)
      await sleep(thinkMs * speed, req.signal)

      const content: Anthropic.Beta.BetaContentBlock[] = []
      if (turn.text) {
        for (let i = 0; i < turn.text.length; i += CHUNK_CHARS) {
          if (i > 0) await sleep(CHUNK_DELAY_MS * speed, req.signal)
          req.onText?.(turn.text.slice(i, i + CHUNK_CHARS))
        }
        content.push({ type: 'text', text: turn.text, citations: null })
      }
      const toolUses: Anthropic.Beta.BetaToolUseBlock[] = turn.tools.map((t) => ({
        type: 'tool_use',
        id: `toolu_${++toolSeq}`,
        name: t.name,
        input: t.input,
      }))
      content.push(...toolUses)
      if (req.signal.aborted) throw new LLMAbortedError()

      return {
        content,
        toolUses,
        text: turn.text ?? '',
        stopReason: toolUses.length ? 'tool_use' : 'end_turn',
        usage: estimateUsage(req, ctx, turn),
      }
    },

    async healthcheck(): Promise<string | null> {
      return null
    },
  }
}
