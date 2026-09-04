# Agent Chatroom

A multi-agent conversation dashboard: five AI agents ship a feature together while a human
operator watches the run, holds the merge gate, and steps in when needed.

Built with Vite + React + TypeScript. The UI is a faithful port of the Claude Design prototype
in [`project/Agent Chatroom.dc.html`](project/Agent%20Chatroom.dc.html) — see
[`docs/HANDOFF.md`](docs/HANDOFF.md) and [`chats/`](chats) for the original brief.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle
npm run typecheck
```

The layout has a hard floor of 1180 × 700 — it is a desktop console, not a responsive site.

## Layout

| Region | Width | Contents |
| --- | --- | --- |
| Header | full · 58px | Run state (live/paused), elapsed time, token and cost counters, run controls |
| Agent sidebar | 288px | Five agents with status, current subtask and progress; human-oversight toggles |
| Chat thread | fluid | Phase dividers, agent messages, expandable tool calls, handoffs, human broadcasts |
| Detail pane | 404px | Pipeline tracker (Board / Steps) over the selected agent's detail tabs |

The detail pane collapses to a 46px rail via **Hide detail** or the ✕ in the pane header.

## What you can do

- **Select an agent** from the sidebar or from any board task — the detail pane follows.
- **Filter the thread** by All / Decisions / Tool calls / Handoffs.
- **Expand a tool call** to see its output lines. Expansion is keyed to the message, so it
  survives a filter change.
- **Send a message** — broadcast to the room, or cycle the target chip to DM one agent. The
  addressed agent acknowledges after a beat. The three slash-command chips prefill the composer.
- **Toggle the approval gate** — the Ship lane and the sixth pipeline step both reshape between
  a held human gate and auto-release.
- **Pause the run** — the run pill and every status pulse go quiet.
- **Switch the tracker** between the kanban Board and the ordered Steps checklist.

## Props

`<AgentChatroom />` takes the four knobs the design exposed:

| Prop | Type | Default | Effect |
| --- | --- | --- | --- |
| `accent` | `string` | `#4C8CFF` | Selection, send button, human broadcast card. The design's palette is `ACCENTS` in `src/lib/theme.ts`: blue, violet, teal, pink. |
| `trackerMode` | `'board' \| 'steps'` | `'board'` | Which tracker face opens first |
| `liveMotion` | `boolean` | `true` | Status pulses, progress sweep, log cursor |
| `approvalGate` | `boolean` | `true` | Whether the run holds the merge for a human |

## Structure

```
src/
  AgentChatroom.tsx      state: selection, filter, thread, composer, gate, pause
  components/            RunHeader · AgentSidebar · ChatPanel · ThreadItemView
                         PipelinePanel · AgentDetail
  data/                  agents · thread · pipeline   (fixtures — swap for a live run feed)
  lib/theme.ts           colour tokens, tint(), status/level/tool colour maps
  styles.css             all static styling; dynamic colour arrives as CSS custom properties
```

Everything under `src/data/` is fixture data standing in for a real run. The components take it
as props, so wiring up a live agent run means replacing those three modules.
