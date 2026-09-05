import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_IDS, type AgentId } from '../shared/protocol.js'
import type { Config, Effort } from './contracts.js'

export const DEFAULT_MODEL = 'claude-opus-5'

/** `Config` plus the knobs only the composition root and the HTTP layer read. */
export interface ServerConfig extends Config {
  /** HOST — interface to listen on. Default loopback; `0.0.0.0` is an explicit opt-in to the LAN. */
  host: string
  /** LIFETIME_BUDGET_USD — cumulative spend across every run of this process; `/api/run/start` is refused once reached. */
  lifetimeBudgetUsd: number
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

/**
 * Repository root, found by walking up from this module until a package.json
 * appears — so the same code works from `server/` under tsx and from
 * `dist-server/server/` after a build.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const llm = flag('MOCK_LLM', env) === true ? 'mock' : 'anthropic'
  const autoStartFlag = flag('AUTO_START', env)
  const budgetUsd = number('RUN_BUDGET_USD', env, 5, { minExclusive: 0 })
  return {
    port: integer('PORT', env, 8787, { min: 1, max: 65535 }),
    host: raw('HOST', env) ?? '127.0.0.1',
    llm,
    models: models(env),
    effort: effort(env),
    budgetUsd,
    lifetimeBudgetUsd: number('LIFETIME_BUDGET_USD', env, budgetUsd * 4, { minExclusive: 0 }),
    maxIterationsPerTurn: integer('MAX_ITERATIONS_PER_TURN', env, 24, { min: 1 }),
    maxTurnsPerAgent: integer('MAX_TURNS_PER_AGENT', env, 60, { min: 1 }),
    mockSpeed: number('MOCK_SPEED', env, 1, { min: 0 }),
    autoStart: autoStartFlag ?? llm === 'mock',
    staticDir: staticDir(env),
  }
}

function raw(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[name]?.trim()
  return v ? v : undefined
}

/** `undefined` when unset or blank; throws on anything that is not a recognisable boolean. */
function flag(name: string, env: NodeJS.ProcessEnv): boolean | undefined {
  const v = raw(name, env)
  if (v === undefined) return undefined
  const lower = v.toLowerCase()
  if (TRUE.has(lower)) return true
  if (FALSE.has(lower)) return false
  throw new Error(`${name} must be 1/0 or true/false, got "${v}"`)
}

function number(
  name: string,
  env: NodeJS.ProcessEnv,
  fallback: number,
  bounds: { min?: number; minExclusive?: number; max?: number },
): number {
  const v = raw(name, env)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`)
  if (bounds.min !== undefined && n < bounds.min) throw new Error(`${name} must be >= ${bounds.min}, got ${n}`)
  if (bounds.minExclusive !== undefined && n <= bounds.minExclusive) {
    throw new Error(`${name} must be > ${bounds.minExclusive}, got ${n}`)
  }
  if (bounds.max !== undefined && n > bounds.max) throw new Error(`${name} must be <= ${bounds.max}, got ${n}`)
  return n
}

function integer(name: string, env: NodeJS.ProcessEnv, fallback: number, bounds: { min?: number; max?: number }): number {
  const n = number(name, env, fallback, bounds)
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${n}`)
  return n
}

function models(env: NodeJS.ProcessEnv): Record<AgentId, string> {
  const out = {} as Record<AgentId, string>
  for (const id of AGENT_IDS) {
    const name = `AGENT_MODEL_${id.toUpperCase()}`
    const v = raw(name, env) ?? DEFAULT_MODEL
    if (!/^[A-Za-z0-9._:-]+$/.test(v)) throw new Error(`${name} is not a valid model id: "${v}"`)
    out[id] = v
  }
  return out
}

function effort(env: NodeJS.ProcessEnv): Effort {
  const v = raw('EFFORT', env)
  if (v === undefined) return 'high'
  const lower = v.toLowerCase() as Effort
  if (!EFFORTS.includes(lower)) throw new Error(`EFFORT must be one of ${EFFORTS.join(', ')}, got "${v}"`)
  return lower
}

function staticDir(env: NodeJS.ProcessEnv): string | null {
  const v = raw('STATIC_DIR', env)
  if (v !== undefined) {
    const dir = resolve(process.cwd(), v)
    if (!isDir(dir)) throw new Error(`STATIC_DIR "${v}" is not a directory (resolved to ${dir})`)
    return dir
  }
  const dist = resolve(repoRoot(), 'dist')
  return isDir(dist) ? dist : null
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
