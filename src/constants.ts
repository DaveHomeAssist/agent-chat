import type { ThreadFilter } from './types'

/** Slash-command shortcuts that prefill the composer; the server parses them. */
export const QUICK_COMMANDS: { label: string; draft: string }[] = [
  { label: '/approve merge #482', draft: '/approve merge' },
  {
    label: '/assign probe re-run',
    draft: '/assign probe re-run the full suite on the latest push and post the failing traces',
  },
  { label: '/rollback build', draft: '/rollback build' },
]

export const FILTER_DEFS: { key: ThreadFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'tools', label: 'Tool calls' },
  { key: 'handoffs', label: 'Handoffs' },
]
