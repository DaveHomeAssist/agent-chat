# Agent Chatroom status

Refreshed September 8, 2026. [Visual progress](../project-progress/index.html) ·
[Current roadmap](PLAN.md) · [Acceptance commands](REAL_MODEL_ACCEPTANCE.md).
The historical Phase 0 refresh in PR #4 is superseded by this reconciliation.

## Delivered

| Work | Evidence |
| --- | --- |
| Simulated five-agent console | PR #1, merged Sep 4, `2109a85` |
| Runtime correctness and review fixes | PR #2, merged Sep 5, `5f42411` |
| OpenAI Responses provider | PR #3, merged Sep 5, `a346ef0` |
| Visual progress document, light mode, filters and pagination | PRs #5–7, merged |
| Real-model acceptance runner | PR #8, merged; implementation `4042e34`; offline validation complete |
| Useful paid model probe and Snapshot export | [PR #9](https://github.com/DaveHomeAssist/agent-chat/pull/9), code `0fc51ca`; [receipt and browser evidence](USEFUL_MODEL_PROBE.md) |

## Snapshot delivery evidence (earlier Sep 8 checks)

- One authorized OpenAI proposal request cost **$0.113582**, calculated from reported
  usage, within a $0.50 allowance. It produced the Snapshot implementation proposal.
  No retries or additional paid requests. This is not full M1 acceptance.
- Snapshot exports fresh public run JSON, preserves the approval gate, handles
  failures and cleans up download resources. Browser checks include a 501-line log
  fixture, duplicate clicks, HTTP failure/retry, timeout and download failure.
- 105 Node tests, all typechecks and 42 simulator checks pass locally.
- [Linux CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34208042574)
  passes clean installation and the standard production build/tests/selfchecks.
  Browser acceptance used its production bundle with the mock server.
- Local Vite also stalls on unchanged main during native dependency loading.
  Local production build remains environment limited; CI build is verified.
- Current mock browser run reaches `needs_approval` after 59 tool calls. Snapshot
  does not approve it. Earlier Sep 7 evidence separately covered approval to Done.
- Hosting remains Unknown. GitHub returned no deployment records on Sep 8; that
  does not establish absence of hosting elsewhere.

## Executor coordination delivery

- The private SQLite communication queue, worker bootstrap and coordinator runbook
  are implemented; see [coordination setup](../coordination/START_HERE.md).
- Sixteen standard-library protocol tests pass, including eight concurrent claims
  with one assignment delivery, two separate worker processes, interrupted-report
  rollback, stale-lease quarantine, persisted decisions/cursors and quiet idle cycles.
- The real queue was initialized with coordinator metadata only: no fixture workers
  or assignments. Live state remains outside Git, with directory mode 0700 and DB
  mode 0600. No model API calls are made by this communication system.
- The native five-minute coordinator heartbeat is active. Real registered executor
  wakeup has not yet been exercised; starter prompts await initial executor sessions.
  Sleeping external Claude/browser chats have no verified automatic launcher.
- Implementation workers own isolated PRs; the verification/integration executor
  owns shared wiring, progress records, sequential merges and final acceptance.
  This infrastructure does not complete product persistence, auth or real Git work.
- Earlier product runtime/browser and hosting claims above retain their original
  evidence dates. This coordination change does not reverify the entire application.

## Remaining milestones

| Milestone | State | Next action / dependency |
| --- | --- | --- |
| M1 real-model acceptance | Partial | Provider access demonstrated; explicitly approved two-run budgets and runner environment still needed |
| M2 unattended operation | Partial | Current-run Snapshot delivered; persistence/recovery, auth, historical runs, browser CI and remaining console controls |
| M3 real repository | Not started | Isolated Git/command adapter and sandbox PR acceptance after M2 |
| M4 remote deployment | Not started | Hosting decision, persistence, auth, HTTPS and deployed acceptance after M3 |

Credentials remain in local secret storage. The single probe allowance is not
permission for further billable calls. Budget accounting may overshoot with
concurrent requests. Raw acceptance artifacts remain private and require review
before sharing. No application real-repository run or hosting change was performed.

## Historical completion log

- Sep 4: PR #1 merged.
- Sep 5: PR #2 runtime correctness and PR #3 OpenAI provider merged.
- Sep 6: PRs #5–7 added the project progress document and controls.
- Sep 7: PR #8 delivered the real-model runner, verified offline; credentials and
  budgets were absent in that execution environment at that time.
- Sep 8: Provider access proved with one useful paid proposal. Snapshot implemented
  and verified; the prior statement that no paid call had occurred is superseded.

- Sep 8: Durable external executor coordination added, with offline process tests;
  native worker wakeup and actual product assignments remain separate acceptance.

Future delivery dates are unscheduled. Update this file and structured visual
status after meaningful changes under the root AGENTS.md contract.
