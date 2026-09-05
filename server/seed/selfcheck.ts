/**
 * Determinism check for the simulated toolchain. Plays the design's story
 * against a fresh workspace and asserts each beat lands exactly:
 *
 *   npx tsx server/seed/selfcheck.ts
 */

import { createWorkspace } from '../workspace.js'
import { createToolRegistry } from '../tools.js'
import type { RunStore, ToolContext } from '../contracts.js'

let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

function same<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

const REGISTER_TS = `import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../users'

const RegisterBody = z.object({ userId: z.string().uuid(), attestation: z.string(), clientData: z.string() })

export async function register(input: unknown) {
  const body = RegisterBody.parse(input)
  const challenge = randomBytes(32)
  return prisma.credential.create({ data: { userId: body.userId, credId: body.attestation, signCount: 0, challenge } })
}
`

function verifyTs(op: '>=' | '>'): string {
  return `import { timingSafeEqual } from 'node:crypto'
import { prisma } from '../users'

export async function verify(credId: Buffer, signCount: number): Promise<boolean> {
  const stored = await prisma.credential.findUnique({ where: { credId } })
  if (!stored) return false
  // replay guard: a fresh assertion must carry a counter above the stored one
  const fresh = stored.signCount === 0 || signCount ${op} stored.signCount
  if (!fresh) return false
  await prisma.credential.update({ where: { credId }, data: { signCount } })
  return true
}
`
}

function migration(type: 'TEXT' | 'BYTEA'): string {
  return `-- 0043_credentials: passkey credential store
CREATE TABLE IF NOT EXISTS credentials (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cred_id    ${type} NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  sign_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credentials_user_idx ON credentials (user_id);`
}

function buildFeature(ws: ReturnType<typeof createWorkspace>, op: '>=' | '>', column: 'TEXT' | 'BYTEA'): void {
  ws.write('services/auth/webauthn/register.ts', REGISTER_TS)
  ws.write('services/auth/webauthn/verify.ts', verifyTs(op))
  const applied = ws.migrations.apply('0043_credentials', migration(column))
  if (!applied.ok) throw new Error(applied.message)
  ws.remove('services/auth/legacy/otp.ts')
}

async function main(): Promise<void> {
  const ws = createWorkspace()

  // Seed sanity: green toolchain, e2e cannot run without the feature.
  const seedTc = await ws.run('pnpm typecheck')
  check('seed typecheck is green', seedTc.exitCode === 0 && !/warning TS/.test(seedTc.stdout), seedTc.stdout.split('\n').at(-1))
  const seedE2e = await ws.run('pnpm e2e')
  check('seed e2e fails every case (no feature yet)', seedE2e.tests?.failed === 24, `${seedE2e.tests?.failed} failed`)
  check('seed e2e says nothing is pushed yet', seedE2e.stdout.startsWith('e2e on seed') && seedE2e.stderr === '', seedE2e.stdout.split('\n')[0])
  const denied = await ws.run('rm -rf /')
  check('disallowed command exits 127', denied.exitCode === 127)

  // Beat 1: Forge's first cut — >= guard, TEXT column. Until it is pushed the
  // working tree shows in the diff but not in e2e, which runs on the last push.
  buildFeature(ws, '>=', 'TEXT')
  const diff = ws.diff()
  check('diff stat lists the four touched files', diff.files === 4, diff.lines.join(' | '))
  check('diff line for a removed file uses unicode minus', diff.lines.some((l) => /^services\/auth\/legacy\/otp\.ts\s+−24$/.test(l)))
  const unpushed = await ws.run('pnpm e2e')
  check('e2e before the push still runs the seed', unpushed.tests?.failed === 24, `${unpushed.tests?.failed} failed`)
  check('e2e notes the unpushed changes on stderr', unpushed.stderr === 'note: 4 unpushed change(s) not included', unpushed.stderr)
  const firstPush = ws.push('feat(auth): webauthn register + credentials migration')
  const first = await ws.run('pnpm e2e --grep passkey')
  const designed = ['register.reregister → 400 replay', 'login.windowsHello → cred_id mismatch']
  check('>= guard + TEXT column → the 2 designed failures', same(first.tests?.failures ?? [], designed), (first.tests?.failures ?? []).join(' | '))
  check('e2e names the sha it ran against', first.stdout.startsWith(`e2e on ${firstPush.sha}`) && first.stderr === '', first.stdout.split('\n')[0])
  check('e2e duration reads like the design', /118\.4s/.test(first.stdout), /\(\d+\.\ds\)/.exec(first.stdout)?.[0])
  const trace = ws.artifact('trace-latest.zip') ?? ''
  check('trace artifact describes both failures', designed.every((f) => trace.includes(f)))
  check('--grep announces substring semantics in stdout', /grep: substring match/.test(first.stdout))
  const grepCase = await ws.run('pnpm e2e --grep WINDOWSHELLO')
  check('--grep is a case-insensitive substring match', grepCase.tests?.total === 2, `${grepCase.tests?.total} selected`)
  const grepMeta = await ws.run('pnpm e2e --grep "register.*"')
  check('--grep never compiles a regex', grepMeta.tests?.total === 0 && /no tests matched/.test(grepMeta.stdout), `${grepMeta.tests?.total} selected`)
  const tc = await ws.run('pnpm typecheck')
  check('typecheck warns on the unused import in verify.ts', tc.exitCode === 0 && /webauthn\/verify\.ts\(1,10\): warning TS6133: 'timingSafeEqual'/.test(tc.stdout))
  ws.write('services/auth/webauthn/broken.ts', 'export function x() {\n  return (1\n}\n')
  check('typecheck fails on unbalanced parens', (await ws.run('pnpm typecheck')).exitCode === 1)
  check('unit tests fail while typecheck fails', (await ws.run('pnpm test')).exitCode === 1)
  ws.remove('services/auth/webauthn/broken.ts')

  // Beat 1b: same guard with a BYTEA column still yields exactly the same two failures.
  ws.migrations.apply('0043_credentials', migration('BYTEA'))
  ws.push('fix(db): cred_id bytea')
  const bytea = await ws.run('pnpm e2e')
  check('>= guard + BYTEA column → still the 2 designed failures', same(bytea.tests?.failures ?? [], designed), (bytea.tests?.failures ?? []).join(' | '))

  // Beat 2: the off-by-one fix → green (no TEXT column anywhere) — but only once it is pushed.
  const patched = ws.patch('services/auth/webauthn/verify.ts', [{ find: 'signCount >= stored.signCount', replace: 'signCount > stored.signCount' }])
  check('patch applied the > fix', patched.applied === 1 && patched.missing.length === 0)
  const stale = await ws.run('pnpm e2e')
  check('unpushed fix is not under test', same(stale.tests?.failures ?? [], designed) && stale.stderr === 'note: 1 unpushed change(s) not included', stale.stderr)
  ws.push('fix(auth): strict sign_count comparison')
  const fixed = await ws.run('pnpm e2e')
  check('> guard + BYTEA → 24/24', fixed.tests?.passed === 24 && fixed.exitCode === 0, `${fixed.tests?.passed}/${fixed.tests?.total}`)

  // Beat 3: Sentry's finding — a TEXT column alone fails only login.windowsHello.
  ws.migrations.apply('0043_credentials', migration('TEXT'))
  ws.push('chore(db): cred_id text')
  const textOnly = await ws.run('pnpm e2e')
  check('> guard + TEXT column → cred_id mismatch only', same(textOnly.tests?.failures ?? [], ['login.windowsHello → cred_id mismatch']), (textOnly.tests?.failures ?? []).join(' | '))
  const scan = ws.secScan()
  check('sec.scan flags cred_id TEXT as RISK', scan.some((f) => f.level === 'RISK' && f.msg === 'cred_id stored as text — base64 round-trip'))

  // Beat 4: bytea lands → green and the scan is clean.
  ws.migrations.apply('0043_credentials', migration('BYTEA'))
  ws.push('fix(db): cred_id bytea')
  const green = await ws.run('pnpm e2e')
  check('> guard + BYTEA → 24/24 again', green.tests?.passed === 24, `${green.tests?.passed}/${green.tests?.total}`)
  check('sec.scan clean after bytea', !ws.secScan().some((f) => f.level === 'RISK'))
  check('same tree → identical e2e output', green.stdout === (await ws.run('pnpm e2e')).stdout)

  // Merge gating.
  const c = ws.pr.comment('sentry', 'cred_id must be bytea', true)
  check('merge blocked by an unresolved blocking comment', ws.pr.merge().ok === false)
  ws.pr.resolve(c.id)
  ws.pr.review('sentry', 'approve', 'lgtm')
  check('merge succeeds once resolved and approved', ws.pr.merge().ok === true)
  check('bad migration SQL is rejected', ws.migrations.apply('0044_bad', 'DROP everything').ok === false)

  // Push shas are a pure function of tree + message + parent.
  const shas = [createWorkspace(), createWorkspace()].map((w) => {
    buildFeature(w, '>', 'BYTEA')
    const a = w.push('feat(auth): passkey register + verify').sha
    w.patch('services/auth/webauthn/verify.ts', [{ find: 'return true', replace: 'return stored.signCount >= 0' }])
    return `${a}/${w.push('fix: tidy').sha}`
  })
  check('push shas are stable across identical runs', shas[0] === shas[1], shas[0])
  check('shas are 7 hex chars', /^[0-9a-f]{7}\/[0-9a-f]{7}$/.test(shas[0]))

  // Registry smoke: every catalogue entry has a handler, strict definitions, and errors are caught.
  const tools = createToolRegistry()
  const fakeRun = { snapshot: () => ({ run: { status: 'live', approvalGate: true }, pipeline: { phase: 'build' }, agents: [] }) } as unknown as RunStore
  const ctx: ToolContext = { agent: 'forge', workspace: ws, run: fakeRun, signal: new AbortController().signal }
  const defs = tools.definitionsFor('atlas')
  check('atlas gets only orchestration tools, strict', defs.length === 6 && defs.every((d) => d.strict === true && d.name.startsWith('run_')))
  check('forge gets shell_run and repo_push', tools.forAgent('forge').some((s) => s.apiName === 'repo_push') && !!tools.byApiName('shell_run'))
  const workerDefs = tools.definitionsFor('forge')
  check('strict definitions carry no range/format keywords', !/"(?:minimum|maximum|multipleOf|minLength|maxLength|pattern|format)"\s*:/.test(JSON.stringify(workerDefs)))
  const pctDef = ((workerDefs.find((d) => d.name === 'agent_progress')?.input_schema.properties ?? {}) as Record<string, { type?: string; description?: string } | undefined>).pct
  check('agent_progress pct keeps its type and states the range', pctDef?.type === 'integer' && /Range 0–100/.test(pctDef.description ?? ''), pctDef?.description)
  check('catalogue schema is left untouched', 'minimum' in (tools.byApiName('agent_progress')!.inputSchema.properties.pct as object))
  const over = await tools.byApiName('agent_progress')!.execute({ pct: 150, subtask: 'x', eta: 'x', io: [] }, ctx)
  check('agent_progress clamps pct to 0..100', over.effect?.kind === 'progress' && over.effect.pct === 100)
  const missing = await tools.byApiName('repo_read')!.execute({}, ctx)
  check('missing required input → ok:false', missing.ok === false && missing.result.startsWith('error:'), missing.result)
  const e2e = await tools.byApiName('shell_run')!.execute({ command: 'pnpm e2e' }, ctx)
  check('shell_run e2e returns a tests effect', e2e.effect?.kind === 'tests' && e2e.effect.passed === 24)
  const status = await tools.byApiName('run_read_status')!.execute({}, { ...ctx, agent: 'atlas' })
  check('run_read_status carries the last e2e summary', status.ok && JSON.parse(status.result).lastE2e?.total === 24)
  check('summarize matches the card format', tools.byApiName('pr_comment')!.summarize({ body: 'cred_id must be bytea, not text', blocking: true }) === 'blocking · cred_id must be bytea, n…')

  if (failed) {
    console.log(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
