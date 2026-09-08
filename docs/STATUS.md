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
| Reviewed authentication module | [PR #12](https://github.com/DaveHomeAssist/agent-chat/pull/12), merged Sep 8 as `ecd1fc6`; runtime integration remains staged |
| Production browser regression CI | [PR #11](https://github.com/DaveHomeAssist/agent-chat/pull/11), merged Sep 8, `9ed160c`; seven Chromium checks and retained evidence |

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
- Those earlier local Vite checks stalled during native dependency loading.
  A fresh isolated verification checkout now passes the standard build after
  `npm ci` on Node 25.8.1; the earlier local blocker is not reproduced there.
- Current mock browser run reaches `needs_approval` after 59 tool calls. Snapshot
  does not approve it. Earlier Sep 7 evidence separately covered approval to Done.
- Hosting remains Unknown. GitHub returned no deployment records on Sep 8; that
  does not establish absence of hosting elsewhere.

## Browser regression delivery — PR #11 merged

- [PR #11](https://github.com/DaveHomeAssist/agent-chat/pull/11), merged September 8
  as `9ed160cab42685de1120b409060f07cb6669fe64`, adds seven Chromium tests to normal
  PR/main CI while retaining all existing gates. See [browser checks](BROWSER_TESTS.md).
- Local clean installation, production build/typechecks, 105 Node tests, 16 queue
  tests, 42 simulator selfchecks and all seven browser tests pass.
- Browser proof includes directed messages, pause/resume, approval held then
  released to Done, current-run Snapshot JSON, actual SSE disconnect/reconnect,
  replay deduplication and visible failures recovered by retry. All agents and
  repository operations are mocked/simulated; there are no paid application calls.
- The refreshed progress document is checked at 1440 × 1000, 390 × 844 and
  3440 × 968, including every item through pagination and all items in print mode.
- [Main Linux Node 22 CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34224608943)
  passes at merge `9ed160c`, including all seven browser tests and existing gates.
  Its [browser evidence](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34224608943/artifacts/10055179925)
  expires September 22 and production bundle September 15, unless removed earlier.
- Authentication module PR #12 is now merged; its runtime integration is staged
  separately below. Persistence PR #13 remains held outside this assignment.
  Historical runs, crash recovery, remaining controls and real repository
  execution remain incomplete.

## Authentication integration — PR #15 staged for review

- The independently reviewed module [PR #12](https://github.com/DaveHomeAssist/agent-chat/pull/12)
  merged as `ecd1fc6f4bf7ba7fa64ace38bd044b7a25658fdc`.
  [Main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34225897025)
  passes all inherited gates (133 Node tests and seven browser tests).
- [PR #15](https://github.com/DaveHomeAssist/agent-chat/pull/15) implements full
  config/HTTP/SSE/browser integration at product revision
  `95201419828760600fc2f048bc8f040c3fa5c31b`. Local production build/typechecks,
  140 Node tests, 16 coordination tests, 42 simulator checks and 17 Chromium
  tests pass. [Integration CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34227496719)
  passes at that exact revision, including all 17 browser checks. Independent
  review and merge remain required. [Browser evidence](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34227496719/artifacts/10056381681)
  expires September 22; the production bundle expires September 15, unless removed earlier.
- Default local mode rejects non-loopback binding. Session mode validates the
  operator key/public origin before listen, protects every run API before
  effects, and closes streams on expiry/revocation/disposal. Browser access is
  gated, key entry is transient, logout clears the old run view, and expired
  or 401 access stops reconnect churn. Ordinary outages recover after probing.
- Actual Chromium TLS checks verify HttpOnly/SameSite/ Secure `__Host-` cookies
  over loopback using temporary synthetic OpenSSL certificates. Tests also
  verify protected Snapshot, stale-view removal, existing local console flows,
  and login/progress rendering at desktop, mobile and ultrawide sizes.
  This is software proof, not certificate-trust, remote or deployed acceptance.
- Auth remains **In Progress**. Canonical main runtime is still unwired until
  PR #15 is reviewed and merged. Persistence #13 is not merged or wired here.
  No stored credentials, paid application calls or hosting changes are involved.

## Executor coordination delivery

- The private SQLite communication queue, worker bootstrap and coordinator runbook
  are implemented; see [coordination setup](../coordination/START_HERE.md).
- Sixteen standard-library protocol tests pass, including eight concurrent claims
  with one assignment delivery, two separate worker processes, interrupted-report
  rollback, stale-lease quarantine, persisted decisions/cursors and quiet idle cycles.
- The real queue initially contained coordinator metadata only. It now holds actual
  executor registrations and assignments, not fixtures. Live state remains outside
  Git, with directory mode 0700 and DB mode 0600. No model API calls are made by
  this communication system.
- Native Codex claim/report/follow-up cycles are verified. Local verification also
  completed a browser implementation report, then claimed the coordinator's merge
  follow-up through the optional [subagent transport](../coordination/README.md#optional-local-codex-subagent-transport).
  Claude's cloud review reported but could not reach the Mac-local queue; its lack
  of local registration did not mean it had not launched. The coordinator routes
  local execution through supported task/subagent messages. Sleeping external
  Claude/browser chats still have no verified automatic launcher or cloud bridge.
- Implementation workers own isolated PRs; the verification/integration executor
  owns shared wiring, progress records, sequential merges and final acceptance.
  This infrastructure does not complete product persistence, auth or real Git work.
- Earlier paid-model and hosting claims above retain their original evidence dates.
  Fresh main CI proves the offline build/runtime/browser scope only.

## Remaining milestones

| Milestone | State | Next action / dependency |
| --- | --- | --- |
| M1 real-model acceptance | Partial | Provider access demonstrated; explicitly approved two-run budgets and runner environment still needed |
| M2 unattended operation | Partial | Current-run Snapshot and browser CI delivered; persistence/recovery, auth, historical runs and remaining console controls |
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

- Sep 8: Durable external executor coordination added, with offline process tests.
  Local workers subsequently registered and claimed product module/browser work;
  implementation PRs and integration remain separate acceptance.
- Sep 8: PR #11 browser regression CI merged and main checks passed. Native task
  and local subagent follow-up transport are verified; no Claude cloud bridge is implied.

- Sep 8: Reviewed auth module PR #12 merged with passing main CI. Full runtime
  integration is staged in PR #15 for independent review; auth is not yet Complete.

Future delivery dates are unscheduled. Update this file and structured visual
status after meaningful changes under the root AGENTS.md contract.
