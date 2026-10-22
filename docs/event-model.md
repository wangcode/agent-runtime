# Event model

Every provider's activity is converted into one set of events. This page is the field-by-field
reference. The ordering rules are in the [behaviour spec](behavior-spec.md); how each provider's
events are mapped is in [Event coverage](event-coverage.md).

## The envelope

Every event has this shape:

```ts
interface RuntimeEvent {
  id: string          // String(seq) for persisted events; a random id for live-only events
  sessionId: string
  seq?: number        // per-session counter starting at 1; only on persisted events
  ephemeral?: true    // only on live-only events
  ts: string          // ISO timestamp when the runtime recorded it
  type: string        // see below
  data: object        // depends on type
  provider?: string   // the provider key of the session ('ma', 'ac', …)
  threadId?: string   // set when a sub-agent / secondary thread produced the event
  raw?: unknown       // the original provider payload, when available
}
```

| Field | Notes |
| --- | --- |
| `seq` | Increases by exactly 1 per persisted event of a session, with no gaps. Use it as the SSE id and as your "last seen" marker. |
| `ephemeral` | `true` for `message.start`, `text.delta`, `thinking.delta`. These are delivered live only: never stored, never replayed, no `seq`. |
| `threadId` | Absent for the main agent. With the Agent SDK it is the id of the tool call that started the sub-agent; with Managed Agents, the session thread id. Treat it as an opaque grouping key. |
| `raw` | Debugging aid. Its shape is provider-specific; don't build features on it. `toSSE()` omits it by default. |

In TypeScript, `RuntimeEvent` is a discriminated union, so checking `type` narrows `data`:

```ts
if (event.type === 'tool.call') event.data.name // string
```

## Persisted vs. live events

| | Persisted | Live-only |
| --- | --- | --- |
| Types | everything except the three on the right | `message.start`, `text.delta`, `thinking.delta` |
| Stored | yes | no |
| `seq` / SSE `id` | yes | no |
| Replayed after reconnect | yes | no |
| May be missed | no | yes (disconnects, late subscribers) |

Live events exist only for the typing effect. The final content of every block always arrives in a
persisted `message.completed`. Pass `includeDeltas: false` to `session.events()` if you don't need
them.

## Event list and sources

Every event the runtime emits, and where it comes from. **Runtime** means the runtime emits it
itself, the same way for every provider. The provider columns name the native events it is built
from. For the reverse direction (every provider event and what it becomes), see the provider
guides: [Managed Agents event mapping](managed-agents.md#event-mapping) and
[Agent SDK event mapping](agentcore.md#event-mapping).

| Event | Kind | Runtime | Claude Managed Agents | Claude Agent SDK (AgentCore) |
| --- | --- | --- | --- | --- |
| [`session.created`](#session-created) | persisted | `createSession()` | – | – |
| [`session.status`](#session-status) `running` | persisted | on every `send()` that starts a turn | `session.status_running` (duplicates dropped) | the driver when a message is pushed (duplicates dropped) |
| [`session.status`](#session-status) `requires_action` | persisted | – | `session.status_idle` with stop reason `requires_action` | `canUseTool` waiting for a decision |
| [`session.status`](#session-status) `idle` | persisted | right before every `turn.completed` | (from `session.status_idle`) | (from `result`) |
| [`session.status`](#session-status) `terminated` | persisted | `session.terminate()` | `session.status_terminated`, `session.deleted`, or a 404 from the API | the SDK session closed |
| [`session.error`](#session-error) | persisted | a message could not be delivered | `session.error` | `result/error_*`, or an exception from the SDK |
| [`user.message`](#user-message) | persisted | `send()` (including `system`) | – (`user.message` and `system.message` echoes are ignored) | – (the SDK's echo of our prompt is ignored) |
| [`message.start`](#message-start-live) | live | – | `event_start` | `stream_event` `content_block_start` (text or thinking) |
| [`text.delta`](#text-delta-thinking-delta-live) | live | – | `event_delta` for `agent.message` | `stream_event` `text_delta` |
| [`thinking.delta`](#text-delta-thinking-delta-live) | live | – | `event_delta` for `agent.thinking` | `stream_event` `thinking_delta` |
| [`message.completed`](#message-completed) | persisted | – | each content block of `agent.message`; `agent.thinking` (text assembled from deltas) | each non-tool content block of an `assistant` message |
| [`tool.call`](#tool-call) | persisted | – | `agent.tool_use` (`builtin`), `agent.mcp_tool_use` (`mcp`), `agent.custom_tool_use` (`custom`) | `assistant` blocks `tool_use`, `server_tool_use`, `mcp_tool_use` |
| [`tool.result`](#tool-result) | persisted | your custom tool handler's result; an error result for a denied or expired approval | `agent.tool_result`, `agent.mcp_tool_result` | `tool_result` blocks in a `user` message |
| [`approval.requested`](#approval-requested) | persisted | when the approval policy answers `ask` | `agent.tool_use` / `agent.mcp_tool_use` with `evaluated_permission: ask` | `canUseTool` |
| [`approval.resolved`](#approval-resolved) | persisted | a decision by policy, human, or timeout | – | – |
| [`turn.completed`](#turn-completed) | persisted | sums `usage`; sets `stopReason: interrupted` after an interrupt | `session.status_idle` (stop reason mapped); usage from `span.model_request_end` and `session.usage` | `result/*` (stop reason mapped), with its usage and cost |
| [`provider.custom`](#provider-custom) | persisted | – | every type marked *custom* in the [mapping](managed-agents.md#event-mapping) | every message marked *custom* in the [mapping](agentcore.md#event-mapping) |

A `tool.result` appears once per `toolUseId`. When both the runtime and the provider report a
result for the same call, the first one wins.

## Content blocks

Message content uses the Anthropic content block format:

| Block | Shape |
| --- | --- |
| Text | `{ type: 'text', text: string }` |
| Thinking | `{ type: 'thinking', thinking: string }` |
| Image | `{ type: 'image', source: { type: 'base64', media_type, data } \| { type: 'url', url } }` |
| Document | `{ type: 'document', source: … }` |
| Anything else | passed through unchanged, e.g. `redacted_thinking`, `web_search_tool_result` |

Render the block types you know and skip (or show generically) the rest.

---

## Session events

### `session.created`

Always the first event (`seq` 1).

| Field | Type | Description |
| --- | --- | --- |
| `provider` | string | Provider key |
| `providerSessionId` | string | The session id at the provider |
| `metadata` | object | Whatever you passed to `createSession` |

```json
{ "type": "session.created", "data": { "provider": "ma", "providerSessionId": "sesn_01…", "metadata": { "userId": "u_1" } } }
```

### `session.status`

| Field | Type | Description |
| --- | --- | --- |
| `status` | `'idle' \| 'running' \| 'requires_action' \| 'terminated'` | New status. Never repeated twice in a row |
| `reason` | string? | Provider detail, e.g. why the session terminated |

`requires_action` is not yet consistent across providers; see
[open questions](behavior-spec.md#open-questions).

### `session.error`

The provider reported a problem. The session may continue.

| Field | Type | Description |
| --- | --- | --- |
| `message` | string | Human-readable description |
| `code` | string? | Provider error type, e.g. `model_overloaded_error` |
| `retryable` | boolean? | `true` when the provider is retrying by itself |

---

## Conversation events

### `user.message`

A message you sent with `session.send()`.

| Field | Type | Description |
| --- | --- | --- |
| `content` | `ContentBlock[]` | What the user said |
| `system` | `ContentBlock[]`, optional | System-level context sent with the message (`send(…, { system })`). Text blocks only. Not something the user typed, so UIs usually don't show it |

### `message.start` *(live)*

A content block starts streaming.

| Field | Type | Description |
| --- | --- | --- |
| `messageId` | string | Identifies the block: `<provider message id>:<block index>` (treat as opaque) |
| `kind` | `'text' \| 'thinking'` | |

### `text.delta` / `thinking.delta` *(live)*

| Field | Type | Description |
| --- | --- | --- |
| `messageId` | string | Same as the block's `message.start` |
| `text` | string | The next chunk |
| `index` | number? | Block index (`text.delta` only) |

### `message.completed`

The final content of **one** block.

| Field | Type | Description |
| --- | --- | --- |
| `messageId` | string | Same as its `message.start` and deltas |
| `content` | `[ContentBlock]` | Exactly one block |

```json
{ "type": "message.completed", "data": { "messageId": "msg_01AB:0", "content": [{ "type": "text", "text": "Order 42 shipped yesterday." }] } }
```

---

## Tool and approval events

### `tool.call`

The agent called a tool. Always comes before any approval or result for the same `toolUseId`.

| Field | Type | Description |
| --- | --- | --- |
| `toolUseId` | string | Identifies the call |
| `name` | string | Tool name (custom tools: the name you registered) |
| `input` | object | Tool input |
| `kind` | `'builtin' \| 'mcp' \| 'custom'` | `custom`: your runtime tool; `mcp`: an MCP server tool; `builtin`: the provider's own tools (bash, files, …) |
| `mcpServer` | string? | MCP server name, for `kind: 'mcp'` |

### `tool.result`

Exactly one per `tool.call`.

| Field | Type | Description |
| --- | --- | --- |
| `toolUseId` | string | |
| `content` | `ContentBlock[]` | The output, or the error/denial message |
| `isError` | boolean? | `true` for failures and denied calls |

### `approval.requested`

A tool call is waiting for a human decision.

| Field | Type | Description |
| --- | --- | --- |
| `approvalId` | string | Pass to `session.resolveApproval()` |
| `toolUseId` | string | The `tool.call` this is about |
| `name` | string | Tool name |
| `input` | object | Tool input |
| `expiresAt` | string? | When the timeout decision (`defaultOnTimeout`) applies |

### `approval.resolved`

A decision was made: by your policy, a person, a timeout, or the system.

| Field | Type | Description |
| --- | --- | --- |
| `approvalId` | string | |
| `toolUseId` | string | |
| `decision` | `'allow' \| 'deny'` | |
| `by` | `'policy' \| 'user' \| 'timeout' \| 'system'` | `system`: cancelled because the provider can no longer use the answer |
| `message` | string? | Reason given with the decision |

Policy decisions produce `approval.resolved` without a preceding `approval.requested`.

---

## Turn events

### `turn.completed`

The agent finished responding. It always comes immediately after `session.status: idle`.

| Field | Type | Description |
| --- | --- | --- |
| `stopReason` | string | See below |
| `usage` | object? | Totals for this turn: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUsd` (each optional) |

| `stopReason` | Meaning |
| --- | --- |
| `end_turn` | Finished normally |
| `interrupted` | Stopped by `session.interrupt()` |
| `error` | Stopped by an error (see the preceding `session.error`) |
| `budget` | A spending budget was reached |
| `max_turns` | The agent hit its maximum number of internal steps |
| `refusal` | The model declined to continue |
| other string | Provider-specific; treat like `error` |

### `provider.custom`

Provider activity without a unified equivalent: compaction, retries, sub-agent lifecycle, and so
on. Stored, so nothing is lost; safe to ignore.

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | The provider's type, e.g. `session.thread_created` or `system/compact_boundary` |
| `payload` | object | The provider's original event |

The full list per provider is in [Event coverage](event-coverage.md).

---

## Example: a complete turn

```
seq  type                 data
 2   user.message         content: [text "find order 42"]
 3   session.status       running
 –   message.start        messageId "msg_1:0", kind text                       (live)
 –   text.delta           messageId "msg_1:0", "Let me "                       (live)
 –   text.delta           messageId "msg_1:0", "check."                        (live)
 4   message.completed    messageId "msg_1:0", [text "Let me check."]
 5   tool.call            toolUseId "tu_1", lookup_order {id: "42"}, kind custom
 6   tool.result          toolUseId "tu_1", [text "{\"status\":\"shipped\"}"]
 7   message.completed    messageId "msg_2:0", [text "Order 42 shipped yesterday."]
 8   session.status       idle
 9   turn.completed       end_turn, usage { inputTokens: 812, outputTokens: 64, costUsd: 0.0031 }
```

## SSE format

`toSSE(event)` renders one SSE frame:

```
id: 7
event: message.completed
data: {"id":"7","sessionId":"…","seq":7,"ts":"…","type":"message.completed","data":{…}}

```

- **`id:` line.** Only persisted events get one, so `Last-Event-ID` always points at a replayable
  event.
- **`event:` line.** Carries the event type. In the browser, listen with
  `addEventListener('<type>')`; see the [Frontend guide](frontend-guide.md).
- **`raw`.** Omitted unless you call `toSSE(event, { includeRaw: true })`.

## Compatibility rules for consumers

- **Unknown types.** New event types may be added; ignore types you don't handle.
- **Unknown fields.** New optional fields may be added; ignore fields you don't use.
- **Opaque ids.** Treat ids (`messageId`, `toolUseId`, `approvalId`, `threadId`) as opaque strings.
