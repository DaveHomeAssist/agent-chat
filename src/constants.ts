import type { ThreadFilter } from '../shared/protocol.js'

/** Slash-command shortcuts that prefill the composer; the server parses them. */
export interface QuickCommand {
  label: string
  draft: string
  disabled: boolean
  reason?: string
}

const RUN_COMMANDS: QuickCommand[] = [
  {
    label: '/assign probe re-run',
    draft: '/assign probe re-run the full suite on the latest push and post the failing traces',
    disabled: false,
  },
  { label: '/rollback build', draft: '/rollback build', disabled: false },
]

export function quickCommands(pipelinePr: string): QuickCommand[] {
  const currentPr = pipelinePr.trim()
  const merge: QuickCommand = currentPr
    ? {
        label: `/approve merge ${currentPr.replace(/^PR\s+/i, '')}`,
        draft: '/approve merge',
        disabled: false,
      }
    : {
        label: '/approve merge · no PR',
        draft: '/approve merge',
        disabled: true,
        reason: 'No pull request is associated with this run.',
      }
  return [merge, ...RUN_COMMANDS]
}

export const FILTER_DEFS: { key: ThreadFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'tools', label: 'Tool calls' },
  { key: 'handoffs', label: 'Handoffs' },
]
