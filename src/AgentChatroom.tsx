import { useCallback, useMemo, useState } from 'react'
import { useRun } from './api/useRun'
import type { ConnectionStatus } from './api/client'
import { AgentDetail } from './components/AgentDetail'
import { AgentSidebar } from './components/AgentSidebar'
import { ChatPanel } from './components/ChatPanel'
import { PipelinePanel } from './components/PipelinePanel'
import { RunHeader } from './components/RunHeader'
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
  const gate = run?.approvalGate ?? true
  const paused = run?.status === 'paused'

  const selectAgent = useCallback((id: AgentId) => {
    setSelectedId(id)
    setDetailOpen(true)
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
    <div className="ac-app">
      <RunHeader
        accent={accent}
        run={run}
        stats={stats}
        live={liveMotion}
        detailOpen={detailOpen}
        onRunAction={runAction}
        onToggleDetail={() => setDetailOpen((d) => !d)}
      />

      {banner ? <div className={`ac-banner ac-banner--${banner.tone}`}>{banner.text}</div> : null}

      <div className="ac-body">
        <AgentSidebar
          agents={agents}
          selected={selectedAgent?.id ?? null}
          live={liveMotion}
          accent={accent}
          gate={gate}
          stats={stats}
          onSelect={selectAgent}
          onToggleGate={() => actions.setGate(!gate)}
        />

        <ChatPanel
          thread={shown}
          agents={agentsById}
          accent={accent}
          channelName={run?.channel ?? ''}
          channelMeta={run ? `started ${run.startedAt} · ${agents.length} agents · ${run.toolServers} tool servers` : ''}
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
        />

        {detailOpen ? (
          <aside className="ac-detail">
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
                onClose={() => setDetailOpen(false)}
                onMessage={() => {
                  setTarget(selectedAgent.id)
                  setDraft(`@${selectedAgent.name} `)
                }}
                onInterrupt={() => actions.interrupt(selectedAgent.id)}
              />
            ) : (
              <div className="ac-agentpane" />
            )}
          </aside>
        ) : (
          <aside className="ac-rail">
            <button className="ac-rail-btn" onClick={() => setDetailOpen(true)}>
              ‹
            </button>
            <div className="ac-rail-label">PIPELINE · AGENT DETAIL</div>
          </aside>
        )}
      </div>
    </div>
  )
}
