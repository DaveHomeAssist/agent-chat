#!/usr/bin/env python3
"""Durable local assignments. Python 3.10+, standard library, no model calls."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys
import time
from typing import Any, Iterator

DEFAULT_STATE = Path.home() / '.local/state/agent-chat-coordination'
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$')
REPORT_STATES = {'ready_for_review', 'blocked', 'failed'}


class QueueError(Exception):
    """A safe, user-facing protocol error (never includes input contents)."""


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def identifier(value: str) -> str:
    if not ID.fullmatch(value):
        raise argparse.ArgumentTypeError('use 1–160 letters, numbers, dots, colons, underscores or hyphens')
    return value


def absolute_path(value: str) -> str:
    if not Path(value).is_absolute():
        raise QueueError('checkout must be an absolute path')
    return str(Path(value).resolve())


def read_input(path: str, *, json_input: bool = False) -> Any:
    source = Path(path)
    if source.stat().st_size > 1_000_000:
        raise QueueError('input exceeds 1 MB')
    value = source.read_text(encoding='utf-8')
    if not value.strip():
        raise QueueError('input cannot be empty')
    return json.loads(value) if json_input else value


class Queue:
    def __init__(self, directory: Path, *, create: bool = False):
        os.umask(0o077)
        directory = directory.expanduser().absolute()
        if directory.is_symlink():
            raise QueueError('state directory cannot be a symlink')
        directory = directory.resolve()
        if any((parent / '.git').exists() for parent in (directory, *directory.parents)):
            raise QueueError('live state must be outside a Git checkout')
        if create:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise QueueError('state directory must be owned by this user with mode 0700')
        self.path = directory / 'queue.sqlite3'
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise QueueError('database must be a private regular file with mode 0600')
        elif not create:
            raise QueueError('queue is not initialized; run init first')
        self.db = sqlite3.connect(self.path, timeout=0.25, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.execute('PRAGMA synchronous = FULL')
        version = self.db.execute('PRAGMA user_version').fetchone()[0]
        if version not in (0, 1) or (version == 0 and not create):
            raise QueueError('unsupported or uninitialized queue schema')
        if create:
            self.db.executescript(Path(__file__).with_name('schema.sql').read_text())

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.execute('COMMIT')
        except BaseException:
            self.db.execute('ROLLBACK')
            raise

    def event(self, kind: str, *, task: str | None = None, worker: str | None = None, body: Any = None) -> None:
        self.db.execute('INSERT INTO events(kind,task_id,worker,body,created_at) VALUES(?,?,?,?,?)',
                        (kind, task, worker, encode(body), time.time()))

    def initialize(self, coordinator: str) -> dict:
        with self.transaction():
            existing = self.db.execute('SELECT coordinator FROM settings').fetchone()
            if existing and existing['coordinator'] != coordinator:
                raise QueueError('queue already belongs to another coordinator')
            if not existing:
                self.db.execute('INSERT INTO settings(singleton,coordinator) VALUES(1,?)', (coordinator,))
                self.event('initialized', body={'coordinator': coordinator, 'host': 'local', 'schema': 1})
        return {'initialized': True, 'coordinator': coordinator, 'database': str(self.path)}

    def coordinator(self, actor: str) -> None:
        row = self.db.execute('SELECT coordinator FROM settings').fetchone()
        if not row or row['coordinator'] != actor:
            raise QueueError('this command requires the registered coordinator actor')

    def worker(self, worker: str) -> sqlite3.Row:
        row = self.db.execute('SELECT * FROM workers WHERE worker=?', (worker,)).fetchone()
        if row is None:
            raise QueueError('worker is not registered')
        return row

    def expire(self) -> None:
        """Commit expiry separately so a rejected late report cannot hide staleness."""
        with self.transaction():
            rows = self.db.execute("SELECT task_id,worker FROM assignments WHERE state='claimed' AND lease_until<=?", (time.time(),)).fetchall()
            for row in rows:
                self.db.execute("UPDATE assignments SET state='stale' WHERE task_id=?", (row['task_id'],))
                self.event('lease_stale', task=row['task_id'], worker=row['worker'], body={'action': 'coordinator reconciliation required; do not rerun'})

    def register(self, worker: str, platform: str, thread: str | None, checkout: str, host: str = 'local') -> dict:
        checkout = absolute_path(checkout)
        if checkout == '/Users/daverobertson/Code/agent-chat':
            raise QueueError('workers must use an isolated checkout, never canonical main')
        if not Path(checkout).is_dir() or not (Path(checkout) / '.git').exists():
            raise QueueError('register a real isolated Git checkout or worktree')
        with self.transaction():
            existing = self.db.execute('SELECT * FROM workers WHERE worker=?', (worker,)).fetchone()
            body = {'worker': worker, 'platform': platform, 'thread': thread, 'host': host, 'checkout': checkout}
            if existing and all(existing[k] == v for k, v in body.items()):
                return {'registered': True, 'unchanged': True, **body}
            if self.db.execute("SELECT 1 FROM assignments WHERE worker=? AND state IN ('claimed','stale')", (worker,)).fetchone():
                raise QueueError('cannot change registration while an assignment is active or stale')
            collision = self.db.execute('SELECT 1 FROM workers WHERE checkout=? AND worker<>?', (checkout, worker)).fetchone()
            if collision:
                raise QueueError('checkout is already registered to another worker')
            self.db.execute('INSERT INTO workers VALUES(?,?,?,?,?,?) ON CONFLICT(worker) DO UPDATE SET platform=excluded.platform,thread=excluded.thread,host=excluded.host,checkout=excluded.checkout,registered_at=excluded.registered_at',
                            (worker, platform, thread, host, checkout, time.time()))
            self.event('worker_updated' if existing else 'worker_registered', worker=worker, body=body)
        return {'registered': True, **body}

    def enqueue(self, actor: str, worker: str, task: str, key: str, prompt: str, problem: str | None, correction: bool) -> dict:
        with self.transaction():
            self.coordinator(actor)
            old = self.db.execute('SELECT * FROM assignments WHERE idempotency_key=? OR task_id=?', (key, task)).fetchone()
            expected = {'task_id': task, 'idempotency_key': key, 'worker': worker, 'prompt': prompt, 'problem': problem, 'correction': int(correction)}
            if old:
                if not all(old[k] == v for k, v in expected.items()):
                    raise QueueError('task or idempotency key already exists with different content')
                return {'task_id': task, 'state': old['state'], 'duplicate': True}
            if correction:
                if not problem:
                    raise QueueError('correction requires an unchanged problem key')
                count = self.db.execute('SELECT count(*) FROM assignments WHERE problem=? AND correction=1', (problem,)).fetchone()[0]
                if count >= 2:
                    raise QueueError('two corrective assignments already exist for this problem; human input required')
            self.db.execute("INSERT INTO assignments(task_id,idempotency_key,worker,prompt,problem,correction,created_at,state) VALUES(?,?,?,?,?,?,?,'queued')",
                            (task, key, worker, prompt, problem, int(correction), time.time()))
            self.event('enqueued', task=task, worker=worker, body={'idempotency_key': key, 'problem': problem, 'correction': correction})
        return {'task_id': task, 'state': 'queued', 'duplicate': False}

    def next(self, worker: str, lease: int) -> dict:
        self.expire()
        with self.transaction():
            registration = self.worker(worker)
            if self.db.execute('SELECT paused FROM settings').fetchone()['paused']:
                return {'state': 'paused'}
            active = self.db.execute("SELECT task_id,state,lease_until FROM assignments WHERE worker=? AND state IN ('claimed','stale')", (worker,)).fetchone()
            if active:
                return {**dict(active), 'action': 'do not execute again; renew owned lease or request coordinator reconciliation'}
            row = self.db.execute("SELECT * FROM assignments WHERE worker=? AND state='queued' ORDER BY created_at,task_id LIMIT 1", (worker,)).fetchone()
            if not row:
                return {'state': 'idle'}
            token = secrets.token_urlsafe(32)
            until = time.time() + lease
            self.db.execute("UPDATE assignments SET state='claimed',lease_hash=?,lease_until=? WHERE task_id=?",
                            (hashlib.sha256(token.encode()).hexdigest(), until, row['task_id']))
            self.event('claimed', task=row['task_id'], worker=worker, body={'lease_until': until})
            return {'state': 'claimed', 'task_id': row['task_id'], 'worker': worker, 'prompt': row['prompt'],
                    'lease_token': token, 'lease_until': until, 'checkout': registration['checkout']}

    def owned(self, worker: str, task: str, token: str) -> sqlite3.Row:
        row = self.db.execute('SELECT * FROM assignments WHERE task_id=? AND worker=?', (task, worker)).fetchone()
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        if not row or not row['lease_hash'] or not secrets.compare_digest(row['lease_hash'], token_hash):
            raise QueueError('assignment worker or lease token does not match')
        return row

    def renew(self, worker: str, task: str, token: str, lease: int) -> dict:
        self.expire()
        with self.transaction():
            row = self.owned(worker, task, token)
            if row['state'] != 'claimed' or row['lease_until'] <= time.time():
                raise QueueError('lease is not active; coordinator reconciliation required')
            until = time.time() + lease
            self.db.execute('UPDATE assignments SET lease_until=? WHERE task_id=?', (until, task))
            self.event('lease_renewed', task=task, worker=worker, body={'lease_until': until})
        return {'task_id': task, 'lease_until': until}

    def report(self, worker: str, task: str, token: str, report: Any) -> dict:
        self.expire()
        with self.transaction():
            row = self.owned(worker, task, token)
            validate_report(report, task, self.worker(worker)['checkout'])
            body = encode(report)
            old = self.db.execute('SELECT body FROM reports WHERE task_id=?', (task,)).fetchone()
            if old:
                if old['body'] != body:
                    raise QueueError('an immutable report already exists for this task')
                return {'task_id': task, 'status': report['status'], 'duplicate': True}
            if row['state'] != 'claimed' or row['lease_until'] <= time.time():
                raise QueueError('lease is not active; preserve evidence for coordinator reconciliation')
            self.db.execute('INSERT INTO reports VALUES(?,?,?)', (task, body, time.time()))
            self.db.execute('UPDATE assignments SET state=? WHERE task_id=?', (report['status'], task))
            self.event('reported', task=task, worker=worker, body=report)
        return {'task_id': task, 'status': report['status'], 'duplicate': False}

    def pause(self, actor: str, paused: bool) -> dict:
        with self.transaction():
            self.coordinator(actor)
            self.db.execute('UPDATE settings SET paused=?', (int(paused),))
            self.event('paused' if paused else 'resumed', body={'actor': actor})
        return {'paused': paused, 'active_work': 'existing leases and reports remain valid'}

    def reconcile(self, actor: str, task: str, reason: str) -> dict:
        self.expire()
        with self.transaction():
            self.coordinator(actor)
            row = self.db.execute('SELECT state,worker FROM assignments WHERE task_id=?', (task,)).fetchone()
            if not row or row['state'] not in ('stale', 'queued'):
                raise QueueError('only stale or queued assignments can be reconciled')
            if not reason.strip():
                raise QueueError('reconciliation requires evidence and a reason')
            self.db.execute("UPDATE assignments SET state='reconciled' WHERE task_id=?", (task,))
            self.event('reconciled', task=task, worker=row['worker'], body={'actor': actor, 'reason': reason})
        return {'task_id': task, 'state': 'reconciled', 'action': 'not requeued; any follow-up needs a new task and key'}

    def status(self) -> dict:
        self.expire()
        with self.transaction():
            config = dict(self.db.execute('SELECT coordinator,paused,checkpoint FROM settings').fetchone())
            workers = [dict(r) for r in self.db.execute('SELECT * FROM workers ORDER BY worker')]
            tasks = [dict(r) for r in self.db.execute('SELECT task_id,idempotency_key,worker,state,problem,correction,created_at,lease_until FROM assignments ORDER BY created_at,task_id')]
            cursor = self.db.execute('SELECT coalesce(max(cursor),0) FROM events').fetchone()[0]
        return {**config, 'workers': workers, 'assignments': tasks, 'cursor': cursor}

    def checkpoint(self, actor: str, cursor: int) -> dict:
        with self.transaction():
            self.coordinator(actor)
            old = self.db.execute('SELECT checkpoint FROM settings').fetchone()[0]
            latest = self.db.execute('SELECT coalesce(max(cursor),0) FROM events').fetchone()[0]
            if not old <= cursor <= latest:
                raise QueueError('checkpoint must move forward within the existing event log')
            if cursor != old:
                self.db.execute('UPDATE settings SET checkpoint=?', (cursor,))
        return {'checkpoint': cursor}

    def decision(self, actor: str, key: str, note: str) -> dict:
        with self.transaction():
            self.coordinator(actor)
            old = self.db.execute('SELECT note FROM decisions WHERE idempotency_key=?', (key,)).fetchone()
            if old:
                if old['note'] != note:
                    raise QueueError('decision key already has different content')
                return {'key': key, 'duplicate': True}
            self.db.execute('INSERT INTO decisions VALUES(?,?,?)', (key, note, time.time()))
            self.event('decision', body={'actor': actor, 'key': key, 'note': note})
        return {'key': key, 'duplicate': False}

    def events(self, after: int, limit: int) -> dict:
        self.expire()
        rows = [dict(r) for r in self.db.execute('SELECT * FROM events WHERE cursor>? ORDER BY cursor LIMIT ?', (after, limit))]
        for row in rows:
            row['body'] = json.loads(row['body'])
        return {'events': rows, 'cursor': rows[-1]['cursor'] if rows else after}


def validate_report(report: Any, task: str, checkout: str) -> None:
    required = {'task_id', 'status', 'summary', 'checkout', 'branch', 'commit', 'pr_url', 'checks', 'blockers', 'next_action'}
    if not isinstance(report, dict) or set(report) != required:
        raise QueueError('report must contain exactly the documented report fields')
    if report['task_id'] != task or report['status'] not in REPORT_STATES or report['checkout'] != checkout:
        raise QueueError('report task, status or registered checkout does not match')
    for key in ('summary', 'branch', 'next_action'):
        if not isinstance(report[key], str) or not report[key].strip():
            raise QueueError('report summary, branch and next_action must be nonempty text')
    if not isinstance(report['commit'], str) or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', report['commit']):
        raise QueueError('report commit must be an exact full Git revision')
    if report['pr_url'] is not None and (not isinstance(report['pr_url'], str) or not re.fullmatch(r'https://github\.com/[^/\s]+/[^/\s]+/pull/[0-9]+', report['pr_url'])):
        raise QueueError('report pr_url must be a GitHub PR URL or null')
    if not isinstance(report['blockers'], list) or any(not isinstance(v, str) or not v.strip() for v in report['blockers']):
        raise QueueError('report blockers must be a list of nonempty strings')
    if report['status'] in ('blocked', 'failed') and not report['blockers']:
        raise QueueError('blocked or failed report must identify a blocker')
    if not isinstance(report['checks'], list) or not report['checks']:
        raise QueueError('report requires checks with results and evidence')
    for check in report['checks']:
        if not isinstance(check, dict) or set(check) != {'name', 'result', 'evidence'} or check['result'] not in ('pass', 'fail', 'unverified'):
            raise QueueError('each check requires name, result (pass/fail/unverified) and evidence')
        if any(not isinstance(check[k], str) or not check[k].strip() for k in ('name', 'evidence')):
            raise QueueError('check name and evidence cannot be empty')
    if report['status'] == 'ready_for_review' and (report['blockers'] or any(c['result'] != 'pass' for c in report['checks'])):
        raise QueueError('ready_for_review requires passing checks and no blockers')


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise QueueError('invalid arguments; use --help or COMMAND --help')


def parser() -> argparse.ArgumentParser:
    p = Parser(description=__doc__)
    p.add_argument('--state-dir', type=Path, default=DEFAULT_STATE)
    commands = p.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init', help='initialize private state and coordinator identity')
    init.add_argument('--coordinator', required=True, type=identifier)
    reg = commands.add_parser('register', help='register this worker and its exclusive checkout')
    reg.add_argument('--worker', required=True, type=identifier)
    reg.add_argument('--platform', required=True, choices=['codex', 'claude-code'])
    reg.add_argument('--thread', type=identifier)
    reg.add_argument('--host', default='local', type=identifier)
    reg.add_argument('--checkout', required=True)
    enq = commands.add_parser('enqueue', help='coordinator: store an immutable assignment')
    enq.add_argument('--actor', required=True, type=identifier)
    enq.add_argument('--worker', required=True, type=identifier)
    enq.add_argument('--task', required=True, type=identifier)
    enq.add_argument('--key', required=True, type=identifier)
    enq.add_argument('--prompt-file', required=True)
    enq.add_argument('--problem', type=identifier)
    enq.add_argument('--correction', action='store_true')
    nxt = commands.add_parser('next', help='worker: atomically claim one new assignment; never replay it')
    nxt.add_argument('--worker', required=True, type=identifier)
    nxt.add_argument('--wait', type=float, default=0)
    nxt.add_argument('--lease', type=int, default=1800)
    for name in ('renew', 'report'):
        sub = commands.add_parser(name, help=f'worker: {name} an owned lease')
        sub.add_argument('--worker', required=True, type=identifier)
        sub.add_argument('--task', required=True, type=identifier)
        sub.add_argument('--token', required=True)
        if name == 'renew':
            sub.add_argument('--lease', type=int, default=1800)
        else:
            sub.add_argument('--report-file', required=True)
    status = commands.add_parser('status', aliases=['list'], help='list registrations, assignment states and event cursor')
    status.add_argument('--markdown', action='store_true', help='emit a read-only human work queue board')
    ev = commands.add_parser('events', help='read immutable events after a monotonic cursor')
    ev.add_argument('--after', type=int, default=0)
    ev.add_argument('--limit', type=int, default=100)
    for name in ('pause', 'resume', 'reconcile'):
        sub = commands.add_parser(name, help=f'coordinator: {name}')
        sub.add_argument('--actor', required=True, type=identifier)
        if name == 'reconcile':
            sub.add_argument('--task', required=True, type=identifier)
            sub.add_argument('--reason', required=True)
    checkpoint = commands.add_parser('checkpoint', help='coordinator: save last processed event cursor')
    checkpoint.add_argument('--actor', required=True, type=identifier)
    checkpoint.add_argument('--cursor', required=True, type=int)
    decision = commands.add_parser('decision', help='coordinator: append an immutable decision or acceptance note')
    decision.add_argument('--actor', required=True, type=identifier)
    decision.add_argument('--key', required=True, type=identifier)
    decision.add_argument('--note-file', required=True)
    return p


def main() -> int:
    queue = None
    try:
        args = parser().parse_args()
        if hasattr(args, 'lease') and not 60 <= args.lease <= 3600:
            raise QueueError('lease must be 60–3600 seconds')
        if hasattr(args, 'wait') and not 0 <= args.wait <= 55:
            raise QueueError('wait must be 0–55 seconds')
        if args.command == 'events' and (args.after < 0 or not 1 <= args.limit <= 1000):
            raise QueueError('cursor must be nonnegative and limit 1–1000')
        queue = Queue(args.state_dir, create=args.command == 'init')
        command = args.command
        if command == 'init':
            result = queue.initialize(args.coordinator)
        elif command == 'register':
            result = queue.register(args.worker, args.platform, args.thread, args.checkout, args.host)
        elif command == 'enqueue':
            result = queue.enqueue(args.actor, args.worker, args.task, args.key, read_input(args.prompt_file), args.problem, args.correction)
        elif command == 'next':
            deadline = time.monotonic() + args.wait
            while True:
                result = queue.next(args.worker, args.lease)
                remaining = deadline - time.monotonic()
                if result['state'] != 'idle' or remaining <= 0:
                    break
                time.sleep(min(0.2, remaining))
        elif command == 'renew':
            result = queue.renew(args.worker, args.task, args.token, args.lease)
        elif command == 'report':
            result = queue.report(args.worker, args.task, args.token, read_input(args.report_file, json_input=True))
        elif command in ('status', 'list'):
            result = queue.status()
        elif command == 'events':
            result = queue.events(args.after, args.limit)
        elif command in ('pause', 'resume'):
            result = queue.pause(args.actor, command == 'pause')
        elif command == 'checkpoint':
            result = queue.checkpoint(args.actor, args.cursor)
        elif command == 'decision':
            result = queue.decision(args.actor, args.key, read_input(args.note_file))
        else:
            result = queue.reconcile(args.actor, args.task, args.reason)
        if command in ('status', 'list') and args.markdown:
            print(f"# Executor queue\n\nPaused: {bool(result['paused'])}. Events: {result['cursor']}. Processed: {result['checkpoint']}.\n")
            print('| Task | Worker | State |\n| --- | --- | --- |')
            for task in result['assignments']:
                print(f"| {task['task_id']} | {task['worker']} | {task['state']} |")
            if not result['assignments']:
                print('| No assignments | — | — |')
            return 0
        print(encode({'ok': True, **result}))
        return 0
    except QueueError as exc:
        print(encode({'ok': False, 'error': str(exc)}))
        return 2
    except (OSError, sqlite3.Error, ValueError, TypeError):
        print(encode({'ok': False, 'error': 'input or database operation failed; verify private paths, valid input and queue availability'}))
        return 2
    finally:
        if queue:
            queue.close()


if __name__ == '__main__':
    sys.exit(main())
