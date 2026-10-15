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
 * pnpm test       Vitest-style unit run over the *.test.ts files that exist in
 *                 the working tree (e2e/ excluded), counting their test()/it()
 *                 calls; passes iff typecheck passes. No test files → 0 tests,
 *                 exit 0 (passWithNoTests), never a file that is not there.
 * pnpm e2e        The 24-case suite in seed/e2e.ts PLUS every test()/it() the
 *                 branch adds or changes in any e2e/ *.spec.ts file, run against the LAST
 *                 PUSHED tree (the seed before any push) — never the working
 *                 tree, so Probe cannot report green on edits Forge has not
 *                 pushed. stdout opens with "e2e on <sha>"; when the working
 *                 tree differs, stderr carries one line
 *                 "note: N unpushed change(s) not included". Collected cases
 *                 keep their own file, line and describe title, so --grep on a
 *                 name the agents wrote selects it (0/0 only when nothing on the
 *                 branch matches); a collected passkey case is judged by the
 *                 same step rules as the canonical case of its group, any other
 *                 collected case passes. Per-case durations are seeded by the
 *                 sha under test, so two commits never print identical logs.
 *                 The suite judges
 *                 what was pushed, not a fixed layout: a passkey route file is
 *                 any non-test .ts file whose path or text mentions WebAuthn,
 *                 passkeys or FIDO and that either is named for the step
 *                 (register/attestation; login/verify/assertion/authenticate)
 *                 or contains a route path literal for it (for example
 *                 '/auth/passkey/register' or '/webauthn/login'). Per case,
 *                 the first rule that matches decides:
 *                   register.* fail  if no file mounts the passkey register step
 *                   login.*    fail  if no file mounts the passkey login step
 *                   register.* fail  "relation ... does not exist" if no migration
 *                                    creates a credentials table (any table whose
 *                                    name contains credential, passkey or webauthn)
 *                   replay guard     any passkey file comparing the sign counter
 *                                    with >= (signCount >= | sign_count >= |
 *                                    counter >=) fails register.reregister
 *                                    (400 replay) and login.windowsHello
 *                                    (cred_id mismatch)
 *                   cred_id column   the latest migration declaring the credential
 *                                    id column (cred_id / credential_id) as
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

/** `suite` tallies the canonical 24 cases alone; `passed`/`failed`/`total` include the branch's own collected specs. */
export type TestSummary = NonNullable<CommandResult['tests']> & { revision: number; sha: string | null; fullSuite: boolean; suite: { passed: number; total: number } }

/** The concrete workspace also remembers the last e2e result for `run.read_status`. */
export interface WorkspaceWithHistory extends Workspace {
  lastTests(): TestSummary | null
}

const PR_NUMBER = 482
const PR_TITLE = 'feat(auth): passkey sign-in behind auth.passkeys'
/** The layout the seed ADR template suggests; any other layout that mounts the steps also passes. */
const REGISTER_PATH = 'services/auth/webauthn/register.ts'
const VERIFY_PATH = 'services/auth/webauthn/verify.ts'
const MIGRATIONS_DIR = 'db/migrations/'
/** A file is passkey code when its path or text mentions the feature. */
const PASSKEY_WORDS = /webauthn|passkey|fido|navigator\.credentials/i
const REGISTER_WORDS = /regist|attestation|enrol/i
const LOGIN_WORDS = /login|sign-?in|verify|assert|authenticat/i
/** Route path literals such as '/auth/passkey/register' or `/webauthn/login/options`. */
const ROUTE_LITERAL = /['"`](\/[A-Za-z0-9_./:-]*)['"`]/g
const TEST_FILE = /(^|\/)(e2e|tests?|__tests__)\/|\.(spec|test)\.ts$/i
/** The credentials table: `credentials`, `webauthn_credentials`, `passkeys`, ... */
const CREDENTIALS_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:\w+\.)?"?(\w*(?:credential|passkey|webauthn)\w*)\b/i
const CRED_ID_COLUMN = /\b(cred_id|credential_id|credentialid)\b[^,;\n]*?\b(text|varchar|character\s+varying|bytea)\b/gi
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

/** A test()/it() the branch added to e2e/, reported beside the canonical suite. */
interface CollectedCase {
  /** `describe › title` when nested, else the title. */
  name: string
  file: string
  line: number
  /** Playwright project the file's config declares, else chromium. */
  project: string
  /** Passkey cases are judged by the step rules; null means an unrelated case that passes. */
  group: E2eCase['group'] | null
}

const SPEC_FILE = /(^|\/)e2e\/.*\.(spec|test)\.ts$/
/** test('title'…), it('title'…), test.describe('title'…) and their .only/.skip/.serial variants. */
const SPEC_CALL = /\b(test|it)(?:\.(?:describe(?:\.(?:serial|parallel|only|skip))?|only|skip|fixme))?\s*\(\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g
const PROJECT_NAME = /\bname\s*:\s*(['"`])([^'"`]+)\1/g

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
  let revision = 0

  function freshPr(): PrState {
    return { number: PR_NUMBER, title: PR_TITLE, branch: SEED_BRANCH, comments: [], review: 'none', reviewRevision: null, merged: false, commits: [] }
  }

  function invalidateEvidence(): void {
    revision++
    lastTests = null
    pr.review = 'none'
    pr.reviewRevision = null
  }

  function touch(path: string): void {
    invalidateEvidence()
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
    if (tree.get(p) !== content) {
      tree.set(p, content)
      touch(p)
    }
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
    invalidateEvidence()
    const stat = diff()
    const sha = sha7(hashTree(tree), message, commits[commits.length - 1] ?? 'root')
    commits.push(sha)
    pr.commits = [...commits]
    base = new Map(tree)
    touched = []
    return { sha, stat }
  }

  function rollback(): { sha: string | null } {
    invalidateEvidence()
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

  /** Count the test()/it() calls in a source file (describe blocks are containers, not tests). */
  function countTests(src: string): number {
    let n = 0
    for (const m of src.matchAll(SPEC_CALL)) if (!/describe/.test(m[0])) n++
    return n
  }

  /** Playwright project names declared in e2e/playwright.config.ts of tree `t`, else chromium. */
  function specProjects(t: Tree): string[] {
    const cfg = t.get('e2e/playwright.config.ts') ?? ''
    const names = [...cfg.matchAll(PROJECT_NAME)].map((m) => m[2]).filter((n) => !/^(@|\.)/.test(n))
    return names.length ? [...new Set(names)] : ['chromium']
  }

  /**
   * The test()/it() cases the branch adds to e2e/: every spec file in tree `t`
   * that the seed does not already carry byte-identical (the seed's own
   * login.spec.ts is part of the canonical suite). Describe titles prefix the
   * name, as Playwright prints them, so --grep on either part selects the case.
   */
  function collectSpecs(t: Tree): CollectedCase[] {
    const cases: CollectedCase[] = []
    const projects = specProjects(t)
    for (const file of [...t.keys()].filter((p) => SPEC_FILE.test(p) && SEED_FILES[p] !== t.get(p)).sort()) {
      const src = t.get(file) ?? ''
      let describe: string | null = null
      let i = 0
      for (const m of src.matchAll(SPEC_CALL)) {
        const title = m[3].replace(/\\(.)/g, '$1')
        if (/describe/.test(m[0])) {
          describe = title
          continue
        }
        const name = describe ? `${describe} › ${title}` : title
        const line = src.slice(0, m.index ?? 0).split('\n').length
        // A case is a passkey case when its own title says so, or when it names a step inside a passkey spec
        // file; an unrelated title (healthz) in a passkey file is not judged by the passkey rules.
        const nameStep = stepOf(name)
        const group: CollectedCase['group'] = nameStep && (PASSKEY_WORDS.test(name) || PASSKEY_WORDS.test(file))
          ? nameStep
          : PASSKEY_WORDS.test(name) ? (stepOf(file) ?? 'login') : null
        cases.push({ name, file, line, project: projects[i++ % projects.length], group })
      }
    }
    return cases
  }

  function runUnitTests(): CommandResult {
    const { errors } = typecheckReport()
    // Only files that exist run; vitest never reports a file the tree does not hold.
    const files = tsFiles().filter((p) => /\.test\.ts$/.test(p) && !/^e2e\//.test(p))
    const counts = files.map((p) => countTests(tree.get(p) ?? ''))
    const durationMs = files.length * 900 + 1200
    const out: string[] = ['> @helios/api@3.14.0 test', '> vitest run', '']
    if (errors.length) {
      out.push(...files.map((p) => ` ❯ ${p} (0 tests)`), '')
      out.push(...errors.map((e) => `   ${e}`), '')
      out.push(` Test Files  ${files.length} failed (${files.length})`, `      Tests  no tests`, `   Duration  ${seconds(durationMs)}`)
      return { exitCode: 1, stdout: out.join('\n'), stderr: 'Error: build failed — fix typecheck errors first', durationMs }
    }
    if (!files.length) {
      out.push('No test files found (passWithNoTests)', '', ` Test Files  0 passed (0)`, `      Tests  0 passed (0)`, `   Duration  ${seconds(durationMs)}`)
      return { exitCode: 0, stdout: out.join('\n'), stderr: '', durationMs, tests: { passed: 0, failed: 0, total: 0, failures: [] } }
    }
    const sha = commits.at(-1) ?? 'seed'
    files.forEach((p, i) => {
      const ms = 80 + (parseInt(sha7(p, sha), 16) % 240)
      out.push(` ✓ ${p} (${counts[i]} test${counts[i] === 1 ? '' : 's'}) ${ms}ms`)
    })
    const total = counts.reduce((a, b) => a + b, 0)
    out.push('')
    out.push(` Test Files  ${files.length} passed (${files.length})`)
    out.push(`      Tests  ${total} passed (${total})`)
    out.push(`   Duration  ${seconds(durationMs)}`)
    return { exitCode: 0, stdout: out.join('\n'), stderr: '', durationMs, tests: { passed: total, failed: 0, total, failures: [] } }
  }

  /** Where the credentials migration stands in tree `t`: absent, or its latest credential-id column type. */
  function credentialsMigration(t: Tree = tree): { present: boolean; table: string | null; credIdType: 'text' | 'bytea' | 'unknown'; credIdColumn: string; path: string | null } {
    let present = false
    let table: string | null = null
    let credIdType: 'text' | 'bytea' | 'unknown' = 'unknown'
    let credIdColumn = 'cred_id'
    let path: string | null = null
    for (const p of migrationPaths(t)) {
      const sql = t.get(p) ?? ''
      const created = CREDENTIALS_TABLE.exec(sql)
      if (created) {
        present = true
        table = created[1]
      }
      for (const m of sql.matchAll(CRED_ID_COLUMN)) {
        credIdColumn = m[1]
        credIdType = m[2].toLowerCase() === 'bytea' ? 'bytea' : 'text'
        path = p
      }
    }
    return { present, table, credIdType, credIdColumn, path }
  }

  /** Non-test .ts files whose path or text marks them as passkey code. */
  function passkeyFiles(t: Tree): string[] {
    return [...t.keys()]
      .filter((p) => p.endsWith('.ts') && !TEST_FILE.test(p) && (PASSKEY_WORDS.test(p) || PASSKEY_WORDS.test(t.get(p) ?? '')))
      .sort()
  }

  /** Which passkey step a route path or a file name serves; registration wins when both words appear. */
  function stepOf(text: string): 'register' | 'login' | null {
    if (REGISTER_WORDS.test(text)) return 'register'
    if (LOGIN_WORDS.test(text)) return 'login'
    return null
  }

  /**
   * The file mounting `step`, whatever the layout: the agents are told the goal
   * (passkey sign-in behind auth.passkeys), not a directory, so the suite must
   * judge what they pushed. A file counts when its base name names the step or
   * when it contains a passkey route literal for it. The seed's own
   * '/auth/login' and '/auth/otp/verify' routes carry no passkey word and never
   * match. The suggested layout (webauthn/register.ts, webauthn/verify.ts) wins
   * ties so its traces stay stable.
   */
  function routeFile(step: 'register' | 'login', t: Tree): string | null {
    const preferred = step === 'register' ? REGISTER_PATH : VERIFY_PATH
    const candidates = passkeyFiles(t).filter((p) => {
      const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.ts$/, '')
      if (stepOf(base) === step) return true
      const src = t.get(p) ?? ''
      for (const m of src.matchAll(ROUTE_LITERAL)) if (PASSKEY_WORDS.test(m[1]) && stepOf(m[1]) === step) return true
      return false
    })
    return candidates.includes(preferred) ? preferred : (candidates[0] ?? null)
  }

  /** The passkey file (if any) whose sign-counter guard uses >= instead of >. */
  function replayGuardOffByOne(t: Tree): string | null {
    for (const p of passkeyFiles(t)) if (/\b(?:signCount|sign_count|counter)\s*>=/.test(t.get(p) ?? '')) return p
    return null
  }

  /** Outcome of one e2e case against tree `t` (the last pushed tree). */
  function e2eFailure(tc: E2eCase, t: Tree): E2eFailure | null {
    const migration = credentialsMigration(t)
    const replay = replayGuardOffByOne(t)
    const textCredId = migration.credIdType === 'text'
    const registerFile = routeFile('register', t)
    const loginFile = routeFile('login', t)
    if (tc.group === 'register' && !registerFile) {
      return { name: tc.name, detail: '404 route not mounted', trace: [`POST /webauthn/register → 404`, `no pushed file mounts the passkey register step (for example ${REGISTER_PATH})`] }
    }
    if (tc.group === 'login' && !loginFile) {
      return { name: tc.name, detail: '404 route not mounted', trace: [`POST /webauthn/login → 404`, `no pushed file mounts the passkey login step (for example ${VERIFY_PATH})`] }
    }
    if (tc.group === 'register' && !migration.present) {
      return {
        name: tc.name,
        detail: 'relation "credentials" does not exist',
        trace: ['POST /webauthn/register → 500', 'PrismaClientKnownRequestError: relation "credentials" does not exist', 'no migration under db/migrations creates a credentials table'],
      }
    }
    if (tc.name === 'register.reregister' && replay) {
      return {
        name: tc.name,
        detail: '400 replay',
        trace: [
          'second registration of the same authenticator (excludeCredentials empty, counter reset to 0)',
          'expected 201, received 400 {"error":"replay"}',
          `${replay}: sign counter guard rejects newCount == storedCount — comparison uses >= where the spec wants >`,
        ],
      }
    }
    if (tc.name === 'login.windowsHello' && (replay || textCredId)) {
      const trace = ['assertion from the Windows Hello virtual authenticator', 'expected 200, received 401 {"error":"cred_id mismatch"}']
      if (replay) trace.push(`${replay}: Windows Hello reports signCount 0 on every assertion; guard with >= treats 0 vs 0 as a replay and the lookup falls through`)
      if (textCredId) trace.push(`${migration.path}: ${migration.credIdColumn} is ${migration.credIdType} — base64 stored at registration, base64url on lookup; store raw bytes (bytea)`)
      return { name: tc.name, detail: 'cred_id mismatch', trace }
    }
    return null
  }

  /** Seeded by the sha under test as well as the case, so two commits never print the same times. */
  function caseDuration(name: string, sha: string): string {
    return `${(2 + (parseInt(sha7(name, sha), 16) % 30) / 10).toFixed(1)}s`
  }

  function runE2e(grep: string | null): CommandResult {
    // The suite runs against the last push (the seed before any), not the
    // working tree — only what is on the branch is under test.
    const pushed = base
    const sha = commits[commits.length - 1]
    const seed = sha ?? 'seed'
    type Row = { title: string; file: string; line: number; project: string; judge: E2eCase | null; canonical: boolean }
    const rows: Row[] = [
      ...E2E_CASES.map((tc): Row => ({ title: `passkey › ${tc.name}`, file: E2E_SUITE_FILE, line: 12 + E2E_CASES.indexOf(tc) * 7, project: tc.browser, judge: tc, canonical: true })),
      ...collectSpecs(pushed).map((c): Row => ({ title: c.name, file: c.file, line: c.line, project: c.project, judge: c.group ? { name: c.name, group: c.group, browser: 'chromium' } : null, canonical: false })),
    ]
    let selected = rows
    if (grep) {
      // Model-supplied text is never compiled as a RegExp: a pathological
      // pattern would block the event loop in this synchronous filter.
      const needle = grep.toLowerCase()
      selected = rows.filter((r) => `${r.file} › ${r.title}`.toLowerCase().includes(needle))
    }
    const unpushed = diff().files
    const durationMs = selected.length * 4900 + 800 + (sha ? parseInt(sha7(sha), 16) % 1900 : 0)
    const failures: E2eFailure[] = []
    let suitePassed = 0
    const out: string[] = [
      sha ? `e2e on ${sha}` : `e2e on seed (nothing pushed to ${SEED_BRANCH} yet)`,
      `Running ${selected.length} test${selected.length === 1 ? '' : 's'} using 4 workers`,
      ...(grep ? [`grep: substring match, case-insensitive · ${JSON.stringify(grep)}`] : []),
      '',
    ]
    selected.forEach((r, i) => {
      const failure = r.judge ? e2eFailure(r.judge, pushed) : null
      if (failure) failures.push(failure)
      else if (r.canonical) suitePassed++
      out.push(`  ${failure ? '✘' : '✓'} ${String(i + 1).padStart(3)} [${r.project}] › ${r.file}:${r.line}:3 › ${r.title} (${caseDuration(r.title, seed)})`)
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
      revision,
      sha: sha ?? null,
      fullSuite: selected.filter((r) => r.canonical).length === E2E_CASES.length,
      suite: { passed: suitePassed, total: E2E_CASES.length },
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

  function checkMerge(): { ok: boolean; reason?: string } {
    if (pr.merged) return { ok: false, reason: `PR #${pr.number} is already merged` }
    const sha = commits.at(-1)
    if (!sha) return { ok: false, reason: `nothing to merge — no commits pushed to ${pr.branch}` }
    // diff() is a display summary and can omit byte-only changes such as a final newline.
    if (tree.size !== base.size || [...tree].some(([path, content]) => base.get(path) !== content)) {
      return { ok: false, reason: 'working tree has unpushed changes' }
    }
    const open = pr.comments.filter((c) => c.blocking && !c.resolved)
    if (open.length) return { ok: false, reason: `blocking comments unresolved: ${open.map((c) => c.id).join(', ')}` }
    if (pr.review !== 'approved' || pr.reviewRevision !== revision) {
      return { ok: false, reason: 'positive review required for the current revision' }
    }
    if (!lastTests || lastTests.revision !== revision || lastTests.sha !== sha || !lastTests.fullSuite ||
      lastTests.failed !== 0 || lastTests.suite.passed !== E2E_CASES.length) {
      return { ok: false, reason: 'passing full e2e coverage required for the current pushed revision' }
    }
    return { ok: true }
  }

  const prApi: Workspace['pr'] = {
    state: () => ({ ...pr, comments: pr.comments.map((c) => ({ ...c })), commits: [...pr.commits] }),
    comment(author: AgentId, body: string, blocking: boolean): PrComment {
      const c: PrComment = { id: `c${++commentSeq}`, author, body, blocking, resolved: false }
      pr.comments.push(c)
      return { ...c }
    },
    resolve(id: string): boolean {
      const c = pr.comments.find((x) => x.id === id)
      if (!c || c.resolved) return false
      c.resolved = true
      return true
    },
    review(_author, verdict) {
      pr.review = verdict === 'approve' ? 'approved' : 'changes_requested'
      pr.reviewRevision = revision
    },
    checkMerge,
    merge() {
      const ready = checkMerge()
      if (!ready.ok) return ready
      pr.merged = true
      return { ok: true }
    },
  }

  // ---- scans ---------------------------------------------------------------

  function secScan(): SecFinding[] {
    const findings: SecFinding[] = []
    const migration = credentialsMigration()
    if (migration.credIdType === 'text' && migration.path) {
      findings.push({ level: 'RISK', path: migration.path, msg: `${migration.credIdColumn} stored as text — base64 round-trip` })
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
    invalidateEvidence()
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
    revision: () => revision,
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
