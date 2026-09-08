import type { RunSnapshot } from '../../shared/protocol.js'

export const SNAPSHOT_FORMAT_VERSION = 1

export interface SnapshotExport {
  formatVersion: typeof SNAPSHOT_FORMAT_VERSION
  exportedAt: string
  snapshot: RunSnapshot
}

export function serializeSnapshot(snapshot: RunSnapshot, exportedAt: Date): string {
  const { seq, run, stats, agents, thread, pipeline, typing } = snapshot
  const data: SnapshotExport = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    snapshot: { seq, run, stats, agents, thread, pipeline, typing },
  }
  return `${JSON.stringify(data, null, 2)}\n`
}

function safePart(value: string): string {
  const part = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  return part || 'run'
}

export function snapshotFilename(runId: string, exportedAt: Date): string {
  const time = exportedAt.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-')
  return `agent-chatroom-${safePart(runId)}-${time}.json`
}
