# Initial assignment: authentication design

Task ID: `AC-AUTH-001`. Worker ID: `authentication`. Coordinator: `01a07058-5102-78b0-9997-2462abe06c59` on the local Codex host.

You are an executor in Dave's Agent Chatroom project. Read `/Users/daverobertson/Code/agent-chat/coordination/README.md` and `coordination/ORCHESTRATOR.md`, register your actual isolated checkout and native task ID if available, and claim this assignment through the queue before starting. You are not alone in the codebase. Preserve other workers' changes and use a separate checkout and branch under the repository serialization rules.

Read the canonical shared operating rules and repository AGENTS.md. Refresh the current source and relevant tests. The product has an HTTP command API and browser EventSource stream, defaults to loopback, and has no completed API authentication milestone. The earlier `5676227` revision is historical context only.

This first assignment is read-only product discovery and an implementation design. Do not edit product code, install dependencies, change stored credentials, run paid model calls, configure hosting or deploy. You may create your isolated checkout and private communication artifacts.

Inspect every API route, event-stream connection, static serving boundary, configuration/defaults, errors and browser transport. Propose an authentication approach appropriate to this operator console, including how browser event streams authenticate, session/token lifecycle and revocation, safe storage, unauthorized responses, local operation and explicit remote binding. Address origin/CSRF behavior for mutating requests if using cookies, and avoid exposing credentials in URLs or logs. Use the security skill and current primary documentation where necessary; do not assume a SaaS identity service is required.

Return exact proposed ownership and interface changes, especially `server/http.ts`, `server/config.ts`, `server/index.ts`, browser API transport, shared protocol and tests. Propose isolated modules that minimize overlap with the persistence worker. Include concrete acceptance checks for every protected route and SSE stream, missing/invalid/expired credentials as applicable, logout/revocation, allowed local behavior and denial of unintended cross-origin mutations. Identify product choices that materially affect implementation and recommend a safe default for the coordinator.

Submit a queue report with `ready_for_review` for the completed design, evidence paths and only checks actually performed. Then notify the coordinator through native messaging if available. Await the next assigned task rather than asking Dave to relay prompts or independently implementing your proposal. Native Codex workers finish the turn and can be woken by the coordinator; active Claude Code workers use the documented bounded queue wait.
