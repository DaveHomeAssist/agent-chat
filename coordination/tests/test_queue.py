"""Protocol regression tests. Uses only the Python standard library."""

import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

CLI = Path(__file__).resolve().parents[1] / 'queue.py'
spec = importlib.util.spec_from_file_location('coordination_queue', CLI)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Queue, QueueError = module.Queue, module.QueueError


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='coordination-test-')
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / 'state'
        self.checkout = self.root / 'worker-repo'
        self.checkout.mkdir()
        (self.checkout / '.git').mkdir()
        self.q = Queue(self.state, create=True)
        self.q.initialize('coordinator-test')
        self.q.register('test-worker', 'codex', 'test-thread', str(self.checkout))

    def tearDown(self):
        self.q.close()
        self.temp.cleanup()

    def enqueue(self, task='task-1', **kwargs):
        return self.q.enqueue('coordinator-test', 'test-worker', task, task, 'Read-only test prompt', kwargs.get('problem'), kwargs.get('correction', False))

    def claim(self):
        self.enqueue()
        return self.q.next('test-worker', 60)

    def report(self, claim):
        return {'task_id': claim['task_id'], 'status': 'ready_for_review', 'summary': 'Fixture checked',
                'checkout': str(self.checkout), 'branch': 'test/fixture', 'commit': 'a' * 40,
                'pr_url': None, 'checks': [{'name': 'fixture', 'result': 'pass', 'evidence': 'isolated test fixture'}],
                'blockers': [], 'next_action': 'Coordinator review'}

    def cli(self, *args, expected=0, env=None):
        process = subprocess.run([sys.executable, str(CLI), '--state-dir', str(self.state), *args],
                                 capture_output=True, text=True, timeout=10, env=env)
        self.assertEqual(process.returncode, expected, process.stdout + process.stderr)
        return json.loads(process.stdout)

    def test_duplicate_enqueue_is_idempotent_and_immutable(self):
        self.assertFalse(self.enqueue()['duplicate'])
        self.assertTrue(self.enqueue()['duplicate'])
        with self.assertRaises(QueueError):
            self.q.enqueue('coordinator-test', 'test-worker', 'task-1', 'task-1', 'Changed', None, False)
        self.assertEqual(len(self.q.status()['assignments']), 1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.q.db.execute("UPDATE assignments SET prompt='changed'")

    def test_can_queue_before_registration_but_not_claim(self):
        self.q.enqueue('coordinator-test', 'future-worker', 'future-task', 'future-key', 'Read-only', None, False)
        with self.assertRaises(QueueError):
            self.q.next('future-worker', 60)
        self.assertEqual(self.q.status()['assignments'][0]['state'], 'queued')

    def test_concurrent_claim_exactly_once(self):
        self.enqueue()
        commands = [subprocess.Popen([sys.executable, str(CLI), '--state-dir', str(self.state), 'next', '--worker', 'test-worker'],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(8)]
        results = []
        for process in commands:
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stdout + stderr)
            results.append(json.loads(stdout))
        self.assertEqual(sum('prompt' in result for result in results), 1)
        self.assertEqual(sum('lease_token' in result for result in results), 1)
        self.assertEqual(sum(e['kind'] == 'claimed' for e in self.q.events(0, 100)['events']), 1)

    def test_worker_identity_and_lease_validation(self):
        claim = self.claim()
        for worker, token in [('other-worker', claim['lease_token']), ('test-worker', 'incorrect')]:
            with self.assertRaises(QueueError):
                self.q.renew(worker, claim['task_id'], token, 60)
            with self.assertRaises(QueueError):
                self.q.report(worker, claim['task_id'], token, self.report(claim))
        self.assertGreater(self.q.renew('test-worker', 'task-1', claim['lease_token'], 120)['lease_until'], claim['lease_until'])
        self.assertNotIn('lease_token', self.q.next('test-worker', 60))

    def test_report_validation_and_idempotency(self):
        claim = self.claim()
        report = self.report(claim)
        for key, invalid in [('commit', None), ('task_id', 'other'), ('checkout', '/other'), ('checks', []), ('summary', ''), ('status', 'complete')]:
            with self.assertRaises(QueueError):
                self.q.report('test-worker', 'task-1', claim['lease_token'], {**report, key: invalid})
        self.assertFalse(self.q.report('test-worker', 'task-1', claim['lease_token'], report)['duplicate'])
        self.assertTrue(self.q.report('test-worker', 'task-1', claim['lease_token'], report)['duplicate'])
        with self.assertRaises(QueueError):
            self.q.report('test-worker', 'task-1', claim['lease_token'], {**report, 'summary': 'changed'})
        with self.assertRaises(sqlite3.IntegrityError):
            self.q.db.execute("DELETE FROM reports")

    def test_failed_or_blocked_report_requires_evidence(self):
        claim = self.claim()
        report = {**self.report(claim), 'status': 'blocked'}
        with self.assertRaises(QueueError):
            self.q.report('test-worker', 'task-1', claim['lease_token'], report)
        report['blockers'] = ['Fixture intentionally unavailable']
        report['checks'][0]['result'] = 'unverified'
        self.assertEqual(self.q.report('test-worker', 'task-1', claim['lease_token'], report)['status'], 'blocked')

    def test_pause_and_resume_do_not_cancel_active_lease(self):
        claim = self.claim()
        self.q.pause('coordinator-test', True)
        self.assertEqual(self.q.next('test-worker', 60)['state'], 'paused')
        self.q.report('test-worker', 'task-1', claim['lease_token'], self.report(claim))
        self.enqueue('task-2')
        self.assertEqual(self.q.next('test-worker', 60)['state'], 'paused')
        self.q.pause('coordinator-test', False)
        self.assertEqual(self.q.next('test-worker', 60)['task_id'], 'task-2')

    def test_stale_lease_never_auto_requeued(self):
        claim = self.claim()
        self.enqueue('task-2')
        self.q.db.execute('UPDATE assignments SET lease_until=? WHERE task_id=?', (time.time() - 1, 'task-1'))
        with self.assertRaises(QueueError):
            self.q.report('test-worker', 'task-1', claim['lease_token'], self.report(claim))
        result = self.q.next('test-worker', 60)
        self.assertEqual(result['state'], 'stale')
        self.assertNotIn('prompt', result)
        self.q.reconcile('coordinator-test', 'task-1', 'Verified test fixture only; no side effects')
        self.assertEqual(self.q.next('test-worker', 60)['task_id'], 'task-2')
        self.assertEqual(self.q.status()['assignments'][0]['state'], 'reconciled')

    def test_interrupted_report_is_atomic(self):
        claim = self.claim()
        original = self.q.event
        def interrupt(*args, **kwargs):
            raise KeyboardInterrupt()
        self.q.event = interrupt
        with self.assertRaises(KeyboardInterrupt):
            self.q.report('test-worker', 'task-1', claim['lease_token'], self.report(claim))
        self.q.event = original
        self.q.close()
        self.q = Queue(self.state)
        self.assertEqual(self.q.status()['assignments'][0]['state'], 'claimed')
        self.assertEqual(self.q.db.execute('SELECT count(*) FROM reports').fetchone()[0], 0)
        self.q.report('test-worker', 'task-1', claim['lease_token'], self.report(claim))

    def test_restart_checkpoint_decisions_and_event_cursor(self):
        self.enqueue()
        cursor = self.q.events(0, 100)['cursor']
        self.q.decision('coordinator-test', 'decision-1', 'A plain-data acceptance note; never shell')
        self.assertTrue(self.q.decision('coordinator-test', 'decision-1', 'A plain-data acceptance note; never shell')['duplicate'])
        self.q.checkpoint('coordinator-test', cursor)
        self.q.close()
        self.q = Queue(self.state)
        self.assertEqual(self.q.status()['checkpoint'], cursor)
        events = self.q.events(cursor, 100)['events']
        self.assertEqual([e['kind'] for e in events], ['decision'])
        self.assertTrue(all(e['cursor'] > cursor for e in events))
        with self.assertRaises(QueueError):
            self.q.checkpoint('coordinator-test', 0)
        with self.assertRaises(sqlite3.IntegrityError):
            self.q.db.execute("UPDATE events SET kind='changed'")

    def test_idle_checkpoint_cycles_settle_without_new_events(self):
        self.enqueue()
        cursor = self.q.status()['checkpoint']
        first = self.q.events(cursor, 100)
        self.q.checkpoint('coordinator-test', first['cursor'])
        for _ in range(3):
            current = self.q.status()
            batch = self.q.events(current['checkpoint'], 100)
            self.assertEqual(batch['events'], [])
            self.q.checkpoint('coordinator-test', batch['cursor'])
            self.assertEqual(self.q.status()['cursor'], first['cursor'])

    def test_registration_changes_recorded_and_checkouts_exclusive(self):
        self.q.register('test-worker', 'codex', 'replacement-thread', str(self.checkout))
        self.assertEqual(self.q.events(0, 100)['events'][-1]['kind'], 'worker_updated')
        with self.assertRaises(QueueError):
            self.q.register('other', 'claude-code', None, str(self.checkout))
        with self.assertRaises(QueueError):
            self.q.register('other', 'codex', None, '/Users/daverobertson/Code/agent-chat')
        self.claim()
        with self.assertRaises(QueueError):
            self.q.register('test-worker', 'codex', 'another-thread', str(self.checkout))

    def test_coordinator_identity_and_corrective_limit(self):
        with self.assertRaises(QueueError):
            self.q.pause('not-the-coordinator', True)
        self.enqueue('correction-1', problem='unchanged', correction=True)
        self.enqueue('correction-2', problem='unchanged', correction=True)
        with self.assertRaises(QueueError):
            self.enqueue('correction-3', problem='unchanged', correction=True)

    def test_permissions_and_no_secret_environment_output(self):
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.q.path.stat().st_mode & 0o777, 0o600)
        sentinel = 'PRIVATE_SENTINEL_DO_NOT_PRINT'
        env = dict(os.environ, OPENAI_API_KEY=sentinel, ANTHROPIC_API_KEY=sentinel)
        output = self.cli('status', env=env)
        self.assertNotIn(sentinel, json.dumps(output))
        result = self.cli('next', '--worker', sentinel + '\ninvalid', env=env, expected=2)
        self.assertNotIn(sentinel, json.dumps(result))
        self.state.chmod(0o755)
        with self.assertRaises(QueueError):
            Queue(self.state)
        self.state.chmod(0o700)

    def test_bounded_wait_and_human_board(self):
        start = time.monotonic()
        self.assertEqual(self.cli('next', '--worker', 'test-worker', '--wait', '0.2')['state'], 'idle')
        self.assertLess(time.monotonic() - start, 2)
        self.cli('next', '--worker', 'test-worker', '--wait', '56', expected=2)
        result = subprocess.run([sys.executable, str(CLI), '--state-dir', str(self.state), 'status', '--markdown'], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertIn('No assignments', result.stdout)

    def test_two_separate_worker_processes_exchange_results(self):
        children = []
        try:
            for name in ('bootstrap-test-one', 'bootstrap-test-two'):
                checkout = self.root / name
                checkout.mkdir()
                (checkout / '.git').mkdir()
                children.append(subprocess.Popen([sys.executable, str(Path(__file__).with_name('smoke_worker.py')),
                    str(self.state), name, str(checkout)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
            # Assign before or after registration; both races must be valid.
            for name in ('bootstrap-test-one', 'bootstrap-test-two'):
                self.q.enqueue('coordinator-test', name, name + '-task', name + '-key', 'Read the fixture; do not modify product code.', None, False)
            results = []
            for child in children:
                stdout, stderr = child.communicate(timeout=15)
                self.assertEqual(child.returncode, 0, stdout + stderr)
                results.append(json.loads(stdout))
            self.assertEqual(len({result['pid'] for result in results}), 2)
            self.assertTrue(all(result['status'] == 'ready_for_review' for result in results))
            reported = [event for event in self.q.events(0, 100)['events'] if event['kind'] == 'reported']
            self.assertEqual({event['worker'] for event in reported}, {'bootstrap-test-one', 'bootstrap-test-two'})
        finally:
            for child in children:
                if child.poll() is None:
                    child.terminate()
                child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
