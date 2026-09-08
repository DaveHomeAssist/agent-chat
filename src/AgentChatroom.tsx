import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react'
import { useRun } from './api/useRun'
import { fetchState } from './api/client'
import type { ConnectionStatus } from './api/client'
import { AgentDetail } from './components/AgentDetail'
import { AgentSidebar } from './components/AgentSidebar'
import { ChatPanel } from './components/ChatPanel'
import { PipelinePanel } from './components/PipelinePanel'
import { RunHeader } from './components/RunHeader'
import { deriveAgentActivity } from './lib/activity'
import { serializeSnapshot, snapshotFilename } from './lib/snapshot'
import type { AppTheme } from './lib/theme'
import type {
  Agent,
  AgentId,
  DetailTab,
  MessageTarget,
  Pipeline,
  RunInfo,
  ThreadFilter,
  ThreadItem,
  TrackerMode,
} from './types'

export interface AgentChatroomProps {
  /** Accent used for selection, the send button and the human broadcast card. */
  accent?: string
  /** Which face of the pipeline tracker opens first. */
  trackerMode?: TrackerMode
  /** Status pulses, the progress sweep and the log cursor. */
  liveMotion?: boolean
  /** Shared visual theme; changing it never reconnects or remounts the console. */
  theme?: AppTheme
  onToggleTheme?: () => void
}

type MobilePanel = 'room' | 'agents' | 'context'

const MOBILE_PANELS: ReadonlyArray<readonly [MobilePanel, string]> = [
  ['room', 'Room'],
  ['agents', 'Agents'],
  ['context', 'Context'],
]

const COMPACT_VIEWPORT = '(max-width: 1120px)'
const noop = () => {}

function isCompactViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(COMPACT_VIEWPORT).matches
}

/** Status badges are not decisions: test ratios like "22/24", and BLOCKED. PLAN / RISK / ACK are. */
const isDecisionBadge = (badge: string) => badge !== 'BLOCKED' && !/^\d+\/\d+$/.test(badge)

const FILTERS: Record<ThreadFilter, (m: ThreadItem) => boolean> = {
  all: () => true,
  decisions: (m) =>
    m.kind === 'divider' ||
    m.kind === 'human' ||
    (m.kind === 'message' && !!m.badge && isDecisionBadge(m.badge)),
  tools: (m) => m.kind === 'tool',
  handoffs: (m) => m.kind === 'handoff' || m.kind === 'divider',
}

const FILTER_KEYS = Object.keys(FILTERS) as ThreadFilter[]

const EMPTY_PIPELINE: Pipeline = { phase: 'spec', lanes: [], steps: [], pr: '' }

/** "isolating 2 failures" → as is; "POST /webauthn/register · migration 0043" → "working on POST /webauthn/register". */
function typingVerb(agent: Agent): string {
  const head = agent.subtask.split('·')[0].trim()
  if (!head || /^[—–-]$/.test(head)) return 'thinking'
  // Lower-case a leading capital only when it starts a word, never an acronym like POST or ADR-0142.
  const phrase = /^[A-Z][a-z]/.test(head) ? head.charAt(0).toLowerCase() + head.slice(1) : head
  return /^\S+ing\b/i.test(phrase) ? phrase : `working on ${phrase}`
}

interface Banner {
  tone: 'warn' | 'error' | 'info'
  text: string
}

function bannerFor(
  connection: ConnectionStatus,
  run: RunInfo | null,
  lastError: string | null,
  model: string,
): Banner | null {
  if (connection === 'connecting') return { tone: 'warn', text: '● connecting to run server…' }
  if (connection === 'reconnecting') return { tone: 'warn', text: '● reconnecting to run server…' }
  if (lastError) return { tone: 'error', text: `● ${lastError}` }
  if (run?.status === 'failed') return { tone: 'error', text: `● run failed — ${run.error || 'unknown error'}` }
  if (!run || run.status === 'idle') return { tone: 'info', text: `● Start run to begin — using ${model}` }
  return null
}

export function AgentChatroom({
  accent = '#4C8CFF',
  trackerMode = 'board',
  liveMotion = true,
  theme = 'light',
  onToggleTheme = noop,
}: AgentChatroomProps) {
  const { snapshot, connection, lastError, actions } = useRun()

  const [selectedId, setSelectedId] = useState<AgentId>('forge')
  const [tab, setTab] = useState<DetailTab>('subtask')
  const [filter, setFilter] = useState<ThreadFilter>('all')
  const [detailOpen, setDetailOpen] = useState(true)
  const [tracker, setTracker] = useState<TrackerMode>(trackerMode)
  const [target, setTarget] = useState<MessageTarget>('all')
  const [draft, setDraft] = useState('')
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})
  const [snapshotPending, setSnapshotPending] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('room')
  const snapshotExporting = useRef(false)
  const snapshotRequest = useRef<AbortController | null>(null)
  const composerRef = useRef<HTMLInputElement>(null)
  const contextPanelRef = useRef<HTMLElement>(null)
  const roomNavRef = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<'context' | 'composer' | 'room-nav' | 'restore' | null>(null)
  const lastPanelFocus = useRef<{ panel: MobilePanel; element: HTMLElement } | null>(null)
  const stableFocus = useRef<HTMLElement | null>(null)
  const restoreTarget = useRef<HTMLElement | null>(null)
  const mobilePanelRef = useRef(mobilePanel)
  mobilePanelRef.current = mobilePanel

  useEffect(() => () => { snapshotRequest.current?.abort() }, [])

  useEffect(() => {
    const query = window.matchMedia(COMPACT_VIEWPORT)
    let stableFocusFrame: number | null = null
    const preserveVisiblePanel = (event: MediaQueryListEvent) => {
      if (!event.matches) return
      const stable = stableFocus.current
      if (stable) {
        stableFocusFrame = window.requestAnimationFrame(() => {
          stableFocusFrame = null
          const rect = stable.getBoundingClientRect()
          const style = getComputedStyle(stable)
          if (
            stableFocus.current === stable
            && stable.isConnected
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0
            && document.activeElement !== stable
          ) {
            stable.focus({ preventScroll: true })
          }
        })
        return
      }
      const remembered = lastPanelFocus.current
      if (!remembered || remembered.panel === mobilePanelRef.current) return
      restoreTarget.current = remembered.element
      pendingFocus.current = 'restore'
      if (remembered.panel === 'agents') setMobilePanel('agents')
      else if (remembered.panel === 'context') {
        setDetailOpen(true)
        setMobilePanel('context')
      } else setMobilePanel('room')
    }
    query.addEventListener('change', preserveVisiblePanel)
    return () => {
      query.removeEventListener('change', preserveVisiblePanel)
      if (stableFocusFrame !== null) window.cancelAnimationFrame(stableFocusFrame)
    }
  }, [])

  useEffect(() => {
    const rememberStableFocus = (event: FocusEvent) => {
      const element = event.target
      if (!(element instanceof HTMLElement)) return
      if (element.closest('.ac-header, .ac-session-bar')) {
        stableFocus.current = element
        lastPanelFocus.current = null
        restoreTarget.current = null
        if (pendingFocus.current === 'restore') pendingFocus.current = null
      }
    }
    document.addEventListener('focusin', rememberStableFocus)
    return () => document.removeEventListener('focusin', rememberStableFocus)
  }, [])

  useEffect(() => {
    const destination = pendingFocus.current
    if (!destination || !isCompactViewport()) return
    pendingFocus.current = null
    const element = destination === 'context'
      ? contextPanelRef.current
      : destination === 'composer'
        ? composerRef.current
        : destination === 'room-nav'
          ? roomNavRef.current
          : restoreTarget.current
    element?.focus({ preventScroll: true })
  }, [detailOpen, mobilePanel, selectedId])

  const rememberPanelFocus = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    const element = event.target
    if (!(element instanceof HTMLElement)) return
    stableFocus.current = null
    if (element.closest('.ac-sidebar')) lastPanelFocus.current = { panel: 'agents', element }
    else if (element.closest('.ac-detail')) lastPanelFocus.current = { panel: 'context', element }
    else if (element.closest('.ac-main')) lastPanelFocus.current = { panel: 'room', element }
  }, [])

  const run = snapshot?.run ?? null
  const stats = snapshot?.stats ?? null
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot])
  const thread = useMemo(() => snapshot?.thread ?? [], [snapshot])
  const pipeline = snapshot?.pipeline ?? EMPTY_PIPELINE
  const typing = snapshot?.typing ?? []

  const agentsById = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a])) as Record<AgentId, Agent>,
    [agents],
  )
  const targets = useMemo<MessageTarget[]>(() => ['all', ...agents.map((a) => a.id)], [agents])

  const selectedAgent: Agent | undefined = agentsById[selectedId] ?? agents[0]
  const selectedActivity = deriveAgentActivity(connection, run, selectedAgent ?? null, typing)
  const gate = run?.approvalGate ?? true
  const paused = run?.status === 'paused'

  const selectAgent = useCallback((id: AgentId) => {
    const active = document.activeElement
    if (isCompactViewport() && active instanceof HTMLElement && active.closest('.ac-sidebar')) {
      pendingFocus.current = 'context'
    }
    setSelectedId(id)
    setDetailOpen(true)
    setMobilePanel('context')
  }, [])

  const toggleDetail = useCallback(() => {
    setDetailOpen((open) => {
      setMobilePanel(open ? 'room' : 'context')
      return !open
    })
  }, [])

  const showMobilePanel = useCallback((panel: MobilePanel) => {
    if (panel === 'context') setDetailOpen(true)
    setMobilePanel(panel)
  }, [])

  const toggleTool = useCallback((id: string) => {
    setOpenTools((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body) return
    if (await actions.send(body, target)) setDraft('')
  }, [draft, target, actions])

  const runAction = useCallback(() => {
    switch (run?.status ?? 'idle') {
      case 'live':
        return actions.pause()
      case 'paused':
        return actions.resume()
      case 'needs_approval':
        return actions.approve()
      default:
        return actions.start()
    }
  }, [run?.status, actions])

  const exportSnapshot = useCallback(async () => {
    if (!snapshot || snapshotExporting.current) return
    snapshotExporting.current = true
    setSnapshotPending(true)
    setSnapshotError(null)
    const controller = new AbortController()
    snapshotRequest.current = controller
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const freshSnapshot = await fetchState(controller.signal)
      if (controller.signal.aborted) return
      const exportedAt = new Date()
      const filename = snapshotFilename(freshSnapshot.run.id, exportedAt)
      const blob = new Blob([serializeSnapshot(freshSnapshot, exportedAt)], {
        type: 'application/json;charset=utf-8',
      })
      const anchor = document.createElement('a')
      const url = URL.createObjectURL(blob)
      let clicked = false
      try {
        anchor.href = url
        anchor.download = filename
        anchor.hidden = true
        document.body.appendChild(anchor)
        anchor.click()
        clicked = true
      } finally {
        anchor.remove()
        // Leave time for the browser to accept the download before revoking it.
        if (clicked) setTimeout(() => URL.revokeObjectURL(url), 1000)
        else URL.revokeObjectURL(url)
      }
    } catch (err) {
      setSnapshotError(controller.signal.aborted ? 'Request timed out. Try again.' : err instanceof Error ? err.message : 'Download could not be started.')
    } finally {
      clearTimeout(timeout)
      if (snapshotRequest.current === controller) snapshotRequest.current = null
      snapshotExporting.current = false
      setSnapshotPending(false)
    }
  }, [snapshot])

  // Items whose author is not in the roster cannot be drawn; the server never emits them.
  const known = useCallback(
    (m: ThreadItem) => !('who' in m) || m.who in agentsById,
    [agentsById],
  )
  const shown = useMemo(() => thread.filter(known).filter(FILTERS[filter]), [thread, known, filter])
  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTER_KEYS.map((k) => [k, thread.filter(FILTERS[k]).length]),
      ) as Record<ThreadFilter, number>,
    [thread],
  )

  const typingLabel =
    paused
      ? ''
      : typing
          .map((id) => agentsById[id])
          .filter((a): a is Agent => !!a)
          .map((a) => `${a.name} is ${typingVerb(a)}`)
          .join(' · ')

  const targetAgent = target === 'all' ? undefined : agentsById[target]
  const targetLabel = targetAgent ? `Direct → ${targetAgent.name}` : 'Broadcast → all agents'
  const targetColor = targetAgent ? targetAgent.color : accent

  const model =
    run?.llm === 'mock' ? 'the scripted mock' : (agentsById.atlas?.model ?? 'claude-opus-5')
  const banner = bannerFor(connection, run, lastError, model)

  return (
    <div className="ac-app" data-theme={theme} data-mobile-panel={mobilePanel}>
      <RunHeader
        accent={accent}
        run={run}
        stats={stats}
        live={liveMotion}
        detailOpen={detailOpen}
        snapshotAvailable={snapshot !== null && connection === 'live'}
        snapshotPending={snapshotPending}
        snapshotError={snapshotError}
        theme={theme}
        onRunAction={runAction}
        onToggleDetail={toggleDetail}
        onSnapshot={exportSnapshot}
        onToggleTheme={onToggleTheme}
      />

      {banner ? <div className={`ac-banner ac-banner--${banner.tone}`} role={banner.tone === 'error' ? 'alert' : 'status'}>{banner.text}</div> : null}
      {snapshotError ? (
        <div id="ac-snapshot-error" className="ac-banner ac-banner--error ac-snapshot-error" role="alert">
          Snapshot failed: {snapshotError}
        </div>
      ) : null}

      <div className="ac-body" onFocusCapture={rememberPanelFocus}>
        <AgentSidebar
          agents={agents}
          selected={selectedAgent?.id ?? null}
          live={liveMotion}
          accent={accent}
          gate={gate}
          stats={stats}
          theme={theme}
          onSelect={selectAgent}
          onToggleGate={() => actions.setGate(!gate)}
        />

        <ChatPanel
          thread={shown}
          agents={agentsById}
          accent={accent}
          channelName={run?.channel ?? ''}
          channelMeta={run ? `started ${run.startedAt} · ${agents.length} agents · ${run.toolServers} tool servers` : ''}
          pipelinePr={pipeline.pr}
          filter={filter}
          counts={counts}
          onFilter={setFilter}
          openTools={openTools}
          onToggleTool={toggleTool}
          typingLabel={typingLabel}
          draft={draft}
          onDraft={setDraft}
          onSend={send}
          targetLabel={targetLabel}
          targetColor={targetColor}
          onCycleTarget={() =>
            setTarget((t) => targets[(targets.indexOf(t) + 1) % targets.length])
          }
          composerRef={composerRef}
        />

        {detailOpen ? (
          <aside ref={contextPanelRef} className="ac-detail" tabIndex={-1} aria-label="Pipeline and agent context">
            <PipelinePanel
              mode={tracker}
              onMode={setTracker}
              pipeline={pipeline}
              accent={accent}
              agents={agentsById}
              onSelectAgent={selectAgent}
            />
            {selectedAgent ? (
              <AgentDetail
                agent={selectedAgent}
                tab={tab}
                onTab={setTab}
                accent={accent}
                live={liveMotion}
                activity={selectedActivity}
                theme={theme}
                onClose={() => {
                  if (isCompactViewport()) pendingFocus.current = 'room-nav'
                  setDetailOpen(false)
                  setMobilePanel('room')
                }}
                onMessage={() => {
                  if (isCompactViewport()) pendingFocus.current = 'composer'
                  setTarget(selectedAgent.id)
                  setDraft(`@${selectedAgent.name} `)
                  setMobilePanel('room')
                }}
                onInterrupt={() => actions.interrupt(selectedAgent.id)}
              />
            ) : (
              <div className="ac-agentpane" />
            )}
          </aside>
        ) : (
          <aside className="ac-rail">
            <button className="ac-rail-btn" onClick={() => {
              setDetailOpen(true)
              setMobilePanel('context')
            }}>
              ‹
            </button>
            <div className="ac-rail-label">PIPELINE · AGENT DETAIL</div>
          </aside>
        )}
      </div>

      <nav className="ac-mobile-nav" aria-label="Console panels">
        {MOBILE_PANELS.map(([panel, label]) => (
          <button
            key={panel}
            ref={panel === 'room' ? roomNavRef : undefined}
            type="button"
            aria-current={mobilePanel === panel ? 'page' : undefined}
            onClick={() => showMobilePanel(panel)}
          >
            <span className={`ac-mobile-nav-icon ac-mobile-nav-icon--${panel}`} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
