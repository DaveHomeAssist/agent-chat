# Agent Chatroom

[Visual project progress](project-progress/index.html) · [Update contract](project-progress/README.md)

A multi-agent run console: five model-driven agents ship a feature together while a human
operator watches the room, messages agents, holds the merge gate, and pauses the run.

Built with Vite + React + TypeScript on the client and a dependency-free Node server. The UI is
a faithful port of the Claude Design prototype in
[`project/Agent Chatroom.dc.html`](project/Agent%20Chatroom.dc.html) — see
[`docs/HANDOFF.md`](docs/HANDOFF.md) and [`chats/`](chats) for the original brief.

The layout has a hard floor of 1180 × 700 — it is a desktop console, not a responsive site.

## Running it

Requires Node 22 or newer.

```bash
npm ci
cp .env.example .env      # optional; the server also reads plain environment variables
```

The server listens on `127.0.0.1` only. There is no authentication, so `HOST=0.0.0.0` is an
explicit opt-in: anyone who can reach the port can drive the run and spend your key.

### With real models

Provide Anthropic credentials, start both processes, and press **Start run** in the header:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or `ant auth login`, or ANTHROPIC_AUTH_TOKEN
npm run dev                            # server on :8787, Vite on :5173 (proxies /api)
```

On boot the server checks that the configured provider and Atlas model are reachable with your credentials. If it is
not, the run is marked `failed` with the reason and the dashboard shows it in a banner — the
server keeps serving so you can fix the server credentials and restart the process.

### With OpenAI

Use the same console and simulated tools with the OpenAI Responses API:

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=your-server-key
npm run dev
```

All five agents default to `gpt-5.6-sol`. `OPENAI_MODEL` sets the OpenAI default and
`AGENT_MODEL_ATLAS` through `AGENT_MODEL_SENTRY` override individual agents. This increment
supports only `gpt-5.6-sol`; other OpenAI models are rejected with a configuration error.
Effort supports `none`, `low`, `medium`, `high`, `xhigh`, and `max` (default `high`).
Real-provider auto-start is off by default. Provider selection is fixed at process startup.
`MOCK_LLM=1` takes precedence over `LLM_PROVIDER`, so `npm run demo` remains offline.

The official `openai` SDK streams text and complete function calls. Tools execute only after
a completed response; incomplete, refused, malformed, duplicate-call, and failed responses
execute no tools and fail the run. Call IDs and opaque reasoning items are carried in server
memory across turns with `store: false` and `reasoning.encrypted_content`. They are never
published as chat text or snapshot data. State resets with the run and is not persisted.
`store: false` controls response storage; it is not a zero data retention claim.
See [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling)
and [reasoning state](https://developers.openai.com/api/docs/guides/reasoning).

Keys stay on the server. Production uses the official API endpoint; `OPENAI_BASE_URL` is not
supported. Tests inject the SDK transport directly. There are no automatic OpenAI retries or
provider/model fallbacks, since an ambiguous failure may already have incurred usage.
Startup checks retrieve model metadata; they do not generate a paid response. Starting a real
run makes billable requests. Account access and a live OpenAI run still need separate acceptance.

### The demo

```bash
npm run demo
```

`MOCK_LLM=1` replaces the model with a scripted driver that plays out the design's story —
passkey sign-in on `helios/api` behind `auth.passkeys`, PR #482, ADR-0142, migration
`0043_credentials`, Probe's 2/24 replay-guard failures, Sentry's `cred_id` finding — against
the same workspace, tools and orchestrator the real run uses. No key needed; the run
auto-starts. `MOCK_SPEED=0` makes it instant.

### Production build

```bash
npm run build      # typecheck, client bundle to dist/, server to dist-server/
npm start          # one process: serves dist/ and the API on PORT
```

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `mock`, selected at startup. |
| `OPENAI_API_KEY` | — | Server-only OpenAI credentials. |
| `OPENAI_MODEL` | `gpt-5.6-sol` | Default model only when OpenAI is selected; the sole supported OpenAI profile. |
| `ANTHROPIC_API_KEY` | — | Credentials. `ANTHROPIC_AUTH_TOKEN` and an `ant auth login` profile also work. |
| `MOCK_LLM` | off | `1`/`true` drives the run with the scripted mock instead of a model. |
| `RUN_BUDGET_USD` | `5` | Reported-usage limit per run, must be > 0. The run stops (`failed`) when reached; in-flight requests may overshoot. |
| `LIFETIME_BUDGET_USD` | 4 × `RUN_BUDGET_USD` | Cumulative ceiling across every run of the process, must be > 0. `POST /api/run/start` is refused (403) once reached. |
| `AGENT_MODEL_ATLAS` … `_SENTRY` | provider default | Per-agent model id; Anthropic/mock default to `claude-opus-5`. |
| `EFFORT` | `high` | Reasoning effort: `low` `medium` `high` `xhigh` `max`; OpenAI also supports `none`. |
| `MAX_ITERATIONS_PER_TURN` | `24` | Model calls one agent may make per wake. |
| `MAX_TURNS_PER_AGENT` | `60` | Wakes one agent may take per run. |
| `MOCK_SPEED` | `1` | Multiplier on the mock's pacing; `0` is instant. |
| `AUTO_START` | on when mock | Start the run at boot. `0`/`false` forces off. |
| `PORT` | `8787` | Server port. |
| `HOST` | `127.0.0.1` | Interface to listen on. `0.0.0.0` exposes the unauthenticated server to your network — opt in deliberately. |
| `STATIC_DIR` | `dist` if present | Directory of built client files to serve. |

A `.env` file in the repo root is read at boot; values already in the environment win.
Invalid values fail the boot with a message naming the variable.

## What the agents can do

Every agent uses the selected provider model with a fixed persona, woken by the orchestrator with a task and
a set of tools. **The repository and toolchain they act on are an in-memory simulation** — a
virtual `helios/api` on branch `feat/passkey-auth` seeded from `server/seed/`. Nothing touches
your filesystem, shell, network or git; `pnpm test` is a deterministic function of the virtual
file contents, not a process.

| Tool | Who | Does |
| --- | --- | --- |
| `run.assign` | Atlas | Give a worker a subtask and wake them. |
| `run.handoff` | Atlas | Record a handoff and wake the receiver with a note. |
| `run.set_phase` | Atlas | Advance spec → build → test → review → ship; posts a divider. |
| `run.read_status` | Atlas | Every agent's status, the diff, last test result, open PR comments. |
| `run.request_merge` | Atlas | Check current revision evidence, then merge or hold for human approval. |
| `run.finish` | Atlas | Complete only if the simulated PR is already merged; never initiates a merge. |
| `agent.progress` | workers | Update pct / subtask / eta / files for the sidebar. |
| `agent.done` · `agent.blocked` | workers | Report the subtask finished or stuck; Atlas is woken. |
| `agent.queue` | workers | Note a follow-up item. |
| `repo.list` · `repo.read` · `repo.diff` | workers | Inspect the virtual repo. |
| `repo.write` · `repo.patch` | Forge, Probe | Whole-file write or exact find/replace edits. |
| `repo.push` · `repo.rollback` | Forge | Commit to the branch, or discard back to the last push. |
| `shell.run` | Forge, Probe | `pnpm typecheck` `lint` `test` `e2e` (optionally `--grep`). Nothing else runs. |
| `db.migrate` | Forge | Write and apply a SQL migration. |
| `docs.write` · `docs.read` | Vector / workers | ADRs and threat models under `docs/`. |
| `web.fetch` | Vector, Sentry | Curated WebAuthn/passkey reference summaries (simulated). |
| `artifact.get` | Probe | The last failing-test trace. |
| `sec.scan` | Sentry | Dependency, secret and storage-safety scan. |
| `pr.comment` · `pr.resolve` · `pr.review` | Sentry | Review comments (blocking ones hold the merge) and the verdict. |

The composer understands `/approve merge`, `/assign <agent> <task>`, `/rollback build`,
`/pause` and `/resume`; anything else is posted to the room (or DM'd to one agent) and the
target is woken with it.

## Completion and approval

The simulator merges only a pushed revision with a clean working tree, an explicit positive
Sentry review, passing full e2e coverage (all 24 cases), and no unresolved blocking comments.
Unit tests, a passing subset, zero matched cases, old tests and old reviews cannot satisfy
this gate. A filter such as `--grep passkey` is valid only if it selects all 24 cases.

Edits, migrations, document changes, pushes and rollback invalidate tests and review. Human
approval is tied to the same revision; approving before evidence exists cannot pre-authorize
future work. A review or merge request returned by a model after a revision change is rejected.
Atlas can inspect revision evidence and merge readiness through `run.read_status`.

With **Approve before merge** enabled, `run.request_merge` holds a valid revision in
`needs_approval`. The human's **Approve merge** control rechecks the evidence and merges that
revision. Disabling the gate releases a valid held merge. Successful merge immediately ends
the run as `done`; no additional model request is needed. `run.finish` only acknowledges an
existing merge. Failed prerequisites and rejected merges stay incomplete.

Both `done` and `failed` cancel outstanding work, drop queued wakes and stop late tool effects,
stream updates and task mutations. Restart creates a new run identity; stale responses cannot
change it. An unrecoverable provider error from any agent explicitly fails the run. Human
interruption cancels that agent's turn, keeps the run live (or paused), and allows another
human message. Pause holds subsequent model requests and tool dispatch until resume.

Tool access is enforced from `TOOL_CATALOGUE` both at dispatch and inside the registry,
including direct execution: Atlas cannot execute `repo_write` or other worker tools.
All repository, test, review and merge operations described here remain simulated.

## Cost

With Anthropic, every agent defaults to Opus 5 at high effort. Spend is metered from the API's usage numbers
(input, output, cache read at 0.1×, cache write at 1.25× — `server/llm/pricing.ts`) and shown
in the header; when it reaches `RUN_BUDGET_USD` the run stops with status `failed`. That
reported-usage limit resets with every **Start run**, so `LIFETIME_BUDGET_USD` (default 4× the per-run
budget) prevents further starts once total reported spend across the server process reaches it — starting another
run is refused until the server restarts. System prompts are frozen per persona so they cache
across turns; watch the counters on your first real run before raising either limit.

Usage is checked immediately after every response, including text-only responses. This is
**enforcement based on reported usage, not a promise of zero overshoot**: concurrent requests
may already have incurred cost before cancellation arrives. Known usage from completed or
partially reported requests is retained even after interruption or termination. Usage arriving
from an older run counts toward the lifetime ledger without charging the new run. Unreported
usage cannot be metered locally. The console marks missing usage as **usage unknown** and the
reported cost as a lower bound; this uncertainty remains visible across run resets in the
lifetime counter. Budgets cannot enforce unreported spend. Anthropic requests use `fallbacks: 'default'` to enable provider-side
fallback for refusals or capacity problems. An unrecoverable provider failure after fallback
and retries fails the run explicitly.

OpenAI pricing is separate from the Claude fallback. The supported profile is $4 per million
ordinary input tokens, $0.40 cached input, $5 cache-write input, and $20 output, including
reasoning tokens. Above 272,000 total input tokens, the whole request uses 2× input rates
(including caches) and 1.5× output. Cache categories are subtracted from API input totals so
they are charged once; reasoning tokens are already in output. These promotional model rates
were verified on 2026-09-05 and are documented through at least 2026-11-21; recheck before
later paid acceptance. Sources: [model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
and [cache accounting](https://developers.openai.com/api/docs/guides/prompt-caching).

## HTTP / SSE API

All JSON, no framework. Every POST returns `{ ok: true, seq }` or `{ ok: false, error }`
(400 bad body or URL, 403 cross-site request or lifetime budget reached, 404 unknown route,
405 wrong method, 413 body over 64 KB, 415 `/api/message` without `Content-Type: application/json`,
429 more than 5 messages in a burst or 1/s sustained, 500 handler error). POSTs must be
same-origin: a request carrying an `Origin` whose host differs from `Host`, or
`Sec-Fetch-Site: cross-site`, is refused; requests without those headers (curl) pass.

| Route | Body | Effect |
| --- | --- | --- |
| `GET /api/events` | — | SSE. First event is `snapshot`; then one event per `RunEvent`, `event:` = type, `id:` = seq. `: ping` every 15 s. Reconnects get a fresh snapshot. |
| `GET /api/state` | — | The current `RunSnapshot`. |
| `POST /api/message` | `{ body, target }` | Human message to `all` or one agent id; slash commands parsed here. |
| `POST /api/run/start` | — | (Re)start from a clean workspace. |
| `POST /api/run/pause` · `resume` | — | Stop / continue waking agents. |
| `POST /api/run/gate` | `{ enabled }` | Hold the merge for a human, or auto-release. |
| `POST /api/run/approve` | — | Recheck the held revision, merge and complete; early approval applies only to currently valid evidence. |
| `POST /api/agents/:id/interrupt` | — | Abort that agent's in-flight model call. |

Types for all of it live in [`shared/protocol.ts`](shared/protocol.ts); the wire is the only
coupling between client and server.

## Verification

`npm test` uses Node's test runner with the existing TypeScript loader; no paid calls are made.
The tests cover tool permissions, revision evidence, approval, completion, cancellation races,
restart isolation, provider failures, interruption, configured effort, reported budgets and
HTTP protections. Both provider adapters use the installed official SDKs with injected offline transports.
OpenAI tests include the complete simulated story, human gate, pause/resume, failure,
interruption, restart isolation, continuation, usage, and pricing boundaries.

```bash
npm ci
npm run build
npm test
node dist-server/server/seed/selfcheck.js
git diff --check
```

GitHub Actions runs locked installation, build/typechecks, regressions and simulator selfchecks
on runtime-branch pushes, pull requests into main and pushes to main. It does not deploy.
For manual browser verification, start the mock with `AUTO_START=0`, exercise Start/Pause/Resume,
wait for Approve merge, and confirm DONE with no active agents. Use a separate mock process
with `RUN_BUDGET_USD=0.000001` to check the FAILED banner. Interrupt an active agent from its
Subtask panel and confirm the output log says “interrupted by human” without failing the run.

For an OpenAI-identity browser smoke check with no API access, after building run:

```bash
npm run smoke:openai
# open http://127.0.0.1:8791
```

This test-only entry point drives the real OpenAI SDK/adapter with the scripted story and
injected responses. It cannot contact OpenAI, reads no `.env` file or API key, and is excluded
from the production server build. `SMOKE_FAIL=1` produces an offline failure; `MOCK_SPEED=0`
makes the story instant. Offline fixtures verify application behavior, not real model quality
or account access. A paid OpenAI acceptance run and real Codex repository execution remain
separate follow-ups. All workspace, shell, Git, test and PR tools remain simulated.

## Architecture

```
shared/protocol.ts     wire types: RunSnapshot, RunEvent, commands, API paths
server/
  contracts.ts         module interfaces + the tool catalogue (names, schemas, access)
  config.ts            env → Config, validated
  index.ts             composition root: .env, wiring, healthcheck, signals
  http.ts              node:http routes, SSE fan-out, static files
  run.ts               RunStore: state, seq-numbered event log, stats
  pipeline.ts          derives the board lanes and steps from tasks + phase
  orchestrator.ts      wake queue, agent loops, tool effects, gate, budget
  agents.ts            the five personas and their frozen system prompts
  tools.ts             executes catalogue entries against a Workspace
  workspace.ts         the in-memory helios/api repo and simulated toolchain
  seed/                the repo's starting files and the e2e fixtures
  llm/                 anthropic.ts · openai.ts (Responses) · mock.ts (scripted) · pricing.ts
src/
  AgentChatroom.tsx    the console, driven by the SSE feed
  components/          RunHeader · AgentSidebar · ChatPanel · ThreadItemView
                       PipelinePanel · AgentDetail
  lib/theme.ts         colour tokens, tint(), status/level/tool colour maps
  styles.css           all static styling; dynamic colour arrives as CSS custom properties
```

## Layout

| Region | Width | Contents |
| --- | --- | --- |
| Header | full · 58px | Run state (live/paused), elapsed time, token and cost counters, run controls |
| Agent sidebar | 288px | Five agents with status, current subtask and progress; human-oversight toggles |
| Chat thread | fluid | Phase dividers, agent messages, expandable tool calls, handoffs, human broadcasts |
| Detail pane | 404px | Pipeline tracker (Board / Steps) over the selected agent's detail tabs |

The detail pane collapses to a 46px rail via **Hide detail** or the ✕ in the pane header.
