import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PERSONAS } from '../server/agents.js'
import { loadConfig, type ServerConfig } from '../server/config.js'
import type { LLM } from '../server/contracts.js'
import { createOrchestrator } from '../server/orchestrator.js'
import { createRunStore } from '../server/run.js'
import { createToolRegistry } from '../server/tools.js'
import { createWorkspace } from '../server/workspace.js'
import { AGENT_IDS, type RunSnapshot } from '../shared/protocol.js'

export function acceptanceConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const missing = ['OPENAI_API_KEY', 'RUN_BUDGET_USD', 'LIFETIME_BUDGET_USD'].filter(key => !env[key]?.trim())
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  if (env.LLM_PROVIDER && env.LLM_PROVIDER !== 'openai') throw new Error('smoke:real requires LLM_PROVIDER=openai')
  if (env.MOCK_LLM && !['0', 'false', 'off', 'no'].includes(env.MOCK_LLM.toLowerCase())) throw new Error('smoke:real refuses MOCK_LLM')
  // Deliberately excludes ambient hosting, autostart and .env settings.
  const selected: NodeJS.ProcessEnv = {
    LLM_PROVIDER: 'openai', AUTO_START: '0', HOST: '127.0.0.1',
    RUN_BUDGET_USD: env.RUN_BUDGET_USD, LIFETIME_BUDGET_USD: env.LIFETIME_BUDGET_USD,
    OPENAI_MODEL: env.OPENAI_MODEL, EFFORT: env.EFFORT ?? 'medium',
    MAX_TURNS_PER_AGENT: env.MAX_TURNS_PER_AGENT ?? '12',
    MAX_ITERATIONS_PER_TURN: env.MAX_ITERATIONS_PER_TURN ?? '12',
  }
  for (const id of AGENT_IDS) selected[`AGENT_MODEL_${id.toUpperCase()}`] = env[`AGENT_MODEL_${id.toUpperCase()}`]
  // Config errors can echo invalid values; report the setting name, never its value.
  let config: ServerConfig
  try { config = loadConfig(selected) } catch { throw new Error('Invalid acceptance configuration; check model, effort, positive budgets and integer turn limits') }
  if (config.lifetimeBudgetUsd < config.budgetUsd) throw new Error('LIFETIME_BUDGET_USD must be at least RUN_BUDGET_USD')
  return config
}

export function redact(text: string, secrets: string[] = []): string {
  let result = text
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]')
  return result.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
}

interface RunReport {
  attempt: number
  runId: string
  passed: boolean
  reason: string
  status: string
  costUsd: number
  cumulativeCostUsd: number
  unreportedRequests: number
  accountingComplete: boolean
  elapsedMs: number
  requests: Record<string, number>
  agents: { id: string; status: string; subtask: string; toolCalls: number }[]
  snapshot: RunSnapshot
}
export interface AcceptanceResult {
  proof: 'live' | 'offline'
  passed: boolean
  revision: string
  directory: string
  reports: RunReport[]
  settings: { models: ServerConfig['models']; effort: string; runBudgetUsd: number; lifetimeBudgetUsd: number; timeoutMs: number }
}
interface Options {
  config: ServerConfig
  provider: () => LLM
  outputDir: string
  revision: string
  proof: 'live' | 'offline'
  signal?: AbortSignal
  timeoutMs?: number
  drainMs?: number
  secrets?: string[]
}

/** Runs two consecutive attempts, stopping on the first failure. No HTTP listener or automatic merge. */
export async function runAcceptance(options: Options): Promise<AcceptanceResult> {
  const { config } = options
  if (config.llm !== 'openai') throw new Error('Acceptance requires the OpenAI provider')
  const timeoutMs = options.timeoutMs ?? 25 * 60_000
  const drainMs = options.drainMs ?? 1500
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(drainMs) || drainMs < 0) throw new Error('Invalid runner time limits')
  mkdirSync(options.outputDir, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(options.outputDir, 'acceptance-'))
  const safe = (value: unknown) => redact(JSON.stringify(value), options.secrets)
  const save = (name: string, value: unknown) => writeFileSync(join(directory, name), safe(value) + '\n', { mode: 0o600 })
  const result: AcceptanceResult = { proof: options.proof, passed: false, revision: options.revision, directory, reports: [], settings: { models: config.models, effort: config.effort, runBudgetUsd: config.budgetUsd, lifetimeBudgetUsd: config.lifetimeBudgetUsd, timeoutMs } }
  const store = createRunStore(PERSONAS, config.models)
  save('result.json', { ...result, state: 'running', startedAt: new Date().toISOString() })

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now()
    const workspace = createWorkspace()
    const provider = options.provider()
    if (provider.kind !== 'openai') throw new Error('Acceptance refuses a mock provider identity')
    const requests = Object.fromEntries(AGENT_IDS.map(id => [id, 0]))
    let pending = 0, writeError = false, bytes = 0
    const llm: LLM = {
      kind: 'openai', healthcheck: model => provider.healthcheck(model),
      async complete(request) {
        requests[request.agent]++
        pending++
        try { return await provider.complete(request) } finally { pending-- }
      },
    }
    const orchestrator = createOrchestrator({ config, store, workspace, tools: createToolRegistry(), llm, personas: PERSONAS })
    const transcript = join(directory, `run-${attempt}.jsonl`)
    writeFileSync(transcript, '', { flag: 'wx', mode: 0o600 })
    const record = (event: unknown) => {
      if (writeError) return
      try {
        const line = safe({ at: new Date().toISOString(), event }) + '\n'
        bytes += Buffer.byteLength(line)
        if (bytes > 50 * 1024 * 1024) throw new Error('Transcript size limit')
        appendFileSync(transcript, line)
      } catch { writeError = true }
    }
    store.reset({ status: 'idle', llm: 'openai', approvalGate: true })
    record({ type: 'snapshot', snapshot: store.snapshot() })
    const unsubscribe = store.subscribe(record)
    let reason = '', ready = false
    try {
      // start() has no lifetime guard (the HTTP layer owns that), so enforce it here too.
      if (store.lifetimeCostUsd() + config.budgetUsd > config.lifetimeBudgetUsd) reason = 'Insufficient remaining cumulative budget for another full run'
      if (options.signal?.aborted) reason = 'Interrupted'
      for (const model of new Set(Object.values(config.models))) {
        if (reason) break
        let finished = false, problem: string | null = null
        void llm.healthcheck(model).then(value => { problem = value; finished = true }, () => { problem = 'Provider healthcheck failed'; finished = true })
        while (!finished && !options.signal?.aborted && Date.now() - started < timeoutMs) await delay(10)
        if (!finished) reason = options.signal?.aborted ? 'Interrupted' : 'Healthcheck timeout'
        else if (problem) reason = `Healthcheck: ${problem}`
      }
      if (!reason) {
        store.setRun({ approvalGate: true, llm: 'openai' })
        await orchestrator.start()
        while (true) {
          const snapshot = store.snapshot()
          if (writeError) { reason = 'Transcript write failed or exceeded 50 MiB'; break }
          if (options.signal?.aborted) { reason = 'Interrupted'; break }
          if (snapshot.run.status === 'failed') { reason = snapshot.run.error ?? 'Run failed'; break }
          if (snapshot.stats.unreportedRequests > 0) { reason = 'Usage unknown; acceptance cannot establish spend'; break }
          if (store.lifetimeCostUsd() >= config.lifetimeBudgetUsd) { reason = 'Cumulative budget reached'; break }
          if (Date.now() - started >= timeoutMs) { reason = 'Run timeout'; break }
          // A status transition alone is insufficient: wait for all provider calls and their usage.
          if (snapshot.run.status === 'needs_approval' && snapshot.typing.length === 0 && pending === 0) {
            ready = snapshot.run.approvalGate && !workspace.pr.state().merged && workspace.pr.checkMerge().ok
            reason = ready ? 'Human approval gate reached with current merge evidence' : 'Approval gate evidence invalid'
            break
          }
          if (snapshot.run.status === 'done') { reason = 'Unexpected completion without human approval'; break }
          await delay(10)
        }
      }
    } catch { reason = 'Runner error; inspect the event transcript' }
    finally {
      orchestrator.dispose()
      const deadline = Date.now() + drainMs
      while (pending && Date.now() < deadline) await delay(10)
      // Let orchestrator continuations record late usage before taking the final snapshot.
      await delay(0)
      record({ type: 'final', snapshot: store.snapshot(), pendingRequests: pending })
      unsubscribe()
    }
    const snapshot = store.snapshot()
    const accountingComplete = pending === 0 && snapshot.stats.unreportedRequests === 0
    const passed = ready && accountingComplete && !writeError && snapshot.stats.costUsd < config.budgetUsd && store.lifetimeCostUsd() < config.lifetimeBudgetUsd
    if (!accountingComplete) reason = 'Outstanding requests or missing usage; spend is a lower bound'
    if (writeError) reason = 'Transcript write failed or exceeded 50 MiB'
    const report: RunReport = {
      attempt, runId: snapshot.run.id, passed, reason: redact(reason, options.secrets), status: snapshot.run.status,
      costUsd: snapshot.stats.costUsd, cumulativeCostUsd: store.lifetimeCostUsd(),
      unreportedRequests: snapshot.stats.unreportedRequests, accountingComplete, elapsedMs: Date.now() - started,
      requests, agents: snapshot.agents.map(a => ({ id: a.id, status: a.status, subtask: a.subtask, toolCalls: a.tools.length })), snapshot,
    }
    result.reports.push(report)
    save(`run-${attempt}.json`, report)
    const markdown = [`# Acceptance attempt ${attempt}: ${passed ? 'PASS' : 'FAIL'}`, '', `Proof: ${options.proof}; revision: ${options.revision}`, `Run: ${report.runId}`, `Result: ${reason}`, `Reported cost: $${report.costUsd.toFixed(6)}; cumulative: $${report.cumulativeCostUsd.toFixed(6)}`, `Accounting complete: ${accountingComplete}; unknown requests: ${report.unreportedRequests}`, `Elapsed: ${report.elapsedMs} ms`, `Tokens: input ${snapshot.stats.inputTokens}, output ${snapshot.stats.outputTokens}, cache read ${snapshot.stats.cacheReadTokens}, cache write ${snapshot.stats.cacheWriteTokens}`, '', '| Agent | Model requests | Tool calls | State / last task |', '| --- | ---: | ---: | --- |', ...report.agents.map(a => `| ${a.id} | ${requests[a.id]} | ${a.toolCalls} | ${a.status}: ${a.subtask.replace(/[|\r\n]/g, ' ')} |`), '', 'All repository operations are simulated. Reported usage limits can overshoot during concurrent requests. Raw provider request/response objects and reasoning continuation are not recorded.', '']
    writeFileSync(join(directory, `run-${attempt}.md`), redact(markdown.join('\n'), options.secrets), { mode: 0o600 })
    save('result.json', { ...result, state: 'running' })
    if (!passed) break
  }
  result.passed = result.reports.length === 2 && result.reports.every(r => r.passed)
  save('result.json', { ...result, state: 'finished', finishedAt: new Date().toISOString() })
  return result
}
