import { COLOR } from '../lib/theme'
import type { Lane, Step } from '../types'

/**
 * Kanban lanes for the run. The Ship lane changes shape with the approval
 * gate — held for a human, or released to auto-release.
 */
export function lanes(gate: boolean): Lane[] {
  return [
    {
      name: 'Spec',
      color: COLOR.violet,
      state: 'DONE',
      tasks: [
        { title: 'Auth flow spec + ADR', owner: 'vector', meta: 'done' },
        { title: 'Threat model §1–4', owner: 'vector', meta: 'done' },
      ],
    },
    {
      name: 'Build',
      color: COLOR.teal,
      state: '2 ACTIVE',
      tasks: [
        { title: 'POST /webauthn/register', owner: 'forge', meta: '72%' },
        { title: 'Credentials migration 0043', owner: 'forge', meta: 'queued' },
      ],
    },
    {
      name: 'Test',
      color: COLOR.amber,
      state: 'RUNNING',
      tasks: [{ title: 'Register / login e2e', owner: 'probe', meta: '18/24' }],
    },
    {
      name: 'Review',
      color: COLOR.blue,
      state: 'QUEUED',
      tasks: [{ title: 'Diff review · 412 LOC', owner: 'sentry', meta: 'blocked' }],
    },
    {
      name: 'Ship',
      color: COLOR.slate,
      state: gate ? 'NEEDS YOU' : 'AUTO',
      tasks: [
        {
          title: gate ? 'Canary 5% · awaiting approval' : 'Canary 5% · auto-release',
          owner: 'atlas',
          meta: gate ? 'gated' : 'auto',
        },
      ],
    },
  ]
}

/** The same run as an ordered checklist. */
export function steps(gate: boolean): Step[] {
  return [
    { title: 'Spec + ADR-0142', state: 'done', detail: 'Vector · 3 decisions recorded', meta: '14:11', pct: 0 },
    {
      title: 'Threat model signed off',
      state: 'done',
      detail: 'Vector · 4 sections, 1 rejection',
      meta: '14:11',
      pct: 0,
    },
    {
      title: 'Implement register + verify',
      state: 'active',
      detail: 'Forge · 7 files, migration 0043',
      meta: '72%',
      pct: 72,
    },
    {
      title: 'e2e suite green',
      state: 'active',
      detail: 'Probe · 18/24, 2 replay failures',
      meta: '58%',
      pct: 58,
    },
    {
      title: 'Security + diff review',
      state: 'wait',
      detail: 'Sentry · blocked on suite',
      meta: 'queued',
      pct: 0,
    },
    {
      title: gate ? 'Human approval to merge' : 'Auto-merge on green',
      state: 'wait',
      detail: gate ? 'You · gate is held' : 'Atlas · gate disabled',
      meta: '—',
      pct: 0,
    },
    { title: 'Canary 5% → 100%', state: 'wait', detail: 'Atlas · not started', meta: '—', pct: 0 },
  ]
}
