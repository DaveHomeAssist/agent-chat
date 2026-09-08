# Useful model probe: Snapshot export

Verified September 8, 2026. Product revision `0fc51ca15da814bf3b7630114a3c8354daa9002d`.
Delivery: [PR #9](https://github.com/DaveHomeAssist/agent-chat/pull/9).

## Paid request and useful result

One explicitly authorized OpenAI request used the current source to propose an
implementation for the unwired Snapshot button. Allowance: $0.50. Model:
`gpt-5.6-sol`, low effort, maximum 4,096 output tokens. No retries were made.
The request completed from 08:54:28 to 08:55:17 UTC on September 8.

| Reported usage | Tokens |
| --- | ---: |
| Ordinary input | 3 |
| Cache write | 8,526 |
| Cache read | 0 |
| Output | 3,547 |

Calculated from reported usage and the verified pricing profile: **$0.113582**
(11.36 cents), below the 50-cent allowance. This is a reported-usage calculation;
the provider invoice was not independently reconciled. No further paid requests
were made during implementation or verification.

The proposal supplied a patch and test cases. Local review corrected TypeScript
module imports and protocol fixtures, kept serialization free of browser globals,
and added a timeout, synchronous duplicate protection, an accessible error banner,
and reliable object URL cleanup. Codex implemented and delivered the reviewed fix.
This single useful provider call does not complete the two-run five-agent M1 gate,
and is not proof of the application's future real repository adapter.

## Delivered behavior

Click **Snapshot** in a connected console to download
`agent-chatroom-<safe-run-id>-<UTC-time>.json`. The version 1 envelope contains
`exportedAt` and the complete public `RunSnapshot`: run, usage, roster, transcript,
pipeline and typing state. A fresh uncached GET uses server state, including logs
beyond the browser's 200-line display limit. Provider continuation and private
execution state are not requested or exported. Public messages and logs remain
part of the file; export is not a content redaction feature.

The button is unavailable before connection and during export. A 15-second abort
and visible error allow retry. Snapshot does not start, approve, pause or otherwise
mutate a run. This is a current-run export, not persistent history or recovery.

## Verification

- All 105 Node tests pass, including four new export regressions. All three
  TypeScript checks and 42 simulator selfchecks pass locally.
- [Linux CI](https://github.com/DaveHomeAssist/agent-chat/actions/runs/34208042574)
  passes clean installation, the standard production build, tests and selfchecks.
  CI retains the production bundle for seven days; browser verification used that
  exact bundle with the locally compiled server in mock mode.
- Chromium at 1600 × 1000: initial disabled state; real JSON downloads in idle and
  approval-held states; fresh API fixture with all 501 log lines; one request under
  repeated clicks; no mutation requests from export; HTTP 500 visibility and retry;
  actual 15-second timeout; injected download failure; anchor and object URL cleanup.
  No unhandled runtime exceptions. The deliberately injected 500 produces its
  expected browser network error.
- Progress HTML verified at 1600 × 1000, 390 × 844 and 2560 × 720: all
  23 work items reachable, search/sort/reset/theme and keyboard focus work, no
  document overflow, and print includes every item.
- The local Mac's Vite process stalls in native dependency loading on unchanged
  main and the feature branch. It was stopped; no security controls or dependency
  versions were altered to bypass it. Local production builds remain environment
  limited; the standard CI build supplies production verification.

Private request, proposal, receipt, browser downloads and screenshots are retained
locally. Credentials, raw provider state and private prompt artifacts are not
committed. Hosting remains unverified; this delivery does not change hosting.
