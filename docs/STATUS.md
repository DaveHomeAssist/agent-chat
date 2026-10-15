# Agent Chatroom status

Reconciled September 14, 2026 from current Git/CI and final design-review readback.
Product CI executed September 10; PR #26 CI executed earlier September 14. This
status-only closeout verifies the report surface separately, without local runtime reruns.
[Visual progress](../project-progress/index.html) ·
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
| API/SSE/browser authentication | Module [PR #12](https://github.com/DaveHomeAssist/agent-chat/pull/12) (`ecd1fc6`) and runtime [PR #15](https://github.com/DaveHomeAssist/agent-chat/pull/15) (`e5dc358`), merged Sep 8; main CI and independent review pass |
| Durable storage module | [PR #13](https://github.com/DaveHomeAssist/agent-chat/pull/13), merged Sep 8 as `6b984db`; runtime/history/resume remain pending |
| Queue lease caller correction | [PR #16](https://github.com/DaveHomeAssist/agent-chat/pull/16), merged Sep 8 as `e48bc17`; 17 protocol checks pass |
| Production browser regression CI | [PR #11](https://github.com/DaveHomeAssist/agent-chat/pull/11), merged Sep 8, `9ed160c`; seven Chromium checks and retained evidence |
| Explicit Message/Interrupt acceptance | [PR #18](https://github.com/DaveHomeAssist/agent-chat/pull/18), merged Sep 8 as `1a7819f`; actual 409 draft retention and no-effect refusals verified |
| Truthful console controls and activity | [PR #19](https://github.com/DaveHomeAssist/agent-chat/pull/19), merged Sep 8 as `78f84fc`; token disclosure and dynamic PR labels; presentation extended by PR #22 below |
| Responsive light/dark console | [PR #22](https://github.com/DaveHomeAssist/agent-chat/pull/22), merged Sep 8 as `8419cb9`; 41 Chromium cases and independent presentation review pass |
| Client command admission, draft protection and bounded refresh | [PR #24](https://github.com/DaveHomeAssist/agent-chat/pull/24), externally merged Sep 10 as `dcf2ff26`; corrected source independently accepted, 209 Node / 49 Chromium product CI passes |

## M1 deadlock fixes: October 14 (branch `fix/m1-deadlock-wake-cap-layout`)

- Product commit `ce33f8c3aa675f07c8e94e376e5ca1b4dbcc9155`, built on `f08b4e2`, fixes
  both causes of the failed run below. No paid request was made; M1 stays **Blocked**
  until a paid run passes.
- **Wake cap.** `MAX_TURNS_ORCHESTRATOR` gives Atlas its own cap (app default: the
  per-agent cap; `scripts/real-acceptance.ts` sets 48 next to the workers' 12). A run
  with nothing in flight, every inbox empty and at least one wake discarded at a turn
  cap now ends as `failed` with `Run stalled: no agent can be woken — <agent> reached
  its turn cap N with K undelivered wakes ([REPORT from=forge kind=done], …)` instead
  of idling to the runner's timeout. A live run that is merely waiting for a human
  (nothing dropped) is unchanged.
- **Layout coupling.** `server/workspace.ts` now derives the register and login steps
  from what was pushed: any non-test `.ts` file that mentions WebAuthn/passkey/FIDO
  and is either named for the step or contains a passkey route literal
  (`/auth/passkey/register`, `/webauthn/login`) mounts it; any migration creating a
  table whose name contains `credential`, `passkey` or `webauthn` is the credentials
  migration; the replay-guard and credential-id rules follow those files. The seed's
  own `/auth/login` and `/auth/otp/verify` routes still fail every case with 404.
  Documented in [REAL_MODEL_ACCEPTANCE.md](REAL_MODEL_ACCEPTANCE.md).
- Offline evidence October 14 on this Mac: build/typechecks, **222 Node tests (6 new:
  5 fail against the previous source, the seed-404 guard passes on both), 17 queue
  tests and 42 simulator checks** pass. The new orchestrator test reproduces run 1
  (Atlas capped at 1, Forge's `agent_done` dropped): the previous source stays `live`
  until the test's 3-second timeout; the fix ends it `failed` with the reason. The new
  workspace test pushes run 1's layout (`services/auth/passkey/{register,login,counter}.ts`,
  `0043_webauthn` creating `webauthn_credentials(credential_id BYTEA …)`): 0/24 before,
  24/24 after. Browser CI remains the Chromium gate.

## M1 simulator fidelity and idle-run failure: October 15 (offline evidence)

- Fixes the two causes of the second paid run, offline only; M1 stays **Blocked**
  until a paid run passes. Product change on this branch:
  - `server/workspace.ts`: `pnpm e2e` collects every `test()`/`it()` the branch adds in
    `e2e/` spec files (file, line, describe title, Playwright project), honours `--grep`
    against those names, seeds per-case durations by the sha under test and tallies
    the canonical 24 separately for the merge gate (`TestSummary.suite`); `pnpm test`
    lists only the `*.test.ts` files in the tree with their real case counts.
  - `server/orchestrator.ts`, `server/config.ts`, `scripts/real-acceptance.ts`:
    `IDLE_RUN_FAILS_AFTER_MS` (console default 0, acceptance default 60000) ends a
    live run whose agents are all idle or blocked with nothing queued, with a
    `Run idle: …` reason quoting Atlas's last message.
- Offline evidence, local, this commit: build/typechecks; 227 Node tests (5 new:
  collected specs and `--grep`, step-rule grouping, real vitest listing, idle-run
  failure on and off; the seed-404 test updated for the collected case); 17 queue
  tests; 42 simulator selfchecks from source and from the built bundle. CI is the
  browser gate.

## Second paid M1 run: October 15 (failed)

- Executed by Dave at 00:38 EDT on `434a304` (main with PR #31) with the same settings
  as the first run (Anthropic, `claude-opus-5-5` for all five agents, effort medium,
  $5 run / $12 lifetime, fresh key verified with a 200 from `/v1/models`). Result:
  **FAIL, 0/2 runs accepted**. Run 1 timed out at 25 minutes with $4.602010 reported,
  151 model requests, 249 tool calls, accounting complete, no unreported requests, no
  unpriced models. Reports: `runs/acceptance-vL6VkK/` (private, untracked).
- PR #31 held. No agent reached a wake cap and nothing was dropped. The simulated
  `pnpm e2e` reported 24/24 on the first push `de2708b`, whose layout was
  `services/auth/passkeys/*` with `/auth/passkeys/*` routes, so the layout coupling is gone.
- New blocker, simulator fidelity. The agents distrusted the green result and were
  right to: the suite replays the same 24 case names and durations on every commit,
  `pnpm e2e --grep <their own spec name>` returns 0/0, and `pnpm test` lists test files
  that are not in the tree. Atlas escalated to the operator four times ("only you can
  clear it"), refused to request merge on unverified results, and at 04:51:24Z every
  agent went idle waiting for a human. The headless runner has no human, and the
  stall detector added in PR #31 only fires on dropped wakes, so the run idled 12
  minutes to the timeout.
- Also seen: `repo_read` truncates files near 6 KB, which cost Vector (run 1) and Sentry
  (run 2) extra turns; Probe has no push tool and routes every spec through Forge.
- M1 stays **Blocked**. Next fix: derive e2e and vitest output from the pushed tree
  (the agents' own spec and test files, varying durations), and end a headless run
  as failed when every agent is idle with nothing queued. Paid spend to date: $8.09.

## First paid M1 run: October 14 (failed)

- Executed by Dave at 19:33 EDT on code `4886bc7` with `LLM_PROVIDER=anthropic`,
  `ANTHROPIC_MODEL=claude-opus-5-5` (all five agents), effort medium, `RUN_BUDGET_USD=5`,
  `LIFETIME_BUDGET_USD=12`, a fresh key. Result: **FAIL, 0/2 runs accepted**. Run 1 timed
  out at 25 minutes with $3.490878 reported, 109 model requests, 187 tool calls,
  accounting complete, no unreported requests, no unpriced models. Run 2 never started.
  Reports: `runs/acceptance-lTW5Xf/` (private, untracked). The key should be revoked now that the run is over.
- The agents worked for 9 min 15 s (ADR written, three simulated pushes `3935ac9`,
  `8a73489`, `0688dad`, test phase reached) and then every agent sat idle for
  15 min 44 s until the timeout. Two causes, both in this repository:
  1. **Atlas wake cap.** `scripts/real-acceptance.ts` sets `MAX_TURNS_PER_AGENT=12`
     (app default 60). Atlas used its 12 wakes by 19:41:34; Forge's final `done`
     and two `blocked` reports then queued to an orchestrator that could not run,
     so the run could never reach review, ship or `needs_approval`.
  2. **Simulator layout coupling.** `server/workspace.ts` fails all 24 e2e cases with
     404 unless `services/auth/webauthn/register.ts` and `verify.ts` exist. The agent
     briefs name the goal, not the layout; Vector's ADR and Forge's code used
     `services/auth/passkey/*` and `/auth/passkey/*`, so Probe correctly reported the
     0/24 result as a stale suite and blocked. A green suite was unreachable.
- Also observed: one Anthropic content refusal on Probe's first code read (Atlas
  reassigned and continued); Forge hit the 12-calls-per-turn cap once.
- M1 is **Blocked** until a paid run passes. Both causes are fixed on
  `ce33f8c3` (section above); the $3.49 is evidence of the failure path and complete
  accounting, not of acceptance.

## Anthropic acceptance path: October 14 (merged as PR #29)

- Branch `m1-anthropic-runner`, product commit `98d0bc604894fe21c160516f6882beda09969fea`, built on `55b465e`.
  `npm run smoke:real` now requires `LLM_PROVIDER=anthropic` or `openai` plus that
  provider's own key; Anthropic runs bill the exported `ANTHROPIC_API_KEY` only.
- `server/llm/pricing.ts` adds Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 (100k
  long-prompt tier) with per-model cache-hit multipliers, checked against published
  rates October 14. Acceptance refuses configured models without exact pricing and
  fails a run whose usage reports an unpriced served model (for example a fallback).
- `ANTHROPIC_MODEL` sets the Anthropic default. The application default remains
  `claude-opus-5`: on Opus 5.5, text between tool calls arrives in thinking blocks
  that stay empty unless `thinking.display` is set, which would silence console
  narration. That migration is separate work.
- Local offline evidence October 14: build/typechecks, 216 Node tests (7 new; the
  6 affected cases fail against the previous source), 17 queue tests and 42
  simulator checks. Two local Chromium runs on the branch passed 49 and 47 of 50; an
  unmodified `55b465e` run in the same environment passed 49 of 50. Failures were
  different 12–13 second timing cases each run, the client bundle is byte-identical to
  main and mock-mode models and costs are unchanged, so CI remains the browser gate.
- Merged October 14 via [PR #29](https://github.com/DaveHomeAssist/agent-chat/pull/29) as `d5fff04` after the `validate` CI job passed. No paid request has occurred. M1 stays Partial.

## Current command delivery — PR #24

- DaveHomeAssist merged [PR #25](https://github.com/DaveHomeAssist/agent-chat/pull/25)
  on September 10 at 08:13:11 UTC as `a13fe3a`, then corrected
  [PR #24](https://github.com/DaveHomeAssist/agent-chat/pull/24) at 08:13:40 UTC as
  `dcf2ff26ece5837131121b6c82e23f147cca0a20`. These external merges occurred while
  the coordinator was interrupted; this closeout does not repeat or claim them.
- Independently accepted command source `44dfdab` is preserved in current main.
  Rendered-context/intent admission and synchronous command lanes prevent conflicting
  submissions; strict acknowledgements clear only an unchanged accepted draft.
  Newer edits, target changes, refusals and obsolete responses retain safe ownership.
- Validated contiguous stream state, a qualifying snapshot and its buffered suffix
  jointly prove command readiness. Network/synchronization and explicit Refresh
  state are bounded by a 15-second deadline. No automatic POST replay occurs.
  Composing, repeated and Shift+Enter events do not submit; Refresh retains focus
  across compact layout changes. Snapshot, safe edits, navigation and Sign out keep
  their existing behavior.
- [Exact product main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34454028618)
  executed September 10: build/typechecks, **209 Node tests, 17 queue tests,
  42 simulator checks and 49 Chromium cases** passed. September 14 readback confirms
  that result and current main; it is not a new local application test run.
  September 8 local correction evidence includes 26 deterministic controller cases,
  209 Node tests and 49 browser cases, with meaningful pre-fix failures preserved.
  Independent frontend/core review accepted the correction and PR #25 composition.
- [Product browser evidence](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34454028618/artifacts/10142752959)
  expires September 24 at 08:15:37 UTC; the production bundle expires September 17
  at 08:15:39 UTC, unless removed earlier. Availability was read back September 14.
- PR #25 derives run repository/branch and completion PR labels from the workspace,
  shares runtime vocabularies with persistence validation, isolates the auth-test
  static root and corrects earlier auth/Snapshot documentation. It does not deliver
  a real repository adapter or wire persistence into the runtime. Snapshot exports
  only retained public state, including at most 200 output-log lines per agent.
- Fidelity remains **Partial**: task transfer and real tool approval are incomplete.
  Client command safety does not provide server run fencing, durable idempotency,
  rollback, cross-tab locking or exactly-once effects. Recovery retains the hold
  below. M1 paid acceptance, M3 real tools and M4 hosting remain separate gates.
- This documentation closeout preserves all 25 IDs, historical completion dates and
  **14 Complete / 11 Remaining**. Status-file checks cover both themes at desktop,
  phone and ultrawide, working controls/pagination and all 25 print rows. They prove
  the local report surface, not deployment or refresh of an existing user tab.

## Browser refusal precondition correction — PR #26

The first September 14 documentation CI failed one existing command browser case:
Forge Interrupt returned 200 while the test assumed pausing meant no active turn.
The other 48 browser cases and all build/Node/queue/simulator gates passed. That
failure is preserved; no unchanged retry or merge bypass was used.

The [PR #26](https://github.com/DaveHomeAssist/agent-chat/pull/26) test correction
requires paused, globally empty typing and no running tool, then bounded real
Forge interrupts ending in the exact no-active-operation 409. Setup effects are
counted separately. A companion test deliberately creates parked/queued turns and
proves two accepted setup interrupts followed by 409; the measured interaction
retains five Message POSTs, one UI Interrupt 409 and no additional Forge effect.
Separating the companion case preserves the real five-message rate limit.

Both targeted cases passed three executions each; the full September 14 local
suite passed **50 Chromium cases**, with build/typechecks. Runtime source remains
unchanged at product `dcf2ff26`. PR #26 merged as `ac893045` on September 14;
[exact PR CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34837189508) and
[merged-main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34837854088)
passed build/typechecks, 209 Node, 17 queue, 42 simulator and 50 Chromium checks.
Canonical status rendering and branch preservation passed afterward. These earlier
checks remain distinct from this later design-hold readback and status rendering;
September 10 product CI and September 8 provider/hosting observations keep their dates.

## Snapshot delivery evidence (earlier Sep 8 checks)

- One authorized OpenAI proposal request cost **$0.113582**, calculated from reported
  usage, within a $0.50 allowance. It produced the Snapshot implementation proposal.
  No retries or additional paid requests. This is not full M1 acceptance.
- Snapshot exports fresh public run JSON, preserves the approval gate, handles
  failures and cleans up download resources. Browser checks include a 501-line log
  fixture (an injected API response; the server itself retains 200 log lines per
  agent), duplicate clicks, HTTP failure/retry, timeout and download failure.
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
- Later auth, storage-module and queue integrations are delivered below. Historical
  runs, crash recovery, remaining controls and real repository execution remain incomplete.

## Integrated authentication, storage module and queue delivery

- Independently reviewed auth [PR #15](https://github.com/DaveHomeAssist/agent-chat/pull/15)
  merged September 8 at 13:01:53 UTC as `e5dc358a7652d7401a7378af5949fd47b56f14ca`.
  [Auth main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34229496889)
  passed at 13:03:36 UTC. API authentication is **Complete** for this local/session
  software scope; remote deployment and accounts/roles remain separate.
- Default local mode rejects non-loopback binding. Session mode validates the
  operator key/public origin before listen, protects every run API before effects,
  and closes streams on expiry/revocation/disposal. Browser access is gated, key
  entry is transient, logout clears the old view, and auth loss stops reconnect churn.
  Ordinary outages recover after a valid session probe.
- The reviewed held-body correction revalidates authorization immediately before
  command effects after asynchronous parsing. Deterministic logout/expiry regressions
  cover all seven command paths, deny every effect and retain positive controls;
  both fail against the original source. Frontend and corrected backend independent
  reviews are accepted. Actual loopback TLS browser checks verify HttpOnly/SameSite/
  Secure `__Host-` cookies using temporary synthetic certificates. This is local
  software proof, not deployed TLS or remote/phone acceptance.
- Reviewed storage module [PR #13](https://github.com/DaveHomeAssist/agent-chat/pull/13)
  merged as `6b984dbc3a99dde9945da33e201b49d05fba74ae` after a conflict-free combined
  auth/module candidate passed build/typechecks, 167 Node tests, 16 queue tests,
  42 simulator checks and 17 Chromium tests locally. The merge tree exactly matched
  that candidate; [module main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34229864740)
  then passed the combined gates. Persistence remains **In Progress**: the module
  is not wired into the runtime; history and explicit resume are not implemented.
  V1 checkpoints cannot restore executable runner/workspace/provider continuation.
  No automatic replay, retention/deletion or real application data initialization occurred.
- [Earlier docs CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34227820287)
  exposed a leading-dash lease argument failure in the queue caller. Accepted
  [PR #16](https://github.com/DaveHomeAssist/agent-chat/pull/16) fixes the caller and
  examples and adds a deterministic renew/report regression. Its combined candidate
  passed all 17 protocol tests before guarded merge as `e48bc1744caf035056cf64178563951674a39dd5`.
  Production token generation and validation are unchanged; no unchanged failure was retried.
- [Integrated main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34230108153)
  passes at `e48bc1744caf035056cf64178563951674a39dd5`: clean installation,
  production build/typechecks, **167 Node tests, 17 queue tests, 42 simulator checks
  and 17 Chromium checks**. Browser proof includes local console controls, auth,
  Snapshot and desktop/mobile/ultrawide progress views; all agent/tool work is mocked.
  No stored credentials, paid application calls or hosting changes were involved.
- Progress now records **14 Complete / 11 Remaining** items with stable IDs and
  preserved historical completion dates. This evidence-only closeout uses integrated
  product revision `e48bc17`; documentation delivery does not create a new milestone.

## Integrated command acceptance and console improvements

- Independently reviewed [PR #18](https://github.com/DaveHomeAssist/agent-chat/pull/18)
  merged as `1a7819f39589df1b1fc8f14600664b689a3b6101`; its
  [main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34234303071) passed.
  This supersedes the earlier staged/not-merged status for that work.
- Message and Interrupt return explicit accepted/refused results. HTTP 409
  describes an unavailable run or non-interruptible operation; 200 follows only
  accepted work. Refusals leave state, events, logs, typing and tasks alone.
  Live/paused messages, recognized slash commands and one-time active aborts remain.
  Deterministic held-body state changes prove eligibility at the effect boundary;
  early auth and strict post-body logout/expiry 401 checks remain intact.
- The actual browser refusal preserves the exact original draft, shows an error,
  appends no human item and does not retry automatically. A later manual accepted
  send clears the draft. Baseline Node/browser failures were preserved. The prior
  local shared-port collision was resolved through an exclusive reservation;
  subsequent targeted and full browser suites passed without peer process changes.
- Independently reviewed [PR #19](https://github.com/DaveHomeAssist/agent-chat/pull/19)
  merged as `78f84fc1ffb50afea3af54e5d710c1e24eb83cf4`. Activity now reflects connection,
  terminal, paused, tool and model-call state. Reassign and tool auto-approval are
  visibly unavailable with reasons. Native token disclosure exposes input/output/
  cache counters by keyboard, pointer and touch; merge shortcuts reflect the run PR.
- The conflict-free combined candidate passed build/typechecks, **183 Node tests,
  17 queue tests, 42 simulator checks and 24 Chromium cases** locally. The #19 merge
  tree exactly matched that tested candidate. [Combined main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34234695533)
  passes the same gates at product revision `78f84fc`; all agent/tool work is mocked.
  Shared browser port 18787 was free before launch and after teardown.
- Fidelity remains **Partial**. Atomic task transfer and a real tool-approval contract
  remained unimplemented at that September 8 checkpoint. Client pending-action
  safety is now delivered by PR #24 above. The earlier dark-only images and
  1180px minimum-width limitation are superseded by delivered PR #22 below.
  Progress-page checks remain a separate surface from console acceptance.
- Status retains **14 Complete / 11 Remaining**, 25 stable IDs and historical dates.
  Code revision identifies the verified product merge, not a metadata commit.
  Runtime persistence/history/resume, M1 paid acceptance, M3 real tools and M4
  hosting/remote acceptance remain pending. No paid calls or hosting changes occurred.

## Recovery final-review hold

The proposed recovery contract is **held**, while the merged V1 SQLite module
remains accepted. Final independent review resolved the original provider ordinal
collision and numeric revision-type issues but found three blocking contradictions:

- A response generated at workspace revision R must retain that parent authorization
  revision; recapturing R+1 at child-tool execution must not authorize stale review.
- Valid legacy V1 provider rows with null agent and no ordinals must survive migration
  losslessly; the proposed non-null rule has no legacy exemption.
- An old checkpoint needs a defined historical usage reference point. Later runs or
  late settlements must not invalidate it, and dispatch must use current billing truth.

Private coordinator decision **persist-007-final-hold.md** records the source review
and required acceptance. All proposed recovery/runtime acceptance is **UNEXECUTED**.
AC-PERSIST-006/007 exhausted the two corrective assignments for the same problem;
further contract revision requires Dave's explicit authorization to extend that limit.
No third correction, migration, runtime wiring or history/resume implementation is
currently authorized. Persistence remains In Progress with this explicit design hold.

The independently accepted pending-command/draft-safety contract was implemented
and verified by PR #24, as recorded above. Its earlier UNEXECUTED label is
superseded. Atomic task transfer and a real tool-approval contract remain incomplete;
delivered client view synchronization does not relax the recovery hold.

## Tool-approval design hold

Final design review is held at the existing two-correction limit. Its F6 acceptance
row combines terminal-row UI admission (zero POST/no ticket) with direct duplicate
endpoint replay (one transport request); those are different acceptance paths.
The original synchronization/rejection issue is resolved, but this contradiction
still blocks implementation. Private decision `tool-approval-final-hold.md` records
the result. All proposed tool-approval acceptance remains UNEXECUTED; no third
correction or implementation is authorized. This is a design/test-contract blocker,
not a defect proven in delivered behavior. Tool approval remains unavailable and
fidelity Partial; independent task-transfer design does not relax this hold.

## Reassign final design hold

Final proposal 018 passed independent frontend/public review, but all **56 proposed
acceptance cases remain UNEXECUTED**. Backend review still found two contradictions:

- Treating completed tasks as terminal, while requiring an active task for
  `agent.done`, breaks the existing Forge repair completion/report flow. After its
  initial completion, later repair handoffs would leave Forge done; rejecting its
  final report would prevent Atlas from waking Probe for final tests.
- The replacement proposal omits the previously explicit latest-successful-receipt
  per task retention/overwrite rule and replay-after-retransfer policy. Retaining
  every paused transfer receipt can grow without a run bound and conflicts with
  latest-only replay/current-refusal precedence.

These are defects in an **unimplemented proposal**, not regressions in delivered
main. Private coordinator decision `reassignment-final-hold.md` records the final
review. Reassign remains unavailable and fidelity **Partial**. Both corrections
for REASSIGN-DESIGN-CONSISTENCY are exhausted; further contract repair or
implementation requires Dave to extend that limit. A renamed task cannot bypass it.

Recovery/runtime/history and tool approval retain their separate holds above.
All currently dispatchable foundation runtime paths are now held pending a decision
after this status closeout. M1 still requires budget/runner authorization, M3 real
tools follow the foundations, and M4 needs hosting/deployment authority. The
coordinator handles the remaining decision and heartbeat state after accepted
delivery; this record does not claim the heartbeat has already been paused.

## Delivered responsive console and both themes — PR #22

- Independently accepted [PR #22](https://github.com/DaveHomeAssist/agent-chat/pull/22)
  merged September 8 at 15:16:19 UTC as `8419cb9f8e0f536b1b34d1f6a6618b8f76c2567b`.
  Its product tree matches accepted head `80f26498986364eda3b9aebaa235cce8c118fef6`;
  only previously delivered status documents differ. No unreviewed product changes
  entered this integration.
- The local and authenticated console defaults to light and exposes a shared theme
  control. Room/Agents/Context navigation preserves usable phone/tablet width;
  desktop and ultrawide retain multiple panels. Actual console layouts cover
  320/390/768/1024/1440/3440px, superseding the inherited mobile floor.
- Every mobile token label/value is visibly above Room in both themes, with native
  keyboard/touch disclosure. Panel navigation moves focus to visible destinations;
  resize preserves stable Snapshot/theme/session focus. Activity text and focus
  indicators meet the tested contrast thresholds in both themes.
- Authentication executed 17 targeted layout and 41 full Chromium cases at the
  accepted source. The independent reviewer inspected corrected source/assertions
  and final images; integration also inspected decisive phone/tablet/status images.
  Preserved pre-fix failures distinguish actual occlusion/focus issues and a stale
  local bundle from the final passing production evidence.
- [Exact product main CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34243674321)
  passes clean installation, build/typechecks, **183 Node tests, 17 queue tests,
  42 simulator checks and 41 Chromium cases**. No unchanged broad local product
  suite or fixture listener was launched again for this documentation closeout.
- LIVE/PAUSED/FAILED contrast snapshots are browser-local synthetic presentation
  inputs; agent/tool operations in application checks remain mocked. This proves
  neither provider acceptance nor real repository work. Authentication, Snapshot,
  command refusal and unavailable-control regressions remain strict.
- Fidelity remains **Partial**, with **14 Complete / 11 Remaining**, all 25 IDs and
  historical dates preserved. At this September 8 checkpoint, pending-command
  safety was accepted design only; PR #24 above supersedes that limitation.
  Reassign and real tool auto-approval are still unavailable. Recovery retains the
  three-issue hold above. M1 budgets/runner, M3 real tools and M4 hosting/remote
  acceptance remain incomplete. Earlier paid/hosting observations keep their dates.
- Status-file rendering is checked separately at 1440 × 1000, 390 × 844 and
  3440 × 968 in both themes, including pagination/controls and all 25 print rows.
  This is a local/repository document, not a deployment or proof of the user's
  existing browser tab. Code revision records the product merge, not a docs SHA.

## Executor coordination delivery

- The private SQLite communication queue, worker bootstrap and coordinator runbook
  are implemented; see [coordination setup](../coordination/START_HERE.md).
- Seventeen standard-library protocol tests pass, including eight concurrent claims
  with one assignment delivery, two separate worker processes, interrupted-report
  rollback, stale-lease quarantine, persisted decisions/cursors, quiet idle cycles
  and deterministic leading-dash lease renew/report.
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
| M2 unattended operation | Partial | Snapshot, auth, command refusals, truthful controls and browser CI delivered; recovery contract held, runtime/history unimplemented; console themes/responsiveness delivered; command admission/draft protection/bounded refresh delivered; transfer/approval contracts pending |
| M3 real repository | Not started | Isolated Git/command adapter and sandbox PR acceptance after M2 |
| M4 remote deployment | Not started | Hosting decision, durable runtime, HTTPS and deployed auth/remote acceptance after M3 |

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

- Earlier Sep 8: Auth module PR #12 merged while runtime PR #15 was staged. That
  pre-merge auth status is superseded by the integrated authentication delivery above.
- Sep 8: Command acceptance PR #18 and console improvements PR #19 merged; their
  combined product passes all offline gates. Fidelity remains Partial.

- Sep 8: Reviewed responsive/light-dark console PR #22 merged with successful main
  CI and 41 browser cases; command safety was then unexecuted and fidelity Partial.
- Sep 10: DaveHomeAssist externally merged PR #25 then corrected PR #24; product
  main CI passed 209 Node, 17 queue, 42 simulator and 49 browser checks.
- Sep 14: Recovered interrupted evidence, read back the existing merges/CI and
  reconciled status records. Local status rendering is separate from application CI.

Future delivery dates are unscheduled. Update this file and structured visual
status after meaningful changes under the root AGENTS.md contract.
