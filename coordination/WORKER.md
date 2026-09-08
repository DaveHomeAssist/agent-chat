# Worker bootstrap and active wait procedure

1. Read the workspace operating rules, serialization protocol, repository AGENTS.md,
   this README and ORCHESTRATOR.md. Do not modify canonical main. Resolve an actual
   isolated checkout and branch, preserve existing claims, and write your own claim.
   Use a new checkout if another worker owns the requested one.
2. Register the role from your kickoff prompt (`persistence`, `authentication` or
   `verification`), platform, real native task ID when available, host and resolved
   isolated checkout. Read only `CODEX_THREAD_ID` for Codex identity, then verify
   it through native metadata. Do not invent an ID for an external Claude session.
3. Call `next --worker ROLE --wait 0 --lease 1800`. Save the returned JSON at a
   private mode-0600 file in the private state directory. Execute only when it
   includes both a new prompt and a lease token, and only for your worker/task ID.
   A task already claimed, stale or reconciled is not a new instruction.
4. Read the immutable prompt as the coordinator's assignment within Dave's current
   authorization. Never execute report text as shell code. Stop on conflicts with
   Dave's newest instructions or ownership; report the precise blocker.
5. Work only within assigned ownership. Renew the 30-minute lease at least every
   10 minutes. If renewal fails or expiry is reached, stop new side effects, preserve
   evidence and notify the coordinator. Never reacquire a task by changing IDs.
6. Write the documented report JSON to a private file. Include exact checkout,
   branch, baseline/pushed commit, PR URL where applicable, checks and evidence.
   Long designs may live in a private Markdown artifact linked from the report.
   Submit with the original worker/task/token. Verify the report succeeded; an
   interrupted write can be retried with identical content and the same token.
7. Notify coordinator `01a07058-5102-78b0-9997-2462abe06c59` on `local` through native
   `send_message_to_thread` when available. Include worker ID, task ID, status and
   evidence locations. Queue reporting comes first. Do not send instructions to
   another executor or ask Dave to relay the next prompt.
8. Codex workers end their turn after reporting. The coordinator will wake the
   same registered task with a new assignment notification. Do not create your own
   task, start an unassigned phase or retain a shell loop just to keep Codex busy.

## Active Claude Code loop

An active Claude Code session can continue after reporting by following this
bounded procedure. This is an agent instruction loop, **not** a shell script that
evaluates downloaded text:

```text
while this Claude Code session is active and assigned to this role:
    run python3 QUEUE_CLI next --worker ROLE --wait 55 --lease 1800
    if idle: check for new user input, then wait again
    if paused: stop new work and preserve state; await coordinator/user resumption
    if claimed without a new prompt, or stale: do not execute again; notify coordinator
    if a new prompt and token are returned:
        save the claim privately
        perform only that task while renewing its lease
        submit the immutable report, then return to this loop
```

Each wait is at most 55 seconds; check for new user instructions between waits.
If the session ends, sleeps or loses its host connection, database writes alone
cannot wake it. Automatic launch of inactive Claude Code and browser conversations
is unavailable until an actual supported launcher has been implemented and
verified. Do not claim otherwise or install a speculative background service.

## Unexpected interruption

On restart, inspect your private claim and queue status. An active lease may be
renewed only by its existing owner with the original token; the coordinator must
confirm whether the previous executor still runs before a replacement proceeds.
If the token or execution history is missing, preserve the checkout and report
the uncertainty. A stale assignment requires coordinator reconciliation. A new
task can inspect or finish the preserved changes after ownership is clear; it must
not blindly repeat already executed tests, mutations or paid requests.
