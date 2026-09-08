# Durable run repository

This module is a private storage boundary for Agent Chatroom run history. It is
not wired into the server yet and it never starts, resumes, replays, repairs,
prunes or deletes application work.

## Runtime and opening

`openSqliteRunRepository({ databasePath })` requires an explicit absolute path
outside a Git checkout. The caller owns default-path/configuration selection.
The implementation uses the built-in `node:sqlite` `DatabaseSync` API available
without a flag from Node 22.13.0, and does not use the constructor `timeout`
option added in Node 22.16. Lock waiting is bounded with `PRAGMA busy_timeout`.

Official versioned reference:
https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html

The database directory is mode `0700`; the database, WAL, shared-memory and
writer-lock files are mode `0600`. The module changes no global umask. Direct
symlinks and repository-contained database paths are rejected. Before creating
or changing a path, the repository resolves the nearest existing ancestry and
also rejects an ancestor symlink whose actual target is inside a Git checkout.

## Exported interface

- `commit(input)` atomically stores a validated public snapshot, versioned
  private checkpoint, optional public event, operation transition and usage
  record. The public snapshot, checkpoint and any event carry one matching
  durable sequence; sequence gaps remain valid.
- `listPublic()` and `readPublic(runId)` return explicit public allowlists only.
- `inspectPrivate(runId)` and `readEvents(runId)` are private integration/audit
  surfaces and must not be returned from public HTTP handlers.
- `usageTotals(runId?)` preserves per-run or lifetime reported/unknown usage.
- `classifyRecovery()` returns `none`, `readable_only`, `held_incomplete`,
  `held_unknown` or `held_corrupt`. It executes no effect.
- `close()` releases only this handle's verified writer lock.

Version 1 checkpoints explicitly mark runner state, workspace state, provider
continuation and automatic resume as unsupported. Therefore a nonterminal run
without corruption is still held, not resumable. A started operation without a
committed outcome is returned as unknown and is never replayed.

Operation transitions are `prepared → started → completed`. Repeating an equal
transition or usage record is idempotent; conflicting identity reuse and skipped
states fail the entire transaction. A started or completed provider operation
without a usage row contributes one derived unknown request across every reopen;
completion never implies zero usage. A later explicit reported or unknown row
replaces that derived uncertainty exactly once. Accounting reads validate every
operation and usage row plus run/provider ownership before returning totals;
invalid accounting raises corruption instead of returning a lower value.

## Ownership and corruption

SQLite transaction locks protect transactions, not process lifetime. A separate
same-host writer lock records host, PID and writer identity. Atomic creation of
a private ownership-guard directory serializes lock creation, stale takeover and
identity-checked release; a second contender cannot move a newly acquired live
lock. A second live or ambiguous owner fails closed. A confirmed dead same-host
PID can be replaced, but its lock is renamed and preserved as evidence. A guard
left by a crash, malformed lock, remote-host lock or permission-ambiguous lock
is never automatically deleted.

The repository runs `PRAGMA quick_check`, rejects unsupported or unversioned
non-empty schemas, and never replaces a corrupt database. Structurally valid
storage with one invalid payload keeps unrelated history readable; recovery of
the affected run is classified `held_corrupt`. Readback cross-checks run IDs,
durable sequences, denormalized run metadata, event ownership and usage-to-
operation ownership rather than relying on schema shape alone. Unresolved
started effects are classified `held_unknown` before terminal labels are
considered and take priority during repository-level recovery selection.

## Pending integration gates

- integration must declare Node `>=22.13.0`, choose the private default path and
  wire open/close/failure behavior;
- run, runner and workspace serializers need a separately reviewed schema
  before safe manual resume can exist;
- authentication must authorize any future history/recovery HTTP routes;
- verification owns process-restart/browser coverage, shared wiring, merge and
  project progress records;
- retention/deletion requires a separate design that preserves lifetime usage
  accounting. No deletion API exists in this module.
