# Claude Managed Agents

[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) runs the agent loop and
its sandbox on Anthropic's infrastructure. Your backend creates sessions, sends events into them,
and reads events back. `@agent-runtime/providers-managed-agents` connects that API to the runtime.

## Setup

### 1. Create an agent and an environment (once)

You create these yourself, with the Anthropic API or Console. The provider only creates
**sessions** for them. Declare your runtime's custom tools on the agent, using the same names:

```ts
import Anthropic from '@anthropic-ai/sdk'
const anthropic = new Anthropic()

const environment = await anthropic.beta.environments.create({ name: 'support', config: { type: 'cloud' } })

const agent = await anthropic.beta.agents.create({
  name: 'Support agent',
  model: 'claude-sonnet-5-5',
  system: 'You help customers with their orders.',
  tools: [
    // built-in tools; 'always_ask' sends every call to your approval policy
    { type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'always_ask' } } },
    // a custom tool handled by the runtime's `tools.lookup_order`
    { type: 'custom', name: 'lookup_order', description: 'Look up an order by id', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  ],
})
// keep agent.id and environment.id, e.g. in configuration
```

### 2. Register the provider and create sessions

```ts
import Anthropic from '@anthropic-ai/sdk'
import { managedAgents, type ManagedAgentsSessionConfig } from '@agent-runtime/providers-managed-agents'

const runtime = createRuntime({
  // …
  providers: { ma: managedAgents({ client: new Anthropic() }) },
})

const session = await runtime.createSession<ManagedAgentsSessionConfig>({
  provider: 'ma',
  config: {
    agent: 'agent_123', // or { type: 'agent', id: 'agent_123', version: 4 } to pin a version
    environmentId: 'env_456',
    params: { title: 'Support chat', vault_ids: ['vault_1'] }, // any other sessions.create params
  },
})
```

The provider adds `agent_runtime_session_id` to the Managed Agents session metadata, so you can
find the runtime session from the Anthropic Console.

## How the connection works

```
connect ──▶ open events stream ──▶ list history since cursor ──▶ ready ──▶ live events …
               (only events after          (catch up on anything        (commands may
                this point are sent)         missed; dedupe by id)        now be sent)
```

1. **Stream first.** The Managed Agents stream only delivers events emitted after it opens, so the
   provider opens it before anything else.
2. **Catch up.** It then lists events since the stored cursor (minus a safety margin, default
   60 s) and drops any it has already seen, by event id.
3. **Ready.** Queued commands, such as your `send()`, are executed only after this point, so no
   reply can be missed.
4. **Reconnect.** If the stream drops, steps 1–3 repeat with exponential backoff.
5. **Session gone.** A 404 ends the session with `session.status: terminated`.

The cursor is the id and `processed_at` of the last processed event. It is stored with the session,
so a different instance can resume after a takeover.

## Example: one turn, before and after mapping

| Managed Agents sends | Runtime emits |
| --- | --- |
| *(you call `send('find order 42')`)* | `user.message`, `session.status: running` |
| `user.message` (echo) | — |
| `session.status_running` | — (already running) |
| `event_start` + `event_delta` (`agent.message`) | `agent.message.start`, `agent.text.delta` (live) |
| `agent.message` with one text block | `agent.message.completed` (`messageId: "<event id>:0"`) |
| `agent.custom_tool_use` `lookup_order` | `tool.call` (`kind: custom`); your handler runs |
| `session.status_idle` (`requires_action`) | `session.status: requires_action` |
| *(handler returns; runtime sends `user.custom_tool_result`)* | `tool.result` |
| `session.status_running` | `session.status: running` |
| `agent.message` | `agent.message.completed` |
| `span.model_request_end` ×2, `session.usage` | — (summed into the turn's usage) |
| `session.status_idle` (`end_turn`) | `session.status: idle`, `runtime.turn.completed` (`usage` with tokens and `costUsd`) |

## What gets sent to Managed Agents

| Runtime call | Managed Agents event |
| --- | --- |
| `session.send(content)` | `user.message` |
| `session.send(content, { system })` | `user.message` followed by `system.message` in the same request (the API requires it to be the last event, right after the message it accompanies). Only models that accept mid-conversation system messages support it; others reject the send, which fails `send()` with `CommandError` |
| `session.interrupt()` | `user.interrupt` |
| custom tool handler finished | `user.custom_tool_result` (`custom_tool_use_id`, `content`, `is_error`) |
| approval decided | `user.tool_confirmation` (`tool_use_id`, `result`, `deny_message`) |
| `session.terminate()` | `sessions.archive()` by default (`onTerminate: 'delete' \| 'none'` to change) |

Echoes of these `user.*` and `system.message` events from the stream are ignored, because the runtime records its own
`user.message` and result events.

## Event mapping

Every Managed Agents event type, and the [unified event](event-model.md#event-list-and-sources) it
becomes. The list matches the coverage table in `packages/providers/managed-agents/src/coverage.ts`;
an SDK upgrade that adds a type fails the build until it is added there (see
[Event coverage](event-coverage.md)). A type the installed SDK doesn't know yet becomes
`provider.custom`.

| Managed Agents event | Our event | Notes |
| --- | --- | --- |
| **Stream previews** | | |
| `event_start` | `agent.message.start` | live; id `<event id>:<block index>` |
| `event_delta` | `agent.text.delta` / `agent.thinking.delta` | live; `agent.message` deltas become text, `agent.thinking` deltas become thinking |
| **Agent events** | | |
| `agent.message` | `agent.message.completed`, one per content block | `text` and `redacted` blocks; id `<event id>:<block index>`, shared with the deltas |
| `agent.thinking` | `agent.message.completed` with a `thinking` block | the event has no text; it is assembled from thinking deltas |
| `agent.tool_use` | `tool.call` (`kind: builtin`) | plus an approval request when `evaluated_permission` is `ask` |
| `agent.mcp_tool_use` | `tool.call` (`kind: mcp`) | plus an approval request when `evaluated_permission` is `ask` |
| `agent.custom_tool_use` | `tool.call` (`kind: custom`) | plus a call to your tool handler; its result becomes `tool.result` |
| `agent.tool_result` | `tool.result` |  |
| `agent.mcp_tool_result` | `tool.result` |  |
| `agent.thread_context_compacted` | `provider.custom` |  |
| `agent.thread_message_received` | `provider.custom` |  |
| `agent.thread_message_sent` | `provider.custom` |  |
| **Session status and lifecycle** | | |
| `session.status_running` | `session.status: running` | usually a duplicate: the runtime already reported `running` on `send()` |
| `session.status_idle` | `session.status: idle` + `runtime.turn.completed` | stop reason mapped below; `requires_action` becomes `session.status: requires_action` and does not end the turn |
| `session.status_terminated` | `session.status: terminated` |  |
| `session.deleted` | `session.status: terminated` |  |
| `session.status_rescheduled` | `provider.custom` |  |
| `session.error` | `session.error` |  |
| `session.updated` | `provider.custom` |  |
| `session.usage` | `runtime.turn.completed.usage.costUsd` | cumulative cost; the increase since the previous one is added to the current turn |
| **Multi-agent threads** | | |
| `session.thread_created` | `provider.custom` |  |
| `session.thread_status_running` | `provider.custom` |  |
| `session.thread_status_idle` | `provider.custom` |  |
| `session.thread_status_rescheduled` | `provider.custom` |  |
| `session.thread_status_terminated` | `provider.custom` |  |
| **Spans** | | |
| `span.model_request_start` | `provider.custom` |  |
| `span.model_request_end` | `runtime.turn.completed.usage` token counts | summed per turn |
| `span.outcome_evaluation_start` | `provider.custom` |  |
| `span.outcome_evaluation_ongoing` | `provider.custom` |  |
| `span.outcome_evaluation_end` | `provider.custom` |  |
| **Workflows** | | |
| `workflow_run.created` | `provider.custom` |  |
| `workflow_run.status_running` | `provider.custom` |  |
| `workflow_run.status_idle` | `provider.custom` |  |
| `workflow_run.status_ended` | `provider.custom` |  |
| `workflow_run.error` | `provider.custom` |  |
| `workflow_run.phase_started` | `provider.custom` |  |
| `workflow_run.phase_ended` | `provider.custom` |  |
| **User events** (mostly echoes of what the runtime sent) | | |
| `user.message` | – (ignored) | the runtime records `user.message` itself on `send()` |
| `system.message` | – (ignored) | recorded as `user.message.system` |
| `user.interrupt` | – (ignored) | the runtime reports the turn as `interrupted` |
| `user.custom_tool_result` | – (ignored) | the runtime records `tool.result` itself |
| `user.tool_confirmation` | – (ignored) | the runtime records `approval.resolved` itself |
| `user.tool_result` | – (ignored) | self-hosted environments only |
| `user.define_outcome` | `provider.custom` | not sent by the runtime, so not an echo |

**Stop reasons** (`session.status_idle.stop_reason.type`):

| Managed Agents | `runtime.turn.completed.stopReason` |
| --- | --- |
| `end_turn` | `end_turn` (`interrupted` if you interrupted the turn; Managed Agents itself reports `end_turn`) |
| `requires_action` | none: the turn stays open and `session.status` becomes `requires_action` |
| `retries_exhausted` | `error` |
| `budget_reached` | `budget` |
| `refusal` | `refusal` |
| anything newer | passed through as a string |

**Permissions** (`evaluated_permission` on `agent.tool_use` and `agent.mcp_tool_use`): only `ask`
creates an approval request for your policy. `allow` and `deny` were already decided by the
service, so the call appears only as `tool.call`.

**Notes**

- **Deltas** are always requested (`event_deltas: ['agent.message', 'agent.thinking']`), because
  thinking text only exists there. `deltas: false` only stops forwarding them as live events.
- **Messages from outside the runtime.** User events are ignored as echoes, so a message sent to
  the session another way (for example from the Anthropic Console) doesn't appear in the
  runtime's history.

## Capabilities

| Capability | Value | Why |
| --- | --- | --- |
| `approvalUpdatedInput` | `false` | `user.tool_confirmation` can only allow or deny; changing the input is not possible |
| `thinkingContent` | `best_effort` | `agent.thinking` events carry no text. The provider always subscribes to thinking deltas and assembles them, but deltas are not replayed, so thinking can be partial after a reconnect |
| `systemMessages` | `native` | `send(…, { system })` becomes a `system.message` event |
| `turnCost` | `true` | `session.usage` reports a cumulative list cost; the provider turns it into a per-turn `costUsd` (kept in the cursor, so it survives reconnects and takeovers) |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `client` | *required* | An `Anthropic` client instance |
| `deltas` | `true` | Emit live token deltas. Deltas are always requested from Managed Agents, because thinking text only exists there |
| `includeRaw` | `true` | Attach the original event as `raw` |
| `onTerminate` | `'archive'` | What `session.terminate()` does: `'archive'`, `'delete'`, or `'none'` |
| `catchUpMarginMs` | `60000` | How far before the cursor the history listing starts |
| `reconnect` | `{ baseMs: 500, maxMs: 30000 }` | Reconnect backoff |
| `logger` | none | `{ debug, info, warn, error }` |

## API usage and rate limits

Managed Agents limits requests per organization: **300 per minute** for create endpoints
(sessions, agents, environments) and **1,200 per minute** for read endpoints (retrieve, list,
stream). Organization spend limits also apply. This is what the provider uses:

| Situation | API calls |
| --- | --- |
| Create a session | 1 (`sessions.create`) |
| Each user message, interrupt, tool result, or approval | 1 (`events.send`) |
| Each stream (re)connect | 1 `events.stream` + 1 or more `events.list` pages |
| Idle session (after `idleReleaseMs`) | 0, the stream is closed |

Reconnects happen when the stream drops, after a takeover, and when an idle session becomes active
again.

## Open questions

These are being discussed and may change:

- **History catch-up.** The listing filters on `created_at`, while events expose `processed_at`,
  hence the margin. There is a proposal to **stop calling `events.list` entirely** and treat the
  runtime database as the source of truth, to save API quota. The trade-off is that events emitted
  while no instance is connected would be lost. The worst case is a custom tool call or approval
  request emitted during an outage, which would leave the session waiting in `requires_action`
  with no way for the runtime to answer it.
- **Webhooks.** Managed Agents webhooks are thin notifications: they carry the session id and a
  status type (`session.status_idled`, `session.requires_action`, …) but no event content. They
  could detect that a session changed while nobody was listening, but they cannot restore the
  missing content on their own. Whether and how to use them (HTTP endpoint, or API Gateway + SQS)
  is still open.
- **Multi-agent threads.** Events from multi-agent threads (`session_thread_id`) are mapped like
  any other event; threads are not yet modelled separately.
