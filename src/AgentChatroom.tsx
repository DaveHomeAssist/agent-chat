import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentDetail } from './components/AgentDetail'
import { AgentSidebar } from './components/AgentSidebar'
import { ChatPanel } from './components/ChatPanel'
import { PipelinePanel } from './components/PipelinePanel'
import { RunHeader } from './components/RunHeader'
import { AGENTS, AGENTS_BY_ID } from './data/agents'
import { BASE_THREAD } from './data/thread'
import type {
  AgentId,
  DetailTab,
  MessageTarget,
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
  /** Whether the run holds the merge for a human. */
  approvalGate?: boolean
}

const TARGETS: MessageTarget[] = ['all', ...AGENTS.map((a) => a.id)]

const FILTERS: Record<ThreadFilter, (m: ThreadItem) => boolean> = {
  all: () => true,
  decisions: (m) =>
    m.kind === 'divider' ||
    m.kind === 'human' ||
    (m.kind === 'message' && !!m.badge && m.badge !== '18/24'),
  tools: (m) => m.kind === 'tool',
  handoffs: (m) => m.kind === 'handoff' || m.kind === 'divider',
}

/** Delay before the addressed agent acknowledges a human message. */
const ACK_DELAY_MS = 1150
/** How long the room stays quiet before the agents start working again. */
const RESUME_TYPING_MS = 2600

export function AgentChatroom({
  accent = '#4C8CFF',
  trackerMode = 'board',
  liveMotion = true,
  approvalGate = true,
}: AgentChatroomProps) {
  const [selected, setSelected] = useState<AgentId>('forge')
  const [tab, setTab] = useState<DetailTab>('subtask')
  const [filter, setFilter] = useState<ThreadFilter>('all')
  const [detailOpen, setDetailOpen] = useState(true)
  const [tracker, setTracker] = useState<TrackerMode>(trackerMode)
  const [paused, setPaused] = useState(false)
  const [target, setTarget] = useState<MessageTarget>('all')
  const [draft, setDraft] = useState('')
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})
  const [thread, setThread] = useState<ThreadItem[]>(BASE_THREAD)
  const [typing, setTyping] = useState(true)
  const [gate, setGate] = useState(approvalGate)

  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const sentCount = useRef(0)

  const selectAgent = useCallback((id: AgentId) => {
    setSelected(id)
    setDetailOpen(true)
  }, [])

  const toggleTool = useCallback((id: string) => {
    setOpenTools((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const send = useCallback(() => {
    const body = draft.trim()
    if (!body) return

    const seq = ++sentCount.current
    const to = target

    setThread((prev) => [...prev, { id: `u${seq}`, kind: 'human', body, time: '14:41' }])
    setDraft('')
    setTyping(true)

    timers.current.push(
      setTimeout(() => {
        const reply =
          to === 'all'
            ? 'Ack — relayed to the room. Forge and Probe are re-prioritising; I will report back the moment the suite is green.'
            : 'Ack, taken directly. Adding it to the front of my queue and reporting back in this thread.'

        setThread((prev) => [
          ...prev,
          {
            id: `a${seq}`,
            kind: 'message',
            who: to === 'all' ? 'atlas' : to,
            badge: 'ACK',
            body: reply,
            time: '14:41',
          },
        ])
        setTyping(false)
        timers.current.push(setTimeout(() => setTyping(true), RESUME_TYPING_MS))
      }, ACK_DELAY_MS),
    )
  }, [draft, target])

  const shown = useMemo(() => thread.filter(FILTERS[filter]), [thread, filter])

  const selectedAgent = AGENTS_BY_ID[selected]

  const targetLabel =
    target === 'all' ? 'Broadcast → all agents' : `Direct → ${AGENTS_BY_ID[target].name}`
  const targetColor = target === 'all' ? accent : AGENTS_BY_ID[target].color

  return (
    <div className="ac-app">
      <RunHeader
        accent={accent}
        paused={paused}
        live={liveMotion}
        detailOpen={detailOpen}
        onTogglePause={() => setPaused((p) => !p)}
        onToggleDetail={() => setDetailOpen((d) => !d)}
      />

      <div className="ac-body">
        <AgentSidebar
          agents={AGENTS}
          selected={selected}
          live={liveMotion}
          accent={accent}
          gate={gate}
          onSelect={selectAgent}
          onToggleGate={() => setGate((g) => !g)}
        />

        <ChatPanel
          thread={shown}
          agents={AGENTS_BY_ID}
          accent={accent}
          filter={filter}
          onFilter={setFilter}
          openTools={openTools}
          onToggleTool={toggleTool}
          typing={typing && !paused}
          draft={draft}
          onDraft={setDraft}
          onSend={send}
          targetLabel={targetLabel}
          targetColor={targetColor}
          onCycleTarget={() =>
            setTarget((t) => TARGETS[(TARGETS.indexOf(t) + 1) % TARGETS.length])
          }
        />

        {detailOpen ? (
          <aside className="ac-detail">
            <PipelinePanel
              mode={tracker}
              onMode={setTracker}
              gate={gate}
              accent={accent}
              agents={AGENTS_BY_ID}
              onSelectAgent={selectAgent}
            />
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
            />
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
