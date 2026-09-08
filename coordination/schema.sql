PRAGMA user_version = 1;
CREATE TABLE IF NOT EXISTS settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    coordinator TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
    checkpoint INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workers (
    worker TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('codex', 'claude-code')),
    thread TEXT,
    host TEXT NOT NULL,
    checkout TEXT NOT NULL,
    registered_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
    task_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE NOT NULL,
    worker TEXT NOT NULL,
    prompt TEXT NOT NULL,
    problem TEXT,
    correction INTEGER NOT NULL CHECK (correction IN (0, 1)),
    created_at REAL NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','claimed','stale','ready_for_review','blocked','failed','reconciled')),
    lease_hash TEXT,
    lease_until REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment
ON assignments(worker) WHERE state IN ('claimed','stale');
CREATE TABLE IF NOT EXISTS reports (
    task_id TEXT PRIMARY KEY REFERENCES assignments(task_id),
    body TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    task_id TEXT,
    worker TEXT,
    body TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
    idempotency_key TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TRIGGER IF NOT EXISTS immutable_decision BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS retain_decision BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS immutable_assignment
BEFORE UPDATE OF task_id,idempotency_key,worker,prompt,problem,correction,created_at ON assignments
BEGIN SELECT RAISE(ABORT, 'assignments are immutable'); END;
CREATE TRIGGER IF NOT EXISTS retain_assignment BEFORE DELETE ON assignments
BEGIN SELECT RAISE(ABORT, 'assignments cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS immutable_report BEFORE UPDATE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are immutable'); END;
CREATE TRIGGER IF NOT EXISTS retain_report BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT, 'reports cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS immutable_event BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS retain_event BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events cannot be deleted'); END;
