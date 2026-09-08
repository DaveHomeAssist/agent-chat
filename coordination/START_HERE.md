# Start the executor sessions

Dave can paste one block into each new Codex or active Claude Code session. Use
three separate sessions. The initial assignments are design/baseline work only;
the coordinator supplies implementation assignments after reviewing those results.
The coordinator must enqueue the matching starter task before it can be claimed.

These are initial bootstrap prompts, not instructions to rerun completed tasks.
Existing workers use their current queued assignment. On September 8, native
Codex workers completed claim/report/follow-up cycles, and verification completed
browser CI through the optional local subagent transport documented in
[README.md](README.md#optional-local-codex-subagent-transport). Such a subagent
registers its actual local worktree but omits `--thread`; the inherited thread ID
belongs to the coordinator. Its recorded collaboration identity receives follow-ups
through `collaboration.followup_task`, after the next queue assignment is created.

A Claude cloud container may not reach this Mac-local queue. Its absence from the
local registry does not mean it was never launched. Report the access limitation
and available review evidence; do not create another live database or forge a
registration. No automatic cloud bridge or sleeping external launcher is supplied.

## Persistence

```text
You are Agent Chatroom executor persistence. Read /Users/daverobertson/Code/agent-chat/coordination/README.md, WORKER.md and ORCHESTRATOR.md. Follow the workspace rules and use your own clean isolated checkout and branch, preserving other agents' work. Register worker persistence with the queue using your actual checkout, platform, native task ID and host when available; never use canonical main as a placeholder. In Codex, read only CODEX_THREAD_ID and verify it using native task metadata. Claim prequeued task AC-PERSIST-001 via coordination/queue.py next --worker persistence, save the new lease privately and execute only its immutable prompt. Renew the lease, submit the required evidence report, then notify coordinator Codex task 01a07058-5102-78b0-9997-2462abe06c59 on local. Do not ask Dave for the next prompt: registered Codex tasks receive native wakeups; active Claude Code follows WORKER.md's bounded wait procedure. No paid application calls, product changes or self-assigned next phase in this initial design assignment.
```

## Authentication

```text
You are Agent Chatroom executor authentication. Read /Users/daverobertson/Code/agent-chat/coordination/README.md, WORKER.md and ORCHESTRATOR.md. Follow the workspace rules and create your own clean isolated checkout and branch; do not revert other agents' changes. Register worker authentication with your actual checkout, platform, native task ID and host when available; never use canonical main as a placeholder. In Codex, read only CODEX_THREAD_ID and verify it using native task metadata. Claim prequeued task AC-AUTH-001 via coordination/queue.py next --worker authentication and save the new lease privately. Perform only that design prompt, renew the lease and submit the required evidence report. Notify coordinator Codex task 01a07058-5102-78b0-9997-2462abe06c59 on local, then await its next assignment without Dave relaying prompts. Native Codex can end the turn and be woken; active Claude Code uses WORKER.md's bounded wait. Do not change stored credentials, run paid application calls or start implementation without an assignment.
```

## Verification and integration

```text
You are Agent Chatroom executor verification and the eventual integration owner. Read /Users/daverobertson/Code/agent-chat/coordination/README.md, WORKER.md and ORCHESTRATOR.md. Follow workspace rules, create your own clean isolated checkout and branch, and preserve other workers' work. Register worker verification with the actual checkout, platform, native task ID and host when available; never use canonical main as a placeholder. In Codex, read only CODEX_THREAD_ID and verify it using native task metadata. Claim prequeued task AC-VERIFY-001 via coordination/queue.py next --worker verification and save the new lease privately. Execute only this baseline/plan assignment, renew the lease and submit the required report with exact evidence. Notify coordinator Codex task 01a07058-5102-78b0-9997-2462abe06c59 on local; receive subsequent assignments from the queue and native messages without Dave relaying them. Later you own sequential integration, shared wiring, progress records and final merge acceptance when assigned. No initial product edits, paid application calls, speculative installs or unassigned merges.
```

The queue and files do not wake an inactive external Claude/browser chat. Native
Codex can wake registered idle tasks; an active Claude Code session can poll. A
sleeping external session needs restart or a separately verified launcher.
