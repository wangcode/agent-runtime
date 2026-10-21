# Frontend guide

How to build a chat UI on top of the event stream. Everything here works the same for every
provider: the frontend never needs to know which one a session uses.

This guide assumes your backend exposes routes like the
[Express example](../examples/express-sse/README.md):

| Route | Purpose |
| --- | --- |
| `GET /sessions/:id/events` | SSE stream (honours `Last-Event-ID`) |
| `POST /sessions/:id/messages` | `{ text }` |
| `POST /sessions/:id/interrupt` | stop the current turn |
| `GET /sessions/:id/approvals` | pending approvals |
| `POST /sessions/:id/approvals/:approvalId` | `{ decision: 'allow' \| 'deny', message? }` |

## 1. Connect

```ts
const source = new EventSource(`/sessions/${sessionId}/events`)

const TYPES = [
  'session.created', 'session.status', 'session.error',
  'user.message', 'message.start', 'text.delta', 'thinking.delta', 'message.completed',
  'tool.call', 'tool.result', 'approval.requested', 'approval.resolved',
  'turn.completed', 'provider.custom',
] as const

for (const type of TYPES) {
  source.addEventListener(type, (e) => dispatch(JSON.parse((e as MessageEvent).data)))
}
```

- **Register a listener per event type.** Every SSE frame has a named `event:` line, so
  `source.onmessage` never fires. Listening only to the types you handle means new event types,
  added in a later version, are ignored automatically.
- **Reconnects are automatic.** `EventSource` reconnects by itself and sends `Last-Event-ID`; the
  backend replays exactly what was missed.
- **Page reloads start from scratch.** A reload opens a new `EventSource` without `Last-Event-ID`,
  so the backend replays the session from the beginning, rebuilding the UI from the full history.
  This is the simplest correct approach. To avoid replaying long sessions, store the last `seq`
  you rendered and pass it as `?after=<seq>`; the Express example supports this.

## 2. Keep state with one reducer

All UI state can be derived from the events. A minimal reducer:

```ts
import type { ContentBlock, RuntimeEvent, SessionStatus } from '@agent-runtime/core'

interface Block {
  messageId: string
  kind: 'text' | 'thinking' | 'other'
  text: string
  final: boolean            // false while streaming, true after message.completed
  content?: ContentBlock[]  // final content
  threadId?: string
}

interface ToolCall {
  toolUseId: string
  name: string
  input: unknown
  result?: { content: ContentBlock[]; isError?: boolean }
  approval?: { approvalId: string; state: 'pending' | 'allow' | 'deny'; expiresAt?: string; message?: string }
}

type Item = { kind: 'user'; content: ContentBlock[] } | { kind: 'block'; block: Block } | { kind: 'tool'; tool: ToolCall }

interface State {
  status: SessionStatus
  items: Item[]                     // the transcript, in order
  blocks: Map<string, Block>        // by messageId
  tools: Map<string, ToolCall>      // by toolUseId
  lastSeq: number
  error?: string
}

const initial = (): State => ({ status: 'idle', items: [], blocks: new Map(), tools: new Map(), lastSeq: 0 })

function reduce(s: State, e: RuntimeEvent): State {
  // Persisted events can be replayed after a reconnect; skip what was already applied.
  if (e.seq !== undefined) {
    if (e.seq <= s.lastSeq) return s
    s.lastSeq = e.seq
  }

  switch (e.type) {
    case 'session.status':
      s.status = e.data.status
      break

    case 'user.message':
      s.items.push({ kind: 'user', content: e.data.content })
      break

    case 'message.start': {
      if (s.blocks.has(e.data.messageId)) break
      const block: Block = { messageId: e.data.messageId, kind: e.data.kind, text: '', final: false, threadId: e.threadId }
      s.blocks.set(block.messageId, block)
      s.items.push({ kind: 'block', block })
      break
    }

    case 'text.delta':
    case 'thinking.delta': {
      const block = s.blocks.get(e.data.messageId)
      if (block && !block.final) block.text += e.data.text
      break
    }

    case 'message.completed': {
      const [content] = e.data.content
      const text = content?.type === 'text' ? (content as { text: string }).text
        : content?.type === 'thinking' ? (content as { thinking: string }).thinking : ''
      const kind = content?.type === 'text' || content?.type === 'thinking' ? content.type : 'other'
      let block = s.blocks.get(e.data.messageId)
      if (!block) {
        // Deltas were missed (or not streamed): the block appears complete.
        block = { messageId: e.data.messageId, kind, text: '', final: false, threadId: e.threadId }
        s.blocks.set(block.messageId, block)
        s.items.push({ kind: 'block', block })
      }
      Object.assign(block, { kind, text, final: true, content: e.data.content })
      break
    }

    case 'tool.call': {
      const tool: ToolCall = { toolUseId: e.data.toolUseId, name: e.data.name, input: e.data.input }
      s.tools.set(tool.toolUseId, tool)
      s.items.push({ kind: 'tool', tool })
      break
    }

    case 'approval.requested': {
      const tool = s.tools.get(e.data.toolUseId)
      if (tool) tool.approval = { approvalId: e.data.approvalId, state: 'pending', expiresAt: e.data.expiresAt }
      break
    }

    case 'approval.resolved': {
      const tool = s.tools.get(e.data.toolUseId)
      if (tool?.approval) Object.assign(tool.approval, { state: e.data.decision, message: e.data.message })
      break
    }

    case 'tool.result': {
      const tool = s.tools.get(e.data.toolUseId)
      if (tool) tool.result = { content: e.data.content, isError: e.data.isError }
      break
    }

    case 'session.error':
      s.error = e.data.message
      break

    case 'turn.completed':
      s.error = undefined
      break
  }
  return s
}
```

The guarantees that make this reducer correct are in the [behaviour spec](behavior-spec.md). In
short:

- **Text blocks.** A text or thinking block streams as `message.start` → deltas →
  `message.completed`, all with the same `messageId`. The completed event replaces whatever was
  streamed.
- **Tool calls.** `tool.call` always comes before the approval and result events for the same
  `toolUseId`, and every call gets exactly one `tool.result`.
- **Ordering.** Persisted events arrive in `seq` order without gaps. Live deltas have no `seq` and
  can be lost; nothing depends on them.

## 3. Render

| UI element | Derive from |
| --- | --- |
| Message bubbles | `items` with `kind: 'block'`; show `text` while `final` is false (typing), then the final content |
| Thinking | blocks with `kind: 'thinking'`; usually collapsed. Some providers may deliver partial thinking after a reconnect (`thinkingContent: 'best_effort'`) |
| Tool activity | `items` with `kind: 'tool'`: name and input, then the result; `result.isError` for failures and denials |
| Approval dialog | tools whose `approval.state === 'pending'` |
| "Agent is working" indicator | `status === 'running'` |
| Stop button | enabled while `status !== 'idle'`; calls `POST /interrupt` |
| Input box | always enabled. A message sent during a turn is delivered to the agent |
| Sub-agent activity | events with `threadId` belong to a sub-agent; group or indent them |

## 4. Approvals

When a tool needs permission, the dialog is driven by these events:

```
tool.call            { toolUseId: "t1", name: "Bash", input: { command: "rm -rf build" } }
approval.requested   { approvalId: "a1", toolUseId: "t1", name: "Bash", input: {…}, expiresAt: "…" }
   … user decides …
approval.resolved    { approvalId: "a1", decision: "allow", by: "user" }
tool.result          { toolUseId: "t1", content: [...] }
```

- **Answering.** Send `POST /sessions/:id/approvals/a1` with `{ decision: 'allow' }`. Any tab or
  device can answer.
- **Closing the dialog.** Close it on `approval.resolved`, not on your own POST. The approval may
  also be resolved by your policy, by a timeout (`by: 'timeout'`), by another tab, or cancelled
  (`by: 'system'`).
- **Already answered.** A second answer gets **HTTP 409** (`CommandError: already resolved`); just
  close the dialog.
- **Countdown.** `expiresAt` tells you when the timeout decision applies; show a countdown if
  useful.
- **Show the dialog based on the approval events.** The `requires_action` status is not yet
  consistent between providers (see the [behaviour spec](behavior-spec.md#open-questions)), so
  don't use it to decide whether to show the dialog.
- **Editing the input.** "Edit and approve" is only possible when the session's provider supports
  it. Ask your backend for `session.capabilities()` and show the option only if
  `approvalUpdatedInput` is true.

## 5. Turn end, interrupts and errors

| Event | What to show |
| --- | --- |
| `turn.completed` with `stopReason: 'end_turn'` | nothing special; the answer is complete |
| `turn.completed` with `stopReason: 'interrupted'` | "Stopped" marker |
| `turn.completed` with `stopReason: 'error' \| 'budget' \| 'max_turns' \| 'refusal'` | a notice explaining why the agent stopped |
| `session.error` | an error banner. If `retryable` is true, the provider is retrying by itself |
| `session.status: terminated` | the conversation is closed; disable the input. The stream ends after this event |

`turn.completed.usage` (`inputTokens`, `outputTokens`, `costUsd`) is the total for that turn,
which is useful for per-message cost display.

## 6. Checklist

- [ ] One listener per handled event type (no `onmessage`)
- [ ] Skip persisted events with `seq <= lastSeq`
- [ ] Replace streamed text with `message.completed`
- [ ] Close approval dialogs on `approval.resolved`, treat HTTP 409 as "already answered"
- [ ] Gate "edit and approve" on `approvalUpdatedInput`
- [ ] Ignore event types and fields you don't recognise
