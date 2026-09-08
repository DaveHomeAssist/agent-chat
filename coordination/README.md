# Executor communication

This is a local coordination tool for the sessions building Agent Chatroom. It is
separate from the application's simulated agents and does not complete product
persistence, authentication or real repository execution.

Start with [START_HERE.md](START_HERE.md). The coordinator follows
[ORCHESTRATOR.md](ORCHESTRATOR.md); workers follow [WORKER.md](WORKER.md).

## Storage and ownership

Python 3.10 or newer and its standard-library SQLite are sufficient. No package
installation, API calls, daemon or subscription is required by this queue.
Runtime verification used Python 3.14.3 locally; the tests also run in GitHub CI.

Versioned files contain the protocol, schema, scripts and starter prompts only.
Live state defaults to `/Users/daverobertson/.local/state/agent-chat-coordination/`:
the directory is mode 0700, `queue.sqlite3` and transient journal files are private.
Do not put credentials, environment dumps or raw model state in prompts/reports.
The CLI never loads environment credentials or executes prompt/report text. A
different `--state-dir` is available for isolated tests, but live state inside a Git
checkout is rejected. Back up the database with SQLite's backup API while idle or
paused; do not copy an in-flight database without its journal.

Coordinator ID: `01a07058-5102-78b0-9997-2462abe06c59`, host `local`.
Only that actor dispatches work, records decisions and controls the queue. Each
worker registers its actual exclusive checkout and owns its own reports. Worker
IDs are `persistence`, `authentication`, and `verification`; bootstrap tests use
different IDs and a separate temporary database. Workers do not instruct peers.

Identity is a protocol check among trusted processes sharing Dave's OS account,
not an authentication boundary against hostile same-account code. A process with
filesystem access can read the database. Keep it on the local disk; it is not a
network queue or a multi-user access service. A registered remote host cannot use
this local database unless a separately verified access mechanism exists.

## CLI contract

All commands return structured JSON (`ok: true/false`), except `--help` and
`status --markdown`. Exit 0 means success; exit 2 means invalid input or failed
operation. Error messages do not echo input contents. Database contention fails
without silently executing twice; inspect state before retrying with the same
idempotency key. Use absolute paths and quote shell variables.

```sh
queue_cli=/Users/daverobertson/Code/agent-chat/coordination/queue.py
coordinator_id=01a07058-5102-78b0-9997-2462abe06c59
python3 "$queue_cli" init --coordinator "$coordinator_id"
python3 "$queue_cli" status
python3 "$queue_cli" status --markdown
python3 "$queue_cli" events --after 0 --limit 100
```

Coordinator commands (prompt and note files are private plain UTF-8 data):

```sh
python3 "$queue_cli" enqueue --actor "$coordinator_id" \
  --worker persistence --task AC-PERSIST-001 --key AC-PERSIST-001-v1 \
  --prompt-file /Users/daverobertson/Code/agent-chat/coordination/prompts/persistence.md
python3 "$queue_cli" decision --actor "$coordinator_id" \
  --key AC-PERSIST-001-review --note-file /absolute/private/review.md
python3 "$queue_cli" checkpoint --actor "$coordinator_id" --cursor 12
python3 "$queue_cli" pause --actor "$coordinator_id"
python3 "$queue_cli" resume --actor "$coordinator_id"
python3 "$queue_cli" reconcile --actor "$coordinator_id" \
  --task AC-PERSIST-001 --reason 'Inspected task and checkout; record exact evidence here.'
```

The checkpoint number is an example: use the last event actually processed. It
cannot move backward or beyond the existing log. Store durable decisions and
follow-up assignments before advancing it. `events` returns an exclusive cursor;
request more pages until none remain. Decision keys and dispatch keys are
idempotent: repeating identical content is a no-op; changed content is rejected.
Prompts, reports, decisions and events are immutable. Correct a report with a new
coordinator decision or task, never overwrite it.

An assignment can be enqueued before registration, but cannot be claimed until
that named worker registers. No worker can have two active or stale assignments.
Use `enqueue --problem stable-problem-key --correction` for a corrective task. At
most two corrective assignments are permitted for one unchanged problem; after
that, record the human input needed and continue independent work. Do not change
problem keys merely to evade this limit.

`pause` prevents new claims. It does not cancel executing work or invalidate active
leases: the coordinator must also notify active workers to stop at a safe point.
Renewals and reports remain valid while paused. `reconcile` closes a stale or
queued assignment after inspection; it never requeues it. A follow-up needs a new
task ID and key. Never blindly rerun work whose side effects are uncertain.

Worker commands:

```sh
python3 "$queue_cli" register --worker persistence --platform codex \
  --thread "$CODEX_THREAD_ID" --host local --checkout /absolute/isolated/checkout
python3 "$queue_cli" next --worker persistence --wait 0 --lease 1800
python3 "$queue_cli" renew --worker persistence --task AC-PERSIST-001 \
  --token "$lease_token" --lease 1800
python3 "$queue_cli" report --worker persistence --task AC-PERSIST-001 \
  --token "$lease_token" --report-file /absolute/private/report.json
```

Read `CODEX_THREAD_ID` only, never dump the environment; verify it against native
task metadata. Omit `--thread` for an external worker without a verified native
task ID. `--host` defaults to `local`. The registered checkout must exist with Git
metadata, be isolated from canonical main, and be exclusive to this worker. The
returned registration/claim gives its resolved path; use that exact report path.
Registration changes produce events and are blocked during active/stale work.

`next` accepts `--wait` from 0 to 55 seconds and leases from 60 to 3600 seconds
(default 1800). Only a **new** claim includes `prompt` and `lease_token`. A repeated
`next` while claimed returns state/identity without a prompt or token: it is not
permission to execute again. Save the initial claim privately before acting and
renew well before expiry. If the claim response is lost, or the lease expires,
stop and ask the coordinator to reconcile. Expiration records `lease_stale` and
blocks further claims for that worker. There is no automatic retry/requeue.

Reports must contain exactly these fields:

```json
{
  "task_id": "AC-PERSIST-001",
  "status": "ready_for_review",
  "summary": "Concrete result with review artifact location",
  "checkout": "/absolute/resolved/isolated/checkout",
  "branch": "worker/persistence",
  "commit": "exact 40 or 64 lowercase hex characters from git rev-parse HEAD",
  "pr_url": null,
  "checks": [
    {"name": "Source inspection", "result": "pass", "evidence": "Exact files and observed result"}
  ],
  "blockers": [],
  "next_action": "Coordinator review and assign the next bounded task"
}
```

Statuses: `ready_for_review`, `blocked`, `failed`. Check results: `pass`, `fail`,
`unverified`. A ready report requires all listed checks to pass and no blockers;
failed/blocked reports must explain at least one blocker. Report only checks
actually performed. For a design-only task, list completed inspection checks and
put proposed acceptance scenarios in the design artifact, not as passed tests.
For read-only work, `commit` is still the exact inspected baseline and `branch` is
the isolated branch; `pr_url` is null. For implementation, provide the exact pushed
commit, PR URL and executed check evidence. Reports require the assigned worker
and current lease token. Repeating the same report is safe; changing it is rejected.

## Wakeups and delivery

The queue is authoritative for assignment identity and recovery. It does **not**
wake an inactive conversation. Native Codex `send_message_to_thread` wakes a
registered idle Codex task; its message tells the worker to claim from the queue.
After reporting, Codex workers notify coordinator task
`01a07058-5102-78b0-9997-2462abe06c59` on `local` and end the turn. A later coordinator
message starts the next turn without Dave relaying the prompt.

The configured five-minute native heartbeat `agent-chatroom-coordinator` wakes
the coordinator to recover missed notifications and inspect changes. Codex/client
availability and account allowances can delay it. Native automation is separate
from this CLI. No automatic launcher for sleeping Claude Code or browser chats
has been verified. An **active** Claude Code session can use the bounded wait loop
in [WORKER.md](WORKER.md); an inactive one requires a supported launcher or restart.

The verification executor later owns shared wiring, sequential integration,
progress records, merges and final acceptance. Other implementation workers commit
and push bounded PRs and report for review. This division fulfills the normal
end-to-end delivery requirement; a pushed PR alone is not completed delivery. The
coordinator never performs product edits, tests or merges. Scope changes and paid
application model calls still require the applicable existing authorization.

## Optional local Codex subagent transport

The coordinator can delegate an authorized executor assignment to a local Codex
subagent with the same filesystem access. This transport completed the verification
worker's browser CI assignment and subsequent queue follow-up on September 8, 2026.
Register its real isolated checkout with `--platform codex --host local` and omit
`--thread`: an inherited `CODEX_THREAD_ID` identifies the parent, not the subagent.
The coordinator records the returned collaboration agent ID and canonical task
name in a durable decision instead of inventing a native task identity.

The subagent still claims immutable prompts, renews leases and submits strict queue
reports. It then uses `collaboration.send_message` to notify the coordinator.
The coordinator enqueues the next assignment before using
`collaboration.followup_task` to wake that idle subagent; use `send_message` for
steering an active one. Before retrying a missing or interrupted worker, inspect
`collaboration.list_agents`, the lease, checkout and prior effects. Reconcile lost
ownership before a replacement claim; never replay uncertain work blindly.

This is an optional supported local transport, not a change to the database or
trust boundary. Claude's cloud review environment could not reach this Mac-local
queue. A cloud worker that cannot access the canonical queue must report that
limitation through its available channel; do not create a competing database,
forge a local registration/report or infer that it never launched. The coordinator
can use its review as external evidence and assign local execution separately.
No automatic Claude cloud bridge or sleeping external-session launcher is provided.

## Verification

```sh
python3 -m unittest discover -s coordination/tests -p 'test_*.py' -v
```

The standard-library test suite covers concurrent claims, immutable/idempotent
dispatch, worker/token validation, report validation/rollback, pause/resume,
stale leases, restart/cursors, correction limits, private permissions, no
environment-secret output, and two separate test worker processes exchanging
assignments and results. All tests use temporary state and fixtures; no test
worker or assignment is inserted in the real queue. No product source is edited
and no provider API is contacted by those tests.
