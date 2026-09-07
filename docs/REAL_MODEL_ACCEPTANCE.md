# Real model acceptance

The runner exercises the existing OpenAI provider and orchestrator against the
simulated workspace. It opens no HTTP listener, changes no real repository and
never approves the merge gate. Success means two consecutive runs reach
`needs_approval` with valid current merge evidence, no active provider calls,
complete reported usage and costs below the configured limits.

## Preconditions

Use Node 22+ and `npm ci`. Export `OPENAI_API_KEY`, `RUN_BUDGET_USD` and
`LIFETIME_BUDGET_USD` through the intended runtime's secret/environment settings.
Do not paste keys into prompts or source files. This command deliberately does not
read `.env`. The supported model/profile is inherited from the application;
`OPENAI_MODEL` and `AGENT_MODEL_*` overrides must pass its existing validation.

```sh
npm run smoke:real -- --check
```

Preflight makes no network request. Missing settings return exit code 2 with names
only. Invalid values, mock mode and a non-OpenAI provider are rejected. A successful
preflight is not proof of model access, pricing, billing configuration or acceptance.

After confirming the account and approving the intended run limits:

```sh
npm run smoke:real -- --execute
```

This flag initiates billable requests. It makes metadata healthchecks for each
configured model, then performs two sequential runs with no failure retries. It
stops on the first failed run. The per-run timeout defaults to 25 minutes;
`SMOKE_TIMEOUT_MS` can reduce it (1000–1500000 ms). Defaults are medium effort,
12 wakes per agent and 12 model calls per wake. Existing `EFFORT`,
`MAX_TURNS_PER_AGENT` and `MAX_ITERATIONS_PER_TURN` settings can override these.
The timeout includes the metadata healthcheck. SIGINT/SIGTERM cancel model work
and produce a failed report; interrupted runs cannot count as acceptance.

The cumulative allowance must cover the remaining full run allowance before the
second run starts. All reported costs, including late results after cancellation,
are retained. A bounded drain waits for outstanding calls; incomplete accounting
fails acceptance. Reported costs may overshoot through concurrency or omit provider
usage that was never reported. A new invocation starts a new lifetime ledger;
use provider/account controls for account-wide limits.

## Artifacts and exit codes

Each execution creates a unique private directory under `runs/acceptance-*/`:

- `result.json`: live/offline proof label, code revision and aggregate result.
- `run-N.jsonl`: initial snapshot, timestamped application events and final snapshot.
- `run-N.json`: result, usage, request counts, agent state and final snapshot.
- `run-N.md`: readable result, cost/token summary and last task per agent.

Directories/files are private to the user (0700/0600). Outputs are ignored by Git.
The event transcript excludes raw SDK requests, provider responses and encrypted
reasoning continuation. Known credential values are redacted. Model text can still
contain sensitive material; review before sharing. Transcripts are capped at 50 MiB;
write failures stop the run and prevent acceptance.

Exit 0: two accepted runs (or successful `--check`); exit 1: execution did not meet
acceptance; exit 2: setup/configuration/runner error. The command with no arguments
prints help and makes no requests. `--check` and `--execute` cannot be combined.

## Verification boundaries

`tests/real-acceptance.test.ts` uses the real OpenAI SDK with injected offline
transport. It checks held gates, artifacts, usage, timeout cancellation, preflight,
redaction and cumulative budgets. Offline results explicitly carry `proof: offline`.
They are never evidence of paid model quality or account access.

The live runner reuses the provider's accounting of
[Responses usage](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create).
It does not alter model pricing or billing semantics.
