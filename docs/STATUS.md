# Agent Chatroom status

Refreshed September 7, 2026. [Visual progress](../project-progress/index.html) ·
[Current roadmap](PLAN.md) · [Acceptance commands](REAL_MODEL_ACCEPTANCE.md).
The historical Phase 0 refresh in PR #4 is superseded by this reconciliation.

## Delivered

| Work | Evidence |
| --- | --- |
| Simulated five-agent console | PR #1, merged Sep 4, `2109a85` |
| Runtime correctness and review fixes | PR #2, merged Sep 5, `5f42411` |
| OpenAI Responses provider | PR #3, merged Sep 5, `a346ef0` |
| Visual progress document, light mode, filters and pagination | PRs #5–7, latest merged main `c61603f`; user HTML edits preserved in original checkout |
| Real-model acceptance runner | `scripts/smoke-real.ts` and `scripts/real-acceptance.ts`; implementation revision `4042e34`; offline tests pass |
| Current roadmap/ledger reconciliation | Historical instructions replaced with current milestones and explicit acceptance boundaries |

## Verified in this delivery

- Production build and typechecks pass.
- 101 Node tests pass, including 12 runner regressions; all 42 simulator checks pass.
- Offline OpenAI browser: 59 tool calls; `needs_approval` then `done` after explicit
  fixture approval; no remaining active agents. This is simulated evidence.
- `npm run smoke:real -- --check` exits 2 with the three missing names below.
- GitHub API is reachable. CI for main `c61603f` passed; new delivery CI and merge
  state are owned by the acceptance PR, not inferred from that earlier result.
- No GitHub deployment records returned. Historical Vercel state remains Unknown.

## Remaining milestones

| Milestone | State | Next action / dependency |
| --- | --- | --- |
| M1 real-model acceptance | Blocked on environment; tooling delivered | Supply OPENAI_API_KEY, RUN_BUDGET_USD and LIFETIME_BUDGET_USD in the intended runner environment, then execute two budgeted runs |
| M2 unattended operation | Not complete | Persistence/recovery, auth, run history/export, browser CI and remaining console controls |
| M3 real repository | Not started | Isolated Git/command adapter and sandbox PR acceptance after M2 |
| M4 remote deployment | Not started | Hosting decision, persistence, auth, HTTPS and deployed acceptance after M3 |

No paid OpenAI generation, real repository execution, hosting change or Notion write
was performed. Environment presence was checked by name only; no secret values were
printed. Budgets use reported usage and can overshoot with concurrent requests.
Raw acceptance artifacts live under ignored `runs/`; review before sharing.

## Historical completion log

- Sep 4: PR #1 merged.
- Sep 5: PR #2 runtime correctness and PR #3 OpenAI provider merged. Historical
  claims that these were awaiting delivery are superseded.
- Sep 6: PRs #5–7 added the project progress document and controls.
- Sep 7: Real-model runner implemented and verified offline; current environment
  lacks the credentials and budget variables required to execute it.

Full historical instructions and logs remain in Git history. No future delivery
dates are scheduled. Update this file and structured visual status after meaningful
changes under the root AGENTS.md contract.
