# Agent Chatroom

A multi-agent run console: five Claude-backed agents ship a feature together while a human
operator watches the room, messages agents, holds the merge gate, and pauses the run.

Built with Vite + React + TypeScript on the client and a dependency-free Node server. The UI is
a faithful port of the Claude Design prototype in
[`project/Agent Chatroom.dc.html`](project/Agent%20Chatroom.dc.html) — see
[`docs/HANDOFF.md`](docs/HANDOFF.md) and [`chats/`](chats) for the original brief.

The layout has a hard floor of 1180 × 700 — it is a desktop console, not a responsive site.

## Running it

Requires Node 22 or newer.

```bash
npm install
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

On boot the server checks that the Atlas model is reachable with your credentials. If it is
not, the run is marked `failed` with the reason and the dashboard shows it in a banner — the
server keeps serving so you can fix the key and restart the run.

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
| `ANTHROPIC_API_KEY` | — | Credentials. `ANTHROPIC_AUTH_TOKEN` and an `ant auth login` profile also work. |
| `MOCK_LLM` | off | `1`/`true` drives the run with the scripted mock instead of a model. |
| `RUN_BUDGET_USD` | `5` | Hard cost ceiling per run, must be > 0. The run stops (`failed`) when reached. |
| `LIFETIME_BUDGET_USD` | 4 × `RUN_BUDGET_USD` | Cumulative ceiling across every run of the process, must be > 0. `POST /api/run/start` is refused (403) once reached. |
| `AGENT_MODEL_ATLAS` … `_SENTRY` | `claude-opus-5` | Per-agent model id. |
| `EFFORT` | `high` | Reasoning effort for every agent: `low` `medium` `high` `xhigh` `max`. |
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

Every agent is a Claude model with a fixed persona, woken by the orchestrator with a task and
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
| `run.request_merge` | Atlas | Merge the PR, or hold for the human when the gate is on. |
| `run.finish` | Atlas | End the run with a summary. |
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

## Cost

Every agent defaults to Opus 5 at high effort. Spend is metered from the API's usage numbers
(input, output, cache read at 0.1×, cache write at 1.25× — `server/llm/pricing.ts`) and shown
in the header; when it reaches `RUN_BUDGET_USD` the run stops with status `failed`. That
ceiling resets with every **Start run**, so `LIFETIME_BUDGET_USD` (default 4× the per-run
budget) caps the total across all runs of one server process — once reached, starting another
run is refused until the server restarts. System prompts are frozen per persona so they cache
across turns; watch the counters on your first real run before raising either ceiling. Requests are sent with `fallbacks: 'default'`, so a
refusal or capacity problem on the primary model is rerouted server-side rather than ending
the run.

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
| `POST /api/run/approve` | — | Release a held merge. |
| `POST /api/agents/:id/interrupt` | — | Abort that agent's in-flight model call. |

Types for all of it live in [`shared/protocol.ts`](shared/protocol.ts); the wire is the only
coupling between client and server.

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
  llm/                 anthropic.ts (streaming, fallbacks) · mock.ts (scripted) · pricing.ts
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
