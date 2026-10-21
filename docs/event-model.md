# Event model

Every provider's events are converted into one shape, so your frontend only has to understand one
format.

## The envelope

```ts
interface RuntimeEvent {
  id: string          // String(seq) for persisted events; a random id for live-only events
  sessionId: string
  seq?: number        // per-session counter, starting at 1; present on persisted events only
  ephemeral?: boolean // true for live-only events
  ts: string          // ISO timestamp
  type: EventType
  data: …             // depends on `type`, see below
  provider?: string   // the provider key the session uses
  threadId?: string   // set on events from a sub-agent / secondary thread
  raw?: unknown       // the original provider payload, when available
}
```

The type is a TypeScript discriminated union, so checking `event.type` narrows `event.data`:

```ts
if (event.type === 'tool.call') console.log(event.data.name, event.data.input)
```

## Persisted vs. live-only events

| | Persisted | Live-only (`ephemeral: true`) |
| --- | --- | --- |
| Types | everything except the three below | `message.start`, `text.delta`, `thinking.delta` |
| Stored in the database | yes | no |
| Has a `seq` / SSE `id` | yes | no |
| Replayed on reconnect | yes | no |

Token deltas exist only for the "typing" effect. The final text always arrives in
`message.completed`, so a client that missed some deltas just replaces its preview with the final
block. Clients that don't need typing can pass `includeDeltas: false` to `session.events()`.

## Event types

### Session

| Type | `data` | When |
| --- | --- | --- |
| `session.created` | `{ provider, providerSessionId, metadata }` | First event of every session |
| `session.status` | `{ status: 'idle' \| 'running' \| 'requires_action' \| 'terminated', reason? }` | Status changes |
| `session.error` | `{ message, code?, retryable? }` | Provider or delivery errors (the session may continue) |

### Conversation

| Type | `data` | When |
| --- | --- | --- |
| `user.message` | `{ content: ContentBlock[] }` | A message you sent with `session.send()` |
| `message.start` *(live)* | `{ messageId, kind: 'text' \| 'thinking' }` | The agent starts writing a block |
| `text.delta` *(live)* | `{ messageId, text, index? }` | A chunk of text |
| `thinking.delta` *(live)* | `{ messageId, text }` | A chunk of reasoning |
| `message.completed` | `{ messageId, content: [ContentBlock] }` | Final content of **one** block; same `messageId` as its `message.start` and deltas |

### Tools and approvals

| Type | `data` | When |
| --- | --- | --- |
| `tool.call` | `{ toolUseId, name, input, kind: 'builtin' \| 'mcp' \| 'custom', mcpServer? }` | The agent calls a tool |
| `tool.result` | `{ toolUseId, content: ContentBlock[], isError? }` | A tool finished (including your custom tools) |
| `approval.requested` | `{ approvalId, toolUseId, name, input, expiresAt? }` | A human decision is needed; pass `approvalId` to `resolveApproval()` |
| `approval.resolved` | `{ approvalId, toolUseId, decision: 'allow' \| 'deny', by: 'user' \| 'policy' \| 'timeout' \| 'system', message? }` | A permission decision was made, by anyone |

### Turn and usage

| Type | `data` | When |
| --- | --- | --- |
| `turn.completed` | `{ stopReason, usage? }` | The agent finished responding; always right after `session.status: idle`. `stopReason` is `end_turn`, `interrupted`, `error`, `budget`, `refusal`, `max_turns`, or a provider-specific string. `usage` is the turn total: `{ inputTokens?, outputTokens?, cacheReadInputTokens?, cacheCreationInputTokens?, costUsd? }` |
| `provider.custom` | `{ name, payload }` | Provider events with no unified equivalent; `name` is the provider's event type |

Ordering and meaning (one block per `message.completed`, `tool.call` before its result, one
`tool.result` per call, …) are defined in the [behaviour spec](behavior-spec.md).

### Content blocks

`ContentBlock` follows the Anthropic content block format: `{ type: 'text', text }`,
`{ type: 'thinking', thinking }`, `{ type: 'image', source }`, `{ type: 'document', source }`. Other
block types are passed through unchanged.

## A typical turn

```
seq  type                 notes
 1   session.created
 2   user.message         "find order 42"
 3   session.status       running
 –   message.start        live, messageId "msg_1:0"
 –   text.delta           live, "Let me "
 –   text.delta           live, "check."
 4   message.completed    messageId "msg_1:0", "Let me check."
 5   tool.call            lookup_order {id: "42"}  kind: custom
 6   tool.result          your handler's output
 7   message.completed    messageId "msg_2:0", "Order 42 shipped yesterday."
 8   session.status       idle
 9   turn.completed       end_turn, usage { inputTokens, outputTokens, costUsd }
```

## SSE format

`toSSE(event)` from `@agent-runtime/core` renders one event as an SSE frame:

```
id: 7
event: message.completed
data: {"id":"7","sessionId":"…","seq":7,"ts":"…","type":"message.completed","data":{…}}
```

- Only persisted events get an `id:` line, so the browser's `Last-Event-ID` always points at a
  replayable event.
- `raw` is omitted by default. Use `toSSE(event, { includeRaw: true })` to include it.
- On reconnect, read `Last-Event-ID` and pass it as `session.events({ after })`.

## Provider mapping

| Unified event | Claude Managed Agents | Claude Agent SDK (AgentCore) |
| --- | --- | --- |
| `user.message` | written by the runtime | written by the runtime |
| `message.start` / `text.delta` / `thinking.delta` | `event_start` / `event_delta` | `stream_event` content blocks |
| `message.completed` | `agent.message`, `agent.thinking` | `assistant` text/thinking blocks (one event per block) |
| `tool.call` | `agent.tool_use`, `agent.mcp_tool_use`, `agent.custom_tool_use` | `assistant` `tool_use` blocks |
| `tool.result` | `agent.tool_result`, `agent.mcp_tool_result`; custom tools: written by the runtime | `user` `tool_result` blocks; custom tools: written by the runtime |
| `approval.*` | `evaluated_permission: "ask"`, answered with `user.tool_confirmation` | `canUseTool` callback |
| `session.status` | `session.status_running` / `_idle` / `_terminated` | derived from turns and pending approvals |
| `turn.completed` | `session.status_idle` stop reason | `result` message |
| `turn.completed.usage` | sum of `span.model_request_end` + cost from `session.usage` | `result` usage and cost |
| `session.error` | `session.error` | `result` errors, SDK exceptions |
| `provider.custom` | any other event (see coverage) | most `system/*` messages, `rate_limit_event`, … (see coverage) |

The complete, per-type list, and the mechanism that keeps it complete across SDK upgrades, is in
[Event coverage](event-coverage.md).

**Frontends must ignore event types they don't recognise.** New unified types may be added in
minor versions, and `provider.custom` carries whatever a provider adds.
