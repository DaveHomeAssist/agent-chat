import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunSnapshot } from '../shared/protocol.js'
import {
  SNAPSHOT_FORMAT_VERSION,
  serializeSnapshot,
  snapshotFilename,
} from '../src/lib/snapshot.js'

const snapshot = {
  seq: 42,
  run: {
    id: 'RUN / 04',
    label: 'RUN 04',
    status: 'needs_approval',
    approvalGate: true,
    channel: 'release',
    repo: 'example/repo',
    branch: 'main',
    goal: 'Ship café support',
    startedAt: '09:00',
    toolServers: 2,
    llm: 'mock',
  },
  stats: {
    elapsedSec: 10,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    costUsd: 0.25,
    unreportedRequests: 1,
    lifetimeUnreportedRequests: 2,
    budgetUsd: 10,
    messages: 5,
    toolCalls: 6,
    handoffs: 7,
    decisions: 8,
  },
  agents: [],
  thread: [{ id: 'human-1', time: '09:01', kind: 'human', body: 'hello 👋', target: 'all' }],
  pipeline: { phase: 'review', lanes: [], steps: [], pr: '#12' },
  typing: [],
} satisfies RunSnapshot

test('serializes the complete public snapshot with version and UTC export time', () => {
  const text = serializeSnapshot(snapshot, new Date('2025-02-03T04:05:06.789Z'))
  const parsed = JSON.parse(text)
  assert.equal(parsed.formatVersion, SNAPSHOT_FORMAT_VERSION)
  assert.equal(parsed.exportedAt, '2025-02-03T04:05:06.789Z')
  assert.deepEqual(parsed.snapshot, snapshot)
  assert.match(text, /hello 👋/u)
  assert.ok(text.endsWith('\n'))
})

test('builds a bounded filesystem-safe filename from run identity and time', () => {
  const name = snapshotFilename('../../RUN / 04:*?', new Date('2025-02-03T04:05:06.789Z'))
  assert.equal(name, 'agent-chatroom-RUN-04-2025-02-03T04-05-06Z.json')
  assert.doesNotMatch(name, /[\\/:*?"<>]/)
})

test('exports public snapshot fields without mutating state or including extra execution context', () => {
  const input = { ...structuredClone(snapshot), privateContext: { providerState: 'must remain private' } }
  const original = structuredClone(input)
  const parsed = JSON.parse(serializeSnapshot(input, new Date('2026-09-08T00:00:00Z')))
  assert.deepEqual(parsed.snapshot, snapshot)
  assert.deepEqual(input, original)
  assert.equal('privateContext' in parsed.snapshot, false)
  assert.equal(parsed.snapshot.run.approvalGate, true)
  assert.equal(parsed.snapshot.stats.unreportedRequests, 1)
})

test('filenames remain safe for empty, Unicode and long run identifiers', () => {
  const at = new Date('2026-09-08T00:00:00Z')
  assert.equal(snapshotFilename('...///', at), 'agent-chatroom-run-2026-09-08T00-00-00Z.json')
  assert.match(snapshotFilename('café 👋', at), /^agent-chatroom-cafe-/)
  assert.ok(snapshotFilename('a'.repeat(1000), at).length < 130)
  assert.throws(() => serializeSnapshot(snapshot, new Date('invalid')), RangeError)
})
