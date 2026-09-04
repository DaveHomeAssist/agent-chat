/**
 * Seed tree for the virtual `helios/api` repository: a small Fastify + Prisma
 * auth service with password login and an SMS OTP fallback, and no passkey
 * support yet. The feature the agents ship adds `services/auth/webauthn/*`,
 * migration `0043_credentials` and removes `legacy/otp.ts`.
 *
 * Every file here must pass the simulated `pnpm typecheck` clean (balanced
 * braces, every import used) so the first run starts from green.
 */

export const SEED_REPO = 'helios/api'
export const SEED_BRANCH = 'feat/passkey-auth'

export const SEED_FILES: Record<string, string> = {
  'package.json': `{
  "name": "@helios/api",
  "version": "3.14.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --ext .ts",
    "test": "vitest run",
    "e2e": "playwright test --config e2e/playwright.config.ts",
    "migrate": "node scripts/migrate.mjs"
  },
  "dependencies": {
    "@prisma/client": "5.19.1",
    "fastify": "4.28.1",
    "jose": "5.9.3",
    "zod": "3.23.8"
  },
  "devDependencies": {
    "@playwright/test": "1.47.2",
    "prisma": "5.19.1",
    "tsx": "4.19.1",
    "typescript": "5.6.2",
    "vitest": "2.1.1"
  }
}
`,

  'README.md': `# helios/api

Account and session service for helios.app. Fastify 4, Prisma 5, Postgres 16.

## Auth today

- Password login: \`POST /auth/login\` → session JWT (12h, HS256)
- SMS one-time code fallback: \`POST /auth/otp/start\` and \`/auth/otp/verify\`
  (legacy — see \`services/auth/legacy/otp.ts\`, behind \`auth.sms_otp\`)

## Working on it

\`\`\`
pnpm install
pnpm migrate          # applies db/migrations/*.sql to helios_dev
pnpm typecheck && pnpm lint && pnpm test
pnpm e2e              # playwright, chrome + safari + windows hello virtual authenticator
\`\`\`

Feature flags live in \`config/flags.ts\`; ops overrides them with \`FLAGS_JSON\`.
Architecture decisions are recorded under \`docs/adr/\`.
`,

  'config/flags.ts': `/** Runtime feature flags. Values here are the defaults; ops overrides via FLAGS_JSON. */
export const FLAGS = {
  'auth.passkeys': false,
  'auth.sms_otp': true,
  'billing.v2_invoices': true,
} as const

export type FlagName = keyof typeof FLAGS

export function flag(name: FlagName): boolean {
  const override = process.env.FLAGS_JSON
  if (!override) return FLAGS[name]
  const parsed = JSON.parse(override) as Partial<Record<FlagName, boolean>>
  return parsed[name] ?? FLAGS[name]
}
`,

  'src/server.ts': `import Fastify from 'fastify'
import { authRoutes } from '../services/auth/routes'

const app = Fastify({ logger: true })

app.get('/healthz', async () => ({ ok: true, version: process.env.GIT_SHA ?? 'dev' }))
await app.register(authRoutes)

const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
`,

  'prisma/schema.prisma': `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String   @id @default(uuid()) @db.Uuid
  email        String   @unique
  passwordHash String   @map("password_hash")
  phone        String?
  createdAt    DateTime @default(now()) @map("created_at")
  lastLoginAt  DateTime? @map("last_login_at")

  @@map("users")
}
`,

  'db/migrations/0042_users.sql': `-- 0042_users: baseline users table (squashed from 0001–0041)
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
`,

  'services/auth/session.ts': `import { SignJWT, jwtVerify } from 'jose'

const SESSION_TTL_SEC = 60 * 60 * 12
const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? 'dev-only-secret')

export interface Session {
  userId: string
  issuedAt: number
  method: 'password' | 'otp'
}

export async function issueSession(userId: string, method: Session['method']): Promise<string> {
  return new SignJWT({ method })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(\`\${SESSION_TTL_SEC}s\`)
    .sign(secret)
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    if (!payload.sub || typeof payload.iat !== 'number') return null
    return { userId: payload.sub, issuedAt: payload.iat, method: payload.method as Session['method'] }
  } catch {
    return null
  }
}
`,

  'services/auth/users.ts': `import { PrismaClient } from '@prisma/client'
import { scrypt, timingSafeEqual } from 'node:crypto'

export const prisma = new PrismaClient()

export interface UserRow {
  id: string
  email: string
  passwordHash: string
  phone: string | null
}

export function findUserByEmail(email: string): Promise<UserRow | null> {
  return prisma.user.findUnique({ where: { email: email.toLowerCase() } })
}

export function verifyPassword(user: UserRow, password: string): Promise<boolean> {
  const [salt, stored] = user.passwordHash.split('$')
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err)
      resolve(timingSafeEqual(derived, Buffer.from(stored, 'hex')))
    })
  })
}
`,

  'services/auth/routes.ts': `import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { flag } from '../../config/flags'
import { startOtp, verifyOtp } from './legacy/otp'
import { issueSession } from './session'
import { findUserByEmail, verifyPassword } from './users'

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(8) })
const OtpStartBody = z.object({ userId: z.string().uuid(), phone: z.string().min(8) })
const OtpVerifyBody = z.object({ userId: z.string().uuid(), code: z.string().length(6) })

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const body = LoginBody.parse(req.body)
    const user = await findUserByEmail(body.email)
    if (!user || !(await verifyPassword(user, body.password))) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    return { token: await issueSession(user.id, 'password') }
  })

  if (!flag('auth.sms_otp')) return

  app.post('/auth/otp/start', async (req, reply) => {
    const body = OtpStartBody.parse(req.body)
    await startOtp(body.userId, body.phone)
    return reply.code(202).send({ ok: true })
  })

  app.post('/auth/otp/verify', async (req, reply) => {
    const body = OtpVerifyBody.parse(req.body)
    if (!verifyOtp(body.userId, body.code)) return reply.code(401).send({ error: 'bad_code' })
    return { token: await issueSession(body.userId, 'otp') }
  })
}
`,

  'services/auth/legacy/otp.ts': `// SMS one-time-password fallback. Scheduled for removal once passkeys ship.
// Ref: ADR-0097 (2023) — kept only for accounts without a registered authenticator.
import { randomInt } from 'node:crypto'
import { sendSms } from '../../notify/sms'

const OTP_TTL_MS = 5 * 60 * 1000
const pending = new Map<string, { code: string; expiresAt: number }>()

export async function startOtp(userId: string, phone: string): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  pending.set(userId, { code, expiresAt: Date.now() + OTP_TTL_MS })
  await sendSms(phone, \`Your Helios code is \${code}\`)
}

export function verifyOtp(userId: string, code: string): boolean {
  const entry = pending.get(userId)
  if (!entry) return false
  pending.delete(userId)
  return entry.expiresAt > Date.now() && entry.code === code
}

export function pendingCount(): number {
  return pending.size
}
`,

  'services/notify/sms.ts': `const SMS_ENDPOINT = process.env.SMS_ENDPOINT ?? 'https://sms.helios.internal/v1/send'

export async function sendSms(to: string, body: string): Promise<void> {
  const res = await fetch(SMS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: \`Bearer \${process.env.SMS_TOKEN ?? ''}\` },
    body: JSON.stringify({ to, body }),
  })
  if (!res.ok) throw new Error(\`sms send failed: \${res.status}\`)
}
`,

  'e2e/login.spec.ts': `import { expect, test } from '@playwright/test'

const USER = { email: 'ada@helios.app', password: 'correct-horse-battery' }

test.describe('password login', () => {
  test('login.password → session cookie', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill(USER.email)
    await page.getByLabel('Password').fill(USER.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL('/')
    const cookies = await page.context().cookies()
    expect(cookies.some((c) => c.name === 'helios_session')).toBe(true)
  })

  test('login.password.wrong → 401', async ({ request }) => {
    const res = await request.post('/auth/login', { data: { ...USER, password: 'nope-nope' } })
    expect(res.status()).toBe(401)
  })
})
`,

  'docs/adr/README.md': `# Architecture decision records

One file per decision, numbered, never edited after acceptance — supersede instead.

| ADR | Title | Status |
| --- | --- | --- |
| 0097 | SMS OTP as the second-factor fallback | accepted (2023-04) |
| 0118 | Session tokens are HS256 JWTs, 12h | accepted (2024-01) |
| 0141 | Squash migrations 0001–0041 into 0042_users | accepted (2025-11) |

Next number: **0142**. Template: \`ADR-NNNN-<slug>.md\` with sections
Context · Decision · Consequences · Rejected alternatives.
`,
}
