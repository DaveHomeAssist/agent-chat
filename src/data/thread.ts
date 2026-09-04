import { COLOR } from '../lib/theme'
import type { ThreadItem } from '../types'

/** The conversation as it stands when the operator opens the room. */
export const BASE_THREAD: ThreadItem[] = [
  { id: 't01', kind: 'divider', body: 'PHASE 1 · SPEC', time: '14:02' },
  {
    id: 't02',
    kind: 'message',
    who: 'atlas',
    badge: 'PLAN',
    body: 'Run started. Goal: ship passkey sign-in behind the auth.passkeys flag. Split into 5 subtasks, owners assigned. Gate: human approval before merge.',
    time: '14:02',
    chips: ['plan/run-04.yaml', '5 subtasks', 'gate: human'],
  },
  {
    id: 't03',
    kind: 'message',
    who: 'vector',
    body: 'Spec locked — WebAuthn L2, resident keys required, no SMS fallback. Both open questions from the threat model are answered; writing them into ADR-0142.',
    time: '14:09',
  },
  {
    id: 't04',
    kind: 'tool',
    who: 'vector',
    tool: 'docs.write',
    body: 'ADR-0142-passkey-auth.md',
    dur: '1.2s',
    status: 'ok',
    lines: [
      { text: '# ADR-0142 — Passkey sign-in', color: '#8C95A9' },
      { text: '+ resident keys REQUIRED (no roaming-only)', color: COLOR.teal },
      { text: '+ attestation: none · origin pinned to helios.app', color: COLOR.teal },
      { text: '- fallback: SMS OTP (rejected — see threat model §3)', color: COLOR.pink },
    ],
  },
  { id: 't05', kind: 'handoff', body: 'Vector → Forge · ADR-0142 accepted', time: '14:11' },
  { id: 't06', kind: 'divider', body: 'PHASE 2 · BUILD', time: '14:12' },
  {
    id: 't07',
    kind: 'message',
    who: 'forge',
    body: 'Implementing POST /webauthn/register. Credential store needs a migration: new credentials table with user_id, unique cred_id, sign_count.',
    time: '14:14',
    chips: ['migration 0043', '7 files'],
  },
  {
    id: 't08',
    kind: 'tool',
    who: 'forge',
    tool: 'repo.patch',
    body: '7 files · +318 −24',
    dur: '4.1s',
    status: 'ok',
    lines: [
      { text: 'services/auth/webauthn/register.ts   +96', color: COLOR.teal },
      { text: 'services/auth/webauthn/verify.ts    +54', color: COLOR.teal },
      { text: 'db/migrations/0043_credentials.sql  +38', color: COLOR.teal },
      { text: 'services/auth/legacy/otp.ts         −24', color: COLOR.pink },
    ],
  },
  {
    id: 't09',
    kind: 'message',
    who: 'probe',
    badge: '18/24',
    body: 'Picked up the e2e suite. 18 of 24 passing. Two failures look like the sign_count replay guard rejecting a valid re-registration.',
    time: '14:30',
  },
  {
    id: 't10',
    kind: 'message',
    who: 'forge',
    body: '@Probe that one is mine — off-by-one in the counter comparison. Patching now, then push 4f9c1ad for a re-run.',
    time: '14:33',
  },
  { id: 't11', kind: 'divider', body: 'PHASE 3 · TEST', time: '14:34' },
  {
    id: 't12',
    kind: 'message',
    who: 'sentry',
    badge: 'RISK',
    body: 'Flagging before review: cred_id is stored as text. The base64 round-trip will bite us on Windows Hello — it should be bytea. Blocking unless someone disagrees.',
    time: '14:36',
  },
  {
    id: 't13',
    kind: 'human',
    body: 'Hold the merge until Probe is green. Sentry — write the bytea concern up as a blocking comment on #482, do not just leave it in chat.',
    time: '14:37',
  },
  {
    id: 't14',
    kind: 'message',
    who: 'atlas',
    badge: 'ACK',
    body: 'Ack. Merge gate held. Sentry is drafting the blocking comment; Probe re-runs the suite as soon as Forge pushes.',
    time: '14:37',
    chips: ['gate: HELD', 'next: probe/e2e'],
  },
]

/** Slash-command shortcuts that prefill the composer. */
export const QUICK_COMMANDS: { label: string; draft: string }[] = [
  {
    label: '/approve merge #482',
    draft: 'Approve merge and release the gate — Sentry, close your blocking comment first.',
  },
  {
    label: '/assign probe re-run',
    draft: 'Probe, re-run the full suite on 4f9c1ad and post the failing traces.',
  },
  {
    label: '/rollback build',
    draft: 'Roll back to 3a1e77f and hold all build subtasks until I say otherwise.',
  },
]

export const FILTERS: { key: 'all' | 'decisions' | 'tools' | 'handoffs'; label: string; count: string }[] = [
  { key: 'all', label: 'All', count: '128' },
  { key: 'decisions', label: 'Decisions', count: '9' },
  { key: 'tools', label: 'Tool calls', count: '41' },
  { key: 'handoffs', label: 'Handoffs', count: '6' },
]
