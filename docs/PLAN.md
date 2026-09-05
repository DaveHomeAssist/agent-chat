# Agent Chatroom: phased plan to the goal

_Written 2026-09-05 00:00 ET. Source of truth for every overnight session. Read this and `docs/STATUS.md` first; update both before you stop._

## The goal, stated

**Agent Chatroom runs unattended: five Claude agents ship a real feature on a real GitHub repository, with the human merge gate, a hard budget ceiling, and a live dashboard Dave can open from anywhere.**

Milestones, in order:

| # | Milestone | Done when |
| --- | --- | --- |
| M1 | **Working prototype** | One real Claude Opus 5 run on the virtual workspace reaches `NEEDS YOU` or `DONE` without human repair, under budget, and `npm run smoke:real` reproduces that headlessly |
| M2 | **Unattended-safe** | A run survives a server restart, has an auth token, exports its transcript, and CI runs the mock e2e on every push |
| M3 | **Real repository** | The same five agents ship a small feature on a throwaway GitHub repo: real files, real `git`, real commands in a sandbox, a real PR held by the gate |
| M4 | **Deployed** | The server runs on a small VM or Fly.io behind HTTPS with token auth; the dashboard is reachable from Dave's phone |

Where we are: `main` has the live server (PR #1 merged). `fix/review-findings` (`b72b490`) carries 22 verified fixes and is waiting on a PR click. The real-model path has **never executed a model turn** because no session has had credentials. M1 is therefore the first thing to prove, and it is mostly waiting on Dave's setup, not on code.

## Phase 0: unblock (Dave, ~15 min, no agent)

Every one of these removes a place where an overnight session would otherwise stall and wait for a click.

1. **Historical review-fix delivery step (superseded by the runtime correctness package; see STATUS.md)**: https://github.com/DaveHomeAssist/agent-chat/compare/main...fix/review-findings (body is in the branch's PR text below). Until the fixes are on `main`, `run_finish` can merge past the gate and a malformed URL crashes the server.
2. **Connect the Claude GitHub App** for `DaveHomeAssist`. The session's git push works, but every REST call returns `403 GitHub access is not enabled for this session`. Remedy per the platform: reconnect GitHub under claude.ai Settings → Connectors, then grant the repo. This is what lets sessions open PRs, read Codex comments, and later create the M3 pull request without you.
3. **Put credentials in the environment**, not in a prompt: `ANTHROPIC_API_KEY`, `RUN_BUDGET_USD=3`, `LIFETIME_BUDGET_USD=15` as environment variables on the Claude Code web environment (docs: https://code.claude.com/docs/en/claude-code-on-the-web). Overnight sessions inherit them; nothing is pasted into chat.
4. **Decide Vercel**: delete `dpl_7Ts3NY2DW8oXpNk6AfcyLMxjbjew` (say "delete it"). Vercel is not the deploy target for M4: the server holds an in-memory orchestrator and long-lived SSE connections, which serverless functions time out.
5. Optional but saves a cycle: create the empty GitHub repo `DaveHomeAssist/agent-chat-sandbox` for M3 (no README).

## The overnight protocol (embedded in every prompt)

Sessions get lost in three ways: the usage limit (observed reset at **01:00 UTC**), an MCP or container hiccup, and a workflow that finishes with no one awake to read it. The protocol makes progress durable and self-resuming.

- **Ledger in the repo.** `docs/STATUS.md` has one section per phase: `state` (not started / running / blocked / done), `last heartbeat` (UTC), `next action`, `blocked on`, `workflow run id`, `journal path`. Update it and commit at every milestone. The repo's stop hook already refuses to end a turn with uncommitted work; treat that as the safety net, not the plan.
- **Heartbeat.** Every 20 minutes of active work: append one line to `docs/STATUS.md` and `git commit -am "status: <phase> heartbeat"`; push every hour. A reader can always tell whether the session is alive from `git log -1 --format=%cd origin/<branch>`.
- **Resumable workflows.** Every multi-agent step runs as a `Workflow` script; record `scriptPath` and `runId` in STATUS. After any interruption, resume with `Workflow({scriptPath, resumeFromRunId})`: finished agents replay from cache, only the interrupted ones rerun. Per-agent results live in `<transcript dir>/journal.jsonl`; read that before assuming anything was lost.
- **Self check-ins.** At the start of a phase, schedule `send_later` at +60 and +120 min with the message "Overnight check-in: read docs/STATUS.md and the workflow journal; if the last heartbeat is older than 30 min, resume the recorded run id; if blocked on Dave, write the one-line ask to STATUS.md and Notion, then work the next unblocked item." Re-arm on every firing until the phase is done. For a whole night, `create_trigger` with `0 * * * *` bound to the session does the same hourly.
- **Machine limits to plan around.** 4 CPUs → the workflow runner allows **2 agents at a time**; shard work by file ownership and expect ~35 min per wave of 2. Outbound Google Fonts is blocked (ignore font 404s). Playwright is at `scratchpad/node_modules/playwright`, Chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Never `pkill -f 'vite'` or `pkill -f 'tsx server'`: the pattern matches the shell that runs it and kills the session's command (use `pkill -f '[v]ite --port'`).
- **Budget.** The first two workflows cost ~6M and ~3M subagent tokens. Start heavy phases after 01:00 UTC so the reset lands mid-run rather than at the end.
- **When blocked on Dave**, never stop silently: write the ask into STATUS.md and the Notion run record, then continue with everything that does not depend on it.
- **Notion.** One row per phase in `DB | Status Check Runs` (RUN-YYYYMMDD-HHMM), light updated at start and end; the thread-open row is RUN-20260904-1648.

## Phase 1: working prototype (one prompt, ~2 h wall clock, most of it model time)

Goal: M1. Branch `feat/real-run`.

The prompt:

```
Read docs/PLAN.md and docs/STATUS.md. Phase 1: prove the real-model path.
0. Preconditions: ANTHROPIC_API_KEY, RUN_BUDGET_USD and LIFETIME_BUDGET_USD are in the environment (check with `env | grep -c ANTHROPIC`); if not, write the ask to STATUS.md and the Notion run record and stop this phase. Confirm main carries the 22 fixes (git log origin/main --oneline | head); check GitHub for the actual review/runtime PR and its merge state; the earlier PR #2 reference was not verified.
1. Write docs/STATUS.md Phase 1 = running, schedule send_later check-ins at +60 and +120 min with the protocol message from PLAN.md.
2. Add `npm run smoke:real`: server/scripts/smoke-real.ts boots the server with the real LLM, AUTO_START=1, RUN_BUDGET_USD=1, EFFORT=medium, MAX_TURNS_PER_AGENT=12, waits up to 25 min, and exits 0 only if run.status reaches needs_approval or done; writes the full event stream to runs/<runId>.jsonl and a one-page report (turns per agent, tool calls, cost, cache hit rate, where each agent stalled) to runs/<runId>.md. Exit non-zero with the report on failure. Commit.
3. Run it once. Watch the transcript while it runs (tail the JSONL). Expect the real model to do things the mock never did: skip agent_progress, call tools with slightly wrong shapes, write prose the room does not need, stall waiting for a push that never comes, request merge too early. For each, fix the cause, not the symptom: tighten a tool description in server/contracts.ts, add a nudge to the wake message, add a guard in the orchestrator, or adjust a persona prompt (keep prompts goal-and-constraint shaped, not step lists). Re-run the smoke after each fix set. Cap: 4 real runs or $4 total, whichever first; record every run's cost in STATUS.md.
4. When the smoke passes twice in a row: run the mock e2e (scratchpad/e2e-mock.mjs, scratchpad/e2e-fixes.mjs) to make sure nothing regressed, npm run build, commit, push, open the PR (API) or leave the compare link in STATUS.md if the API still 403s.
5. Update the Notion run row (new RUN id, light, cost, link to runs/<id>.md), STATUS.md Phase 1 = done with the two passing run ids, and cancel the check-ins.
```

Definition of done: two consecutive `smoke:real` passes under $1 each, transcript and report committed under `runs/`, PR open.

## Phase 2: unattended-safe (one prompt, overnight)

Goal: M2. Branch `feat/durable`. Run as one Workflow with four fixers by file ownership, an integrator, and a skeptic per item (the shape that worked for the 22 fixes).

The prompt:

```
Read docs/PLAN.md and docs/STATUS.md. Phase 2: make runs survive the night. Write STATUS Phase 2 = running, schedule hourly check-ins (create_trigger, 0 * * * *, bound to this session) with the protocol message. Then author and run one Workflow (fixers by ownership → integrator → one skeptic per item → finisher), recording scriptPath and runId in STATUS.md before it starts.
Items:
A. Persistence (server/run.ts, server/persist.ts, server/index.ts): append every RunEvent to runs/<runId>.jsonl as it is emitted; on boot, if RUNS_RESUME=1 and the latest run is not done/failed, rebuild the store by replaying the log and re-arm the orchestrator from the rebuilt state (agents that were mid-turn restart their last wake; document the one edge you cannot replay). Keep the in-memory path the default for the mock.
B. Auth (server/http.ts, src/api/client.ts): API_TOKEN env; when set, every /api request needs `Authorization: Bearer` or a `?token=` on the SSE URL; the client reads it from localStorage after a one-time prompt in the banner. No token → unchanged behaviour on loopback, refuse to bind non-loopback without a token.
C. Runs API + picker (shared/protocol.ts additive only, server/http.ts, src/): GET /api/runs lists past runs from runs/; GET /api/runs/:id returns a snapshot rebuilt from its log; a tiny run switcher in the header sub-line (design-consistent, mono 10px). Live run stays default.
D. Tests + CI (tests/, .github/workflows/ci.yml): move scratchpad/harness.mts into tests/orchestrator.test.ts under vitest with the existing 10 scenarios plus the 22-fix checks that do not need a browser; CI job: npm ci, typecheck, selfcheck, vitest, build, then the mock browser e2e with Playwright's bundled Chromium. Green on the PR.
E. The ten parked fidelity minors (src/): Snapshot button exports the current snapshot JSON; Reassign opens the target chip on the selected agent; token counter includes cache tokens with a tooltip breakdown; idle banner names the run's llm truthfully; header decisions stat and Decisions filter agree; output log footer says "streaming" only while that agent is mid-call; quick-command labels are not hardcoded to PR #482.
Every item: smallest correct change, typecheck, and a targeted check in scratchpad/e2e-phase2.mjs. Finish: full gate (typecheck, selfcheck, vitest, build, both browser e2e), commit, push, PR, STATUS + Notion updated, cancel the trigger.
```

Definition of done: kill -9 the server mid-run, restart with `RUNS_RESUME=1`, the dashboard shows the same run continuing; CI green on the PR; token auth verified from a second origin.

## Phase 3: real repository (one prompt, overnight, the hard one)

Goal: M3. Branch `feat/git-workspace`. Safety first: the agents get a **sandbox**, never Dave's checkout.

The prompt:

```
Read docs/PLAN.md and docs/STATUS.md. Phase 3: a Workspace adapter backed by a real git checkout. STATUS Phase 3 = running, hourly check-ins armed, one Workflow, runId recorded.
Design rules (non-negotiable): the adapter operates only inside WORKSPACE_DIR (a fresh clone the server makes at run start, deleted at run end unless KEEP_WORKSPACE=1); every path is resolved and must stay under that dir; commands come only from WORKSPACE_COMMANDS (a JSON map of allowed names to argv, e.g. {"pnpm typecheck":["pnpm","typecheck"]}), run with a 5 min timeout, output capped at 32 KB, no shell string interpolation, environment scrubbed to PATH/HOME/CI; git operations are add/commit/push to a branch named by the run on the configured remote only, never force, never to main; network for the agents is the git remote only. If Docker is available in the environment, run commands inside a throwaway container with the workspace mounted; otherwise document that the host runs them and gate it behind WORKSPACE_ALLOW_HOST=1.
Items:
A. server/workspace/git.ts implementing the same Workspace interface as the in-memory one: list/read/write/patch/remove on real files; diff via `git diff --numstat`; push = commit + push; rollback = `git checkout -- .` + clean; docs and migrations are just paths; pr.* uses the GitHub REST API with GITHUB_TOKEN (open PR on first push, comments and review as real PR review objects, merge = squash merge respecting the same gate); secScan runs `npm audit --json` when package.json exists plus the existing storage heuristics; artifact() returns the last failing command's output; describe() from `git ls-files` with sizes.
B. Config (server/config.ts, .env.example, README): WORKSPACE=memory|git, WORKSPACE_REPO, WORKSPACE_BASE_BRANCH, WORKSPACE_COMMANDS, RUN_GOAL, RUN_CHANNEL; personas read the goal from config (server/agents.ts stays byte-stable per run: build the system prompt once at start from config). The seed story and mock stay on WORKSPACE=memory.
C. Feature spec for the first real run: a throwaway repo (DaveHomeAssist/agent-chat-sandbox seeded by the session with a tiny TypeScript service and a passing test) and RUN_GOAL "add a /healthz endpoint returning build sha and uptime, with a test". Small enough to finish in one run under $3.
D. Run it for real, with RUN_BUDGET_USD=3: the gate must hold, the PR must exist on GitHub with the agents' commits, the tests must run for real. Fix what breaks. Record cost and the PR link in STATUS.md.
Finish: gate (typecheck, selfcheck, vitest, build, mock e2e still green on WORKSPACE=memory), commit, push, PR, STATUS + Notion, cancel trigger.
```

Definition of done: a PR on the sandbox repo, opened by the agents, held by the gate, merged by Dave, with the feature and its test in it.

## Phase 4: deploy (one prompt, ~2 h)

Goal: M4. Branch `feat/deploy`.

```
Read docs/PLAN.md and docs/STATUS.md. Phase 4: run it somewhere Dave can open on his phone.
1. Dockerfile (node:22-slim, npm ci, npm run build, `npm start`), docker-compose.yml with a volume for runs/ and the workspace dir, healthcheck on /api/state. HOST=0.0.0.0 inside the container only, API_TOKEN required.
2. fly.toml (or a one-page VPS runbook if FLY_API_TOKEN is absent): one small machine, persistent volume, secrets for ANTHROPIC_API_KEY, API_TOKEN, GITHUB_TOKEN, budgets. HTTPS by the platform.
3. Deploy, open the URL with the token, start a mock run, then a $1 real run. Screenshot both into docs/.
4. README "Deploy" section; STATUS Phase 4 = done with the URL; Notion run row closed 🟢 if everything above holds.
```

## Fastest path

Phase 0 today (15 min of your clicks). Phase 1 tonight after 01:00 UTC. Phases 2 and 3 on consecutive nights; Phase 3 needs Phase 0 item 2 (the GitHub App) or a `GITHUB_TOKEN` env var for the sandbox repo. Phase 4 whenever M3 lands. Four prompts total, each self-contained, each leaving the repo and Notion in a state the next one can read.

If only one thing happens: **Phase 0 item 3 plus the Phase 1 prompt** gives you the working prototype with real agents.
