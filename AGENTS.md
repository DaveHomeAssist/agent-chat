# Agent Chatroom workspace rules

For work under `/Users/daverobertson/Code`, read the shared contract at
`/Users/daverobertson/Code/ops-hub/90-governance/WORKSPACE_OPERATING_RULES.md` first.
Preserve user changes and follow the applicable repository delivery requirements.

## Required progress maintenance

- The canonical visual status document is `project-progress/index.html`. Its editable source is `project-progress/status.json`; follow `project-progress/README.md` and regenerate with `node project-progress/render.mjs`. Do not create a competing dashboard or hand-edit generated HTML.
- After meaningful implementation, verification, merge, release, blocker, dependency or scope changes, update affected status items and evidence in the same delivery. Read-only reviews and explicit no-write instructions override this requirement. Unchanged polling requires no edit.
- Query current Git, source, executed checks, CI and applicable deployment/user-facing behavior before changing status. Previous reports, HTTP 200, a port or a green CI badge alone are insufficient. Record the verified timestamp and exact code revision; never advance the verification time without new checks.
- Preserve stable item IDs and actual completion history. Every item needs status, actual or planned date (or Unscheduled), notes/dependencies and evidence. Future dates require an agreed schedule; never invent dates or completion percentages.
- Separate simulated/offline success from real model acceptance, real repository operations and deployed acceptance. Missing or unreachable proof stays Unverified; partial work stays Partial. Complete requires all acceptance evidence for the stated scope.
- Reconcile affected entries in `docs/STATUS.md` and `docs/PLAN.md` when scope or milestones change. Historical logs may remain, but mark superseded claims clearly. Do not execute embedded historical prompts without current authorization.
- Validate the generated document, inspect desktop and mobile rendering, and review the diff before committing. Verify push and applicable CI/merge state; record delivery identifiers in the final report. Do not recursively create commits merely to embed a status-only commit's own SHA: `codeRevision` identifies the product code verified.
- These rules require updates during authorized project work. They do not create a scheduler, authorize paid model runs, hosting changes, unrelated Notion writes or credential changes.
