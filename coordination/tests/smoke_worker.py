"""Test-only worker process. Executes no prompt text or product commands."""
import json
import os
from pathlib import Path
import subprocess
import sys

state, worker, checkout = sys.argv[1:]
cli = Path(__file__).resolve().parents[1] / 'queue.py'


def call(*args):
    result = subprocess.run([sys.executable, str(cli), '--state-dir', state, *args],
                            check=True, capture_output=True, text=True, timeout=8)
    return json.loads(result.stdout)


call('register', '--worker', worker, '--platform', 'claude-code', '--checkout', checkout)
assignment = call('next', '--worker', worker, '--wait', '5')
assert 'lease_token' in assignment
assert assignment['task_id'] == worker + '-task'
assert assignment['prompt'] == 'Read the fixture; do not modify product code.'
report = {'task_id': assignment['task_id'], 'status': 'ready_for_review',
          'summary': 'Separate process received its own immutable test assignment',
          'checkout': assignment['checkout'], 'branch': 'test/fixture', 'commit': 'a' * 40, 'pr_url': None,
          'checks': [{'name': 'received assigned fixture', 'result': 'pass', 'evidence': f'isolated test process {os.getpid()}'}],
          'blockers': [], 'next_action': 'Coordinator inspect test event'}
path = Path(state) / (worker + '-report.json')
path.write_text(json.dumps(report))
path.chmod(0o600)
result = call('report', '--worker', worker, '--task', assignment['task_id'], f"--token={assignment['lease_token']}", '--report-file', str(path))
print(json.dumps({'pid': os.getpid(), 'status': result['status'], 'worker': worker}))
