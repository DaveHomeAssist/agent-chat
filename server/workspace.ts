/**
 * In-memory `helios/api` repository with a deterministic simulated toolchain.
 *
 * Determinism contract: the same working tree always yields byte-identical
 * command output, the same diff stat and the same push sha. Nothing here reads
 * the clock or randomness; durations are derived from file and case counts.
 *
 * Toolchain rules (`run(command)`)
 * --------------------------------
 * Only ALLOWED_COMMANDS run (`pnpm e2e` may take `--grep <pattern>`); anything
 * else exits 127.
 *
 * pnpm typecheck  Fails (exit 1) when any .ts file has unbalanced {} or () —
 *                 strings and comments are stripped first — or contains the
 *                 marker TODO_COMPILE_ERROR. Warns (exit 0) for every imported
 *                 identifier that is never mentioned again in its file.
 *                 Duration = fileCount × 1.9s.
 * pnpm lint       The same unused-import heuristic as eslint warnings; exit 0.
 * pnpm test       Vitest-style unit run; passes iff typecheck passes.
 * pnpm e2e        The 24-case suite in seed/e2e.ts, run against the LAST
 *                 PUSHED tree (the seed before any push) — never the working
 *                 tree, so Probe cannot report green on edits Forge has not
 *                 pushed. stdout opens with "e2e on <sha>"; when the working
 *                 tree differs, stderr carries one line
 *                 "note: N unpushed change(s) not included". Per case, the
 *                 first rule that matches decides:
 *                   register.* fail  if services/auth/webauthn/register.ts is missing
 *                   login.*    fail  if services/auth/webauthn/verify.ts is missing
 *                   register.* fail  "relation credentials does not exist" if no
 *                                    migration creates a `credentials` table
 *                   replay guard     verify.ts comparing the sign counter with >=
 *                                    (signCount >= | sign_count >= | counter >=)
 *                                    fails register.reregister (400 replay) and
 *                                    login.windowsHello (cred_id mismatch)
 *                   cred_id column   the latest migration declaring cred_id as
 *                                    text/varchar fails login.windowsHello
 *                                    (cred_id mismatch); bytea passes
 *                   everything else passes.
 *                 `--grep <text>` is a case-insensitive substring match on
 *                 "passkey › <name>" — never a RegExp, since the pattern is
 *                 model-supplied text. Every run stores a trace artifact
 *                 (trace-latest.zip plus a numbered copy).
 *                 Duration = cases × 4.9s + 0.8s.
 *
 * push() hashes the tree, the message and the parent sha into a 7-hex sha.
 * diff() is the working tree against the last push (the seed before any push),
 * formatted like the design's tool card: path padded to a column, unicode
 * minus for deletions, files in the order they were first touched.
 */

import { createHash } from 'node:crypto'
import type { AgentId } from '../shared/protocol.js'
import { ALLOWED_COMMANDS } from './contracts.js'
import type { CommandResult, DiffStat, PrComment, PrState, SecFinding, Workspace } from './contracts.js'
import { E2E_CASES, E2E_SUITE_FILE, type E2eCase } from './seed/e2e.js'
import { SEED_BRANCH, SEED_FILES, SEED_REPO } from './seed/repo.js'

export type TestSummary = NonNullable<CommandResult['tests']>

/** The concrete workspace also remembers the last e2e result for `run.read_status`. */
export interface WorkspaceWithHistory extends Workspace {
  lastTests(): TestSummary | null
}

const PR_NUMBER = 482
const PR_TITLE = 'feat(auth): passkey sign-in behind auth.passkeys'
const REGISTER_PATH = 'services/auth/webauthn/register.ts'
const VERIFY_PATH = 'services/auth/webauthn/verify.ts'
const MIGRATIONS_DIR = 'db/migrations/'
const DOCS_DIR = 'docs/'
/** Column the diff-stat count starts at — matches the design's card. */
const DIFF_PATH_COLUMN = 34
/** First numbered trace, so the history reads like the design's "trace-0041.zip". */
const FIRST_TRACE_NUMBER = 41

type Tree = Map<string, string>

interface E2eFailure {
  name: string
  /** Short reason as shown in the log, e.g. "400 replay". */
  detail: string
  /** Longer trace explanation. */
  trace: string[]
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function normalizePath(path: string): string {
  const clean = path.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  if (!clean || clean.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error(`invalid path: ${JSON.stringify(path)}`)
  }
  return clean
}

function sha7(...parts: string[]): string {
  const h = createHash('sha1')
  for (const p of parts) h.update(p).update('\0')
  return h.digest('hex').slice(0, 7)
}

function hashTree(tree: Tree): string {
  const paths = [...tree.keys()].sort()
  return sha7(...paths.flatMap((p) => [p, tree.get(p) ?? '']))
}

function lines(text: string): string[] {
  if (text === '') return []
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

/** Additions/deletions between two line lists via LCS. Files here are tiny. */
function lineDiff(a: string[], b: string[]): { additions: number; deletions: number } {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const common = dp[0][0]
  return { additions: m - common, deletions: n - common }
}

function formatStat(additions: number, deletions: number): string {
  const parts: string[] = []
  if (additions > 0) parts.push(`+${additions}`)
  if (deletions > 0) parts.push(`−${deletions}`)
  return parts.join(' ') || '±0'
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** Strip comments and string/template literals so brace counting ignores them. */
function stripLiterals(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j++
        if (ch !== '`' && src[j] === '\n') break
        j++
      }
      const stop = Math.min(j + 1, src.length)
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    out += ch
    i++
  }
  return out
}

interface BalanceProblem {
  line: number
  message: string
}

function findUnbalanced(src: string): BalanceProblem | null {
  const stripped = stripLiterals(src)
  const stack: { ch: string; line: number }[] = []
  const pairs: Record<string, string> = { '}': '{', ')': '(' }
  let line = 1
  for (const ch of stripped) {
    if (ch === '\n') line++
    else if (ch === '{' || ch === '(') stack.push({ ch, line })
    else if (ch === '}' || ch === ')') {
      const open = stack.pop()
      if (!open || open.ch !== pairs[ch]) return { line, message: `TS1128: Declaration or statement expected. Unexpected '${ch}'.` }
    }
  }
  const open = stack.pop()
  if (open) return { line: open.line, message: `TS1005: '${open.ch === '{' ? '}' : ')'}' expected.` }
  return null
}

interface UnusedImport {
  line: number
  col: number
  name: string
}

const IMPORT_RE = /^import\s+(?:type\s+)?([^'"]+?)\s+from\s+['"][^'"]+['"]/

function importedNames(clause: string): string[] {
  const names: string[] = []
  const braces = /\{([^}]*)\}/.exec(clause)
  const outside = clause.replace(/\{[^}]*\}/, '')
  for (const part of outside.split(',')) {
    const m = /(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)$/.exec(part.trim())
    if (m) names.push(m[1])
  }
  if (braces) {
    for (const part of braces[1].split(',')) {
      const m = /(?:type\s+)?(?:[\w$]+\s+as\s+)?([A-Za-z_$][\w$]*)$/.exec(part.trim())
      if (m) names.push(m[1])
    }
  }
  return names
}

function findUnusedImports(src: string): UnusedImport[] {
  const found: UnusedImport[] = []
  const srcLines = lines(src)
  srcLines.forEach((text, idx) => {
    const m = IMPORT_RE.exec(text)
    if (!m) return
    const rest = srcLines.filter((_, j) => j !== idx).join('\n')
    for (const name of importedNames(m[1])) {
      const used = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest)
      if (!used) found.push({ line: idx + 1, col: text.indexOf(name) + 1, name })
    }
  })
  return found
}

function truncateLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export function createWorkspace(): WorkspaceWithHistory {
  let tree: Tree = new Map(Object.entries(SEED_FILES))
  let base: Tree = new Map(tree)
  let touched: string[] = []
  let commits: string[] = []
  let pr: PrState = freshPr()
  let artifacts = new Map<string, string>()
  let traceCounter = FIRST_TRACE_NUMBER
  let lastTests: TestSummary | null = null
  let commentSeq = 0

  function freshPr(): PrState {
    return { number: PR_NUMBER, title: PR_TITLE, branch: SEED_BRANCH, comments: [], review: 'none', merged: false, commits: [] }
  }

  function touch(path: string): void {
    if (!touched.includes(path)) touched.push(path)
  }

  function tsFiles(): string[] {
    return [...tree.keys()].filter((p) => p.endsWith('.ts')).sort()
  }

  function migrationPaths(t: Tree = tree): string[] {
    return [...t.keys()].filter((p) => p.startsWith(MIGRATIONS_DIR) && p.endsWith('.sql')).sort()
  }

  // ---- files ---------------------------------------------------------------

  function read(path: string): string | null {
    return tree.get(normalizePath(path)) ?? null
  }

  function write(path: string, content: string): { created: boolean } {
    const p = normalizePath(path)
    const created = !tree.has(p)
    tree.set(p, content)
    touch(p)
    return { created }
  }

  function patch(path: string, edits: { find: string; replace: string }[]): { applied: number; missing: string[] } {
    const p = normalizePath(path)
    const current = tree.get(p)
    if (current === undefined) throw new Error(`no such file: ${p}`)
    let next = current
    let applied = 0
    const missing: string[] = []
    for (const edit of edits) {
      const at = next.indexOf(edit.find)
      if (at === -1) {
        missing.push(edit.find)
        continue
      }
      next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length)
      applied++
    }
    if (next !== current) {
      tree.set(p, next)
      touch(p)
    }
    return { applied, missing }
  }

  function remove(path: string): boolean {
    const p = normalizePath(path)
    if (!tree.has(p)) return false
    tree.delete(p)
    touch(p)
    return true
  }

  // ---- diff / push ---------------------------------------------------------

  function diff(): DiffStat {
    const paths = [...new Set([...touched, ...tree.keys(), ...base.keys()])]
    const stat: DiffStat = { files: 0, additions: 0, deletions: 0, lines: [] }
    for (const p of paths) {
      const before = base.get(p)
      const after = tree.get(p)
      if (before === after) continue
      const d = lineDiff(lines(before ?? ''), lines(after ?? ''))
      if (d.additions === 0 && d.deletions === 0) continue
      stat.files++
      stat.additions += d.additions
      stat.deletions += d.deletions
      stat.lines.push(`${p.padEnd(DIFF_PATH_COLUMN)}  ${formatStat(d.additions, d.deletions)}`)
    }
    return stat
  }

  function push(message: string): { sha: string; stat: DiffStat } {
    const stat = diff()
    const sha = sha7(hashTree(tree), message, commits[commits.length - 1] ?? 'root')
    commits.push(sha)
    pr.commits = [...commits]
    base = new Map(tree)
    touched = []
    return { sha, stat }
  }

  function rollback(): { sha: string | null } {
    tree = new Map(base)
    touched = []
    return { sha: commits[commits.length - 1] ?? null }
  }

  // ---- toolchain -----------------------------------------------------------

  function typecheckReport(): { errors: string[]; warnings: string[] } {
    const errors: string[] = []
    const warnings: string[] = []
    for (const p of tsFiles()) {
      const src = tree.get(p) ?? ''
      const marker = src.indexOf('TODO_COMPILE_ERROR')
      if (marker !== -1) {
        const line = src.slice(0, marker).split('\n').length
        errors.push(`${p}(${line},1): error TS2304: Cannot find name 'TODO_COMPILE_ERROR'.`)
      }
      const bal = findUnbalanced(src)
      if (bal) errors.push(`${p}(${bal.line},1): error ${bal.message}`)
      for (const u of findUnusedImports(src)) {
        warnings.push(`${p}(${u.line},${u.col}): warning TS6133: '${u.name}' is declared but its value is never read.`)
      }
    }
    return { errors, warnings }
  }

  function runTypecheck(): CommandResult {
    const { errors, warnings } = typecheckReport()
    const durationMs = tree.size * 1900
    const body = [...errors, ...warnings]
    const summary = `Found ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}. Checked ${tsFiles().length} files in ${seconds(durationMs)}.`
    return {
      exitCode: errors.length ? 1 : 0,
      stdout: ['> @helios/api@3.14.0 typecheck', '> tsc --noEmit', '', ...(body.length ? [...body, ''] : []), summary].join('\n'),
      stderr: '',
      durationMs,
    }
  }

  function runLint(): CommandResult {
    const durationMs = tree.size * 400 + 600
    const out: string[] = ['> @helios/api@3.14.0 lint', '> eslint . --ext .ts', '']
    let count = 0
    for (const p of tsFiles()) {
      const unused = findUnusedImports(tree.get(p) ?? '')
      if (!unused.length) continue
      out.push(p)
      for (const u of unused) {
        count++
        out.push(`  ${u.line}:${u.col}  warning  '${u.name}' is defined but never used  @typescript-eslint/no-unused-vars`)
      }
      out.push('')
    }
    out.push(count ? `✖ ${count} problem${count === 1 ? '' : 's'} (0 errors, ${count} warning${count === 1 ? '' : 's'})` : '✔ No problems found')
    out.push(`Done in ${seconds(durationMs)}`)
    return { exitCode: 0, stdout: out.join('\n'), stderr: '', durationMs }
  }

  function runUnitTests(): CommandResult {
    const { errors } = typecheckReport()
    const units = tsFiles().filter((p) => p.startsWith('services/') && !p.endsWith('.spec.ts'))
    const durationMs = units.length * 900 + 1200
    const out: string[] = ['> @helios/api@3.14.0 test', '> vitest run', '']
    if (errors.length) {
      out.push(...units.map((p) => ` ❯ ${p.replace(/\.ts$/, '.test.ts')} (0 tests)`), '')
      out.push(...errors.map((e) => `   ${e}`), '')
      out.push(` Test Files  ${units.length} failed (${units.length})`, `      Tests  no tests`, `   Duration  ${seconds(durationMs)}`)
      return { exitCode: 1, stdout: out.join('\n'), stderr: 'Error: build failed — fix typecheck errors first', durationMs }
    }
    const perFile = 3
    for (const p of units) {
      const ms = 80 + (parseInt(sha7(p), 16) % 240)
      out.push(` ✓ ${p.replace(/\.ts$/, '.test.ts')} (${perFile} tests) ${ms}ms`)
    }
    out.push('')
    out.push(` Test Files  ${units.length} passed (${units.length})`)
    out.push(`      Tests  ${units.length * perFile} passed (${units.length * perFile})`)
    out.push(`   Duration  ${seconds(durationMs)}`)
    return {
      exitCode: 0,
      stdout: out.join('\n'),
      stderr: '',
      durationMs,
      tests: { passed: units.length * perFile, failed: 0, total: units.length * perFile, failures: [] },
    }
  }

  /** Where the credentials migration stands in tree `t`: absent, or its latest cred_id column type. */
  function credentialsMigration(t: Tree = tree): { present: boolean; credIdType: 'text' | 'bytea' | 'unknown'; path: string | null } {
    let present = false
    let credIdType: 'text' | 'bytea' | 'unknown' = 'unknown'
    let path: string | null = null
    for (const p of migrationPaths(t)) {
      const sql = t.get(p) ?? ''
      if (/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:\w+\.)?"?credentials\b/i.test(sql)) present = true
      for (const m of sql.matchAll(/\bcred_id\b[^,;\n]*?\b(text|varchar|character\s+varying|bytea)\b/gi)) {
        credIdType = m[1].toLowerCase() === 'bytea' ? 'bytea' : 'text'
        path = p
      }
    }
    return { present, credIdType, path }
  }

  function replayGuardOffByOne(t: Tree): boolean {
    const src = t.get(VERIFY_PATH)
    return !!src && /\b(?:signCount|sign_count|counter)\s*>=/.test(src)
  }

  /** Outcome of one e2e case against tree `t` (the last pushed tree). */
  function e2eFailure(tc: E2eCase, t: Tree): E2eFailure | null {
    const migration = credentialsMigration(t)
    const replay = replayGuardOffByOne(t)
    const textCredId = migration.credIdType === 'text'
    if (tc.group === 'register' && !t.has(REGISTER_PATH)) {
      return { name: tc.name, detail: '404 route not mounted', trace: [`POST /webauthn/register → 404`, `${REGISTER_PATH} does not exist`] }
    }
    if (tc.group === 'login' && !t.has(VERIFY_PATH)) {
      return { name: tc.name, detail: '404 route not mounted', trace: [`POST /webauthn/login → 404`, `${VERIFY_PATH} does not exist`] }
    }
    if (tc.group === 'register' && !migration.present) {
      return {
        name: tc.name,
        detail: 'relation "credentials" does not exist',
        trace: ['POST /webauthn/register → 500', 'PrismaClientKnownRequestError: relation "credentials" does not exist', 'no migration under db/migrations creates the credentials table'],
      }
    }
    if (tc.name === 'register.reregister' && replay) {
      return {
        name: tc.name,
        detail: '400 replay',
        trace: [
          'second registration of the same authenticator (excludeCredentials empty, counter reset to 0)',
          'expected 201, received 400 {"error":"replay"}',
          `${VERIFY_PATH}: sign counter guard rejects newCount == storedCount — comparison uses >= where the spec wants >`,
        ],
      }
    }
    if (tc.name === 'login.windowsHello' && (replay || textCredId)) {
      const trace = ['assertion from the Windows Hello virtual authenticator', 'expected 200, received 401 {"error":"cred_id mismatch"}']
      if (replay) trace.push(`${VERIFY_PATH}: Windows Hello reports signCount 0 on every assertion; guard with >= treats 0 vs 0 as a replay and the lookup falls through`)
      if (textCredId) trace.push(`${migration.path}: cred_id is ${migration.credIdType} — base64 stored at registration, base64url on lookup; store raw bytes (bytea)`)
      return { name: tc.name, detail: 'cred_id mismatch', trace }
    }
    return null
  }

  function caseDuration(tc: E2eCase): string {
    return `${(2 + (parseInt(sha7(tc.name), 16) % 30) / 10).toFixed(1)}s`
  }

  function runE2e(grep: string | null): CommandResult {
    let selected: E2eCase[] = [...E2E_CASES]
    if (grep) {
      // Model-supplied text is never compiled as a RegExp: a pathological
      // pattern would block the event loop in this synchronous filter.
      const needle = grep.toLowerCase()
      selected = selected.filter((tc) => `passkey › ${tc.name}`.toLowerCase().includes(needle))
    }
    // The suite runs against the last push (the seed before any), not the
    // working tree — only what is on the branch is under test.
    const pushed = base
    const sha = commits[commits.length - 1]
    const unpushed = diff().files
    const durationMs = selected.length * 4900 + 800
    const failures: E2eFailure[] = []
    const out: string[] = [
      sha ? `e2e on ${sha}` : `e2e on seed (nothing pushed to ${SEED_BRANCH} yet)`,
      `Running ${selected.length} test${selected.length === 1 ? '' : 's'} using 4 workers`,
      ...(grep ? [`grep: substring match, case-insensitive · ${JSON.stringify(grep)}`] : []),
      '',
    ]
    selected.forEach((tc, i) => {
      const failure = e2eFailure(tc, pushed)
      if (failure) failures.push(failure)
      const line = 12 + E2E_CASES.indexOf(tc) * 7
      out.push(`  ${failure ? '✘' : '✓'} ${String(i + 1).padStart(3)} [${tc.browser}] › ${E2E_SUITE_FILE}:${line}:3 › passkey › ${tc.name} (${caseDuration(tc)})`)
    })
    if (failures.length) {
      out.push('')
      failures.forEach((f, i) => {
        out.push(`  ${i + 1}) passkey › ${f.name} ─────────────────────────────`, '')
        out.push(...f.trace.map((t) => `     ${t}`), '')
      })
    }
    out.push('')
    if (failures.length) {
      out.push(`  ${failures.length} failed`)
      out.push(...failures.map((f) => `    ${f.name} → ${f.detail}`))
    }
    out.push(`  ${selected.length - failures.length} passed (${seconds(durationMs)})`)
    if (grep && !selected.length) out.push(`  no tests matched --grep ${JSON.stringify(grep)}`)
    const tests: TestSummary = {
      passed: selected.length - failures.length,
      failed: failures.length,
      total: selected.length,
      failures: failures.map((f) => `${f.name} → ${f.detail}`),
    }
    lastTests = tests
    storeTrace(tests, failures)
    const stderr = unpushed ? `note: ${unpushed} unpushed change(s) not included` : ''
    return { exitCode: failures.length ? 1 : 0, stdout: out.join('\n'), stderr, durationMs, tests }
  }

  function storeTrace(tests: TestSummary, failures: E2eFailure[]): void {
    const body: string[] = [
      `trace-latest.zip · simulated playwright trace · ${E2E_SUITE_FILE}`,
      `${tests.total} cases · ${tests.passed} passed · ${tests.failed} failed`,
      '',
    ]
    if (!failures.length) body.push('no failures — nothing to bisect')
    for (const f of failures) {
      body.push(`--- ${f.name} → ${f.detail}`)
      body.push(...f.trace.map((t) => `    ${t}`))
      body.push('')
    }
    const text = body.join('\n').trimEnd() + '\n'
    artifacts.set('trace-latest.zip', text)
    artifacts.set(`trace-${String(traceCounter++).padStart(4, '0')}.zip`, text)
  }

  function parseCommand(command: string): { name: (typeof ALLOWED_COMMANDS)[number]; grep: string | null } | null {
    const norm = command.trim().replace(/\s+/g, ' ')
    for (const allowed of ALLOWED_COMMANDS) {
      if (norm === allowed) return { name: allowed, grep: null }
      if (allowed === 'pnpm e2e' && norm.startsWith(`${allowed} --grep `)) {
        const raw = norm.slice(allowed.length + ' --grep '.length).trim()
        const grep = raw.replace(/^(['"])(.*)\1$/, '$2')
        return grep ? { name: allowed, grep } : null
      }
    }
    return null
  }

  async function run(command: string): Promise<CommandResult> {
    const parsed = parseCommand(command)
    if (!parsed) {
      return { exitCode: 127, stdout: '', stderr: `sh: command not allowed: ${command.trim()}\nallowed: ${ALLOWED_COMMANDS.join(', ')} (pnpm e2e accepts --grep <pattern>)`, durationMs: 0 }
    }
    switch (parsed.name) {
      case 'pnpm typecheck':
        return runTypecheck()
      case 'pnpm lint':
        return runLint()
      case 'pnpm test':
        return runUnitTests()
      case 'pnpm e2e':
        return runE2e(parsed.grep)
    }
  }

  // ---- docs / migrations ---------------------------------------------------

  function docPath(name: string): string {
    const p = normalizePath(name)
    return p.startsWith(DOCS_DIR) ? p : DOCS_DIR + p
  }

  const docs: Workspace['docs'] = {
    write: (name, content) => write(docPath(name), content),
    read: (name) => read(docPath(name)),
    list: () => [...tree.keys()].filter((p) => p.startsWith(DOCS_DIR)).map((p) => p.slice(DOCS_DIR.length)).sort(),
  }

  function migrationName(name: string): string {
    const clean = normalizePath(name).replace(/^db\/migrations\//, '').replace(/\.sql$/, '')
    if (!/^\d{4}_[a-z0-9_]+$/i.test(clean)) throw new Error(`migration name must look like 0043_credentials, got ${JSON.stringify(name)}`)
    return clean
  }

  const migrations: Workspace['migrations'] = {
    apply(name, sql) {
      let clean: string
      try {
        clean = migrationName(name)
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
      const body = sql.trim()
      if (!/\b(create|alter)\s+table\b/i.test(body)) return { ok: false, message: 'rejected: migration must contain CREATE TABLE or ALTER TABLE' }
      const opens = (body.match(/\(/g) ?? []).length
      const closes = (body.match(/\)/g) ?? []).length
      if (opens !== closes) return { ok: false, message: `rejected: unbalanced parentheses (${opens} open, ${closes} close)` }
      if (!body.endsWith(';')) return { ok: false, message: 'rejected: last statement is not terminated with ;' }
      const statements = body.split(';').filter((s) => s.trim()).length
      const path = `${MIGRATIONS_DIR}${clean}.sql`
      const { created } = write(path, body + '\n')
      return { ok: true, message: `${created ? 'applied' : 're-applied'} ${clean} to helios_dev · ${statements} statement${statements === 1 ? '' : 's'} · ${path}` }
    },
    list: () => migrationPaths().map((p) => p.slice(MIGRATIONS_DIR.length).replace(/\.sql$/, '')),
  }

  // ---- PR ------------------------------------------------------------------

  const prApi: Workspace['pr'] = {
    state: () => ({ ...pr, comments: pr.comments.map((c) => ({ ...c })), commits: [...pr.commits] }),
    comment(author: AgentId, body: string, blocking: boolean): PrComment {
      const c: PrComment = { id: `c${++commentSeq}`, author, body, blocking, resolved: false }
      pr.comments.push(c)
      return c
    },
    resolve(id: string): boolean {
      const c = pr.comments.find((x) => x.id === id)
      if (!c || c.resolved) return false
      c.resolved = true
      return true
    },
    review(_author, verdict) {
      pr.review = verdict === 'approve' ? 'approved' : 'changes_requested'
    },
    merge() {
      if (pr.merged) return { ok: false, reason: `PR #${pr.number} is already merged` }
      if (!pr.commits.length) return { ok: false, reason: `nothing to merge — no commits pushed to ${pr.branch}` }
      const open = pr.comments.filter((c) => c.blocking && !c.resolved)
      if (open.length) {
        return { ok: false, reason: `blocking comment${open.length === 1 ? '' : 's'} unresolved: ${open.map((c) => `${c.id} (${c.author}) ${truncateLine(c.body, 60)}`).join('; ')}` }
      }
      if (pr.review === 'changes_requested') return { ok: false, reason: 'review verdict is changes_requested' }
      pr.merged = true
      return { ok: true }
    },
  }

  // ---- scans ---------------------------------------------------------------

  function secScan(): SecFinding[] {
    const findings: SecFinding[] = []
    const migration = credentialsMigration()
    if (migration.credIdType === 'text' && migration.path) {
      findings.push({ level: 'RISK', path: migration.path, msg: 'cred_id stored as text — base64 round-trip' })
    }
    for (const p of tsFiles()) {
      const src = tree.get(p) ?? ''
      for (const m of src.matchAll(/console\.(?:log|info|debug)\(([^)]*)\)/g)) {
        const leaked = /\b(\w*(?:secret|token|password)\w*)\b/i.exec(m[1])
        if (leaked) findings.push({ level: 'WARN', path: p, msg: `console.log of ${leaked[1]} — secrets must not reach logs` })
      }
    }
    findings.push({ level: 'INFO', path: 'package.json', msg: 'deps: 0 vulnerabilities' })
    return findings
  }

  function artifact(name: string): string | null {
    return artifacts.get(name.trim()) ?? null
  }

  // ---- misc ----------------------------------------------------------------

  function describe(): string {
    const paths = [...tree.keys()].sort()
    const width = Math.max(...paths.map((p) => p.length)) + 2
    const rows = paths.map((p) => `  ${p.padEnd(width)}${Buffer.byteLength(tree.get(p) ?? '')}B`)
    return [`${SEED_REPO} @ ${SEED_BRANCH} · ${paths.length} files · ${commits.length} commit${commits.length === 1 ? '' : 's'} on branch`, ...rows].join('\n')
  }

  function reset(): void {
    tree = new Map(Object.entries(SEED_FILES))
    base = new Map(tree)
    touched = []
    commits = []
    pr = freshPr()
    artifacts = new Map()
    traceCounter = FIRST_TRACE_NUMBER
    lastTests = null
    commentSeq = 0
  }

  return {
    repo: SEED_REPO,
    branch: SEED_BRANCH,
    list: () => [...tree.keys()].sort(),
    read,
    write,
    patch,
    remove,
    diff,
    push,
    rollback,
    run,
    docs,
    migrations,
    pr: prApi,
    secScan,
    artifact,
    describe,
    reset,
    lastTests: () => (lastTests ? { ...lastTests, failures: [...lastTests.failures] } : null),
  }
}
