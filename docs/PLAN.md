# Agent Chatroom roadmap

Current plan reconciled September 8, 2026. Read `docs/STATUS.md` and the
[visual progress record](../project-progress/index.html) for evidence and blockers.
Historical execution prompts and timing estimates from the
[September 5 plan](https://github.com/DaveHomeAssist/agent-chat/blob/a346ef090aca2fa6d1d6b197b61a2110dc88a5ee/docs/PLAN.md)
are superseded. They do not authorize credentials, paid runs, hosting changes,
Notion writes or scheduled agents.

## Product goal

Five agents deliver a real feature in an isolated GitHub repository, with a human
merge gate, visible spending controls, durable runs and an authenticated remote
console. Reported-usage limits are not a guarantee of zero billing overshoot.

## Delivered foundation

- PR #1: React console, orchestration, streaming and simulated workspace.
- PR #2: runtime correctness, revision-bound merge evidence, permissions,
  cancellation, restart isolation and reported usage accounting.
- PR #3: opt-in OpenAI Responses provider using the existing simulated tools.
  Anthropic remains the application default; mock runs remain offline.
- PRs #5–7: durable visual progress document, light mode, filtering, sorting and
  fixed-height pagination. These are documentation capabilities, not M1 acceptance.
- Acceptance tooling: `npm run smoke:real` now performs environment preflight and
  an explicitly requested pair of real OpenAI runs. Offline regression tests prove
  the runner; the separate Sep 8 single-call probe proves provider access only.
- Snapshot: current-run public JSON export is implemented and browser verified.
  A useful paid proposal cost $0.113582; see [probe evidence](USEFUL_MODEL_PROBE.md).

## Parallel executor delivery

Dave designated the current Codex session as orchestration only. The
[coordination runbook](../coordination/ORCHESTRATOR.md) records ownership and the
[starter prompts](../coordination/START_HERE.md) launch persistence, authentication
and verification sessions. Persistence/authentication design reviews now have
isolated module implementation assignments. Browser regression infrastructure is
proposed in [PR #11](https://github.com/DaveHomeAssist/agent-chat/pull/11), awaiting
review and merge after passing Linux Node 22 CI. Shared runtime wiring still
requires the coordinator's sequential integration assignment.

The durable local SQLite queue stores immutable assignments/reports, leases,
reconciliation decisions and event cursors. Sixteen offline protocol tests pass,
including two independent worker processes. Native Codex messages and an active
five-minute coordinator heartbeat provide dispatch/recovery. The queue now records
real local registrations, initial reports and follow-up claims. Claude's cloud
verification review could not access the Mac-local queue, so local verification is
assigned through a supported Codex subagent transport. An active local Claude Code
session can use bounded polling, but sleeping external chats have no verified
automatic launcher or cloud bridge. No new application API allowance is included.

The verification worker later owns integration, shared wiring, status records and
sequential merges. This communication infrastructure is separate from the product
milestones below; it does not make the application's simulated tools execute Git.

## Milestones, in dependency order

| Milestone | Work | Required acceptance |
| --- | --- | --- |
| M1 — real model proof | Verify exported credentials, model access and current budgets; execute the acceptance runner against the virtual workspace | Two consecutive runs with complete reported usage, below each run limit, reaching the held human gate with current merge evidence; saved event transcripts and reports |
| M2 — unattended operation | Durable event storage, restart replay/resume, API/SSE auth, historical run API/picker, exports, browser CI and remaining console controls | Mid-run process crash followed by verified recovery; authenticated API access; browser regression gate |
| M3 — real repository | Isolated filesystem/Git adapter, restricted commands, configurable goals, GitHub PR integration and throwaway test repository | Agent-created real feature PR, real tests and current review evidence; merge held until human approval |
| M4 — remote deployment | Select host, container/runbook, persistent storage, secrets and HTTPS | Authenticated remote/phone access; deployed mock and budgeted real acceptance; verified provider state and documentation |

All future completion dates are unscheduled.

## M1 execution contract

See [Real model acceptance](REAL_MODEL_ACCEPTANCE.md) for commands and report format.
The initial runner targets the already-supported OpenAI provider/model. It does not
change the application's default provider or add a Codex repository execution adapter.

Provider access was demonstrated by one separately authorized useful request on
Sep 8. It does not authorize additional calls or replace the following two-run gate.

1. Run `npm run smoke:real -- --check`. This checks exported environment only;
   it makes no network requests and does not load `.env`.
2. Verify the intended account, supported model and currently approved budgets.
   Preflight is not account acceptance. Recheck pricing before a paid run.
3. Explicitly execute `npm run smoke:real -- --execute` in that environment.
   It checks every configured model, runs twice sequentially, and stops at the
   first failure. It neither approves nor merges the simulated PR.
4. Inspect `runs/acceptance-*/result.json`, per-run JSONL, JSON and Markdown reports.
   A timeout, interrupted request, unknown usage, invalid gate, provider failure,
   exhausted budget or incomplete request accounting prevents acceptance.
5. Record reviewed, non-sensitive run IDs, revision, costs and acceptance results
   in the status ledger. Raw artifacts remain ignored until deliberately reviewed
   for sharing. Rerun the existing build/tests/selfcheck after runtime fixes.

Reported lifetime spend is scoped to one runner invocation. Concurrent requests
can overshoot; restarting the runner does not enforce an account-wide spending cap.
Do not automatically retry failed or ambiguous billable requests.

## M2 details still outstanding

- Append durable events and prove replay/resume after process termination.
- Require authentication before remote binding; verify API and SSE authorization.
- Add historical run listing, snapshot retrieval, picker and transcript export.
  The current-run Snapshot download is delivered; historical exports still depend
  on persistent storage.
- Review and merge the seven Chromium checks proposed in PR #11; Linux CI passes.
  The suite exercises the production mock console and progress document and retains
  failure evidence; existing Node/Python regressions, typechecks, build and simulator
  checks remain. Add auth/history/recovery coverage when those flows are wired.
- Wire Reassign, correct activity-footer state and reconcile the
  remaining fidelity checklist. Provider/model labels and cache counters exist.

## M3 and M4 boundaries

Real files and commands must run in a fresh isolated workspace, never Dave's active
checkout. Commands need explicit allowlists, time/output limits and scrubbed
credentials. Git must use a run branch, with no force push or direct push to main.
Validate this design before implementing the adapter.

Hosting has not been verified. The historical Vercel reference is not evidence of
an active deployment or permission to remove one. Resolve hosting ownership and
service suitability before deployment. No hosting work is required for headless M1.
