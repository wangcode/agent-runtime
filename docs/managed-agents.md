# Claude Managed Agents

[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) runs the agent loop and
its sandbox on Anthropic's infrastructure. Your backend creates sessions, sends events into them,
and reads events back. `@agent-runtime/provider-managed-agents` connects that API to the runtime.

## Setup

You create the **agent** and the **environment** yourself, with the Anthropic API or Console. The
provider only creates **sessions** for them.

```ts
import Anthropic from '@anthropic-ai/sdk'
import { managedAgents, type ManagedAgentsSessionConfig } from '@agent-runtime/provider-managed-agents'

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

## What gets sent to Managed Agents

| Runtime call | Managed Agents event |
| --- | --- |
| `session.send(content)` | `user.message` |
| `session.interrupt()` | `user.interrupt` |
| custom tool handler finished | `user.custom_tool_result` (`custom_tool_use_id`, `content`, `is_error`) |
| approval decided | `user.tool_confirmation` (`tool_use_id`, `result`, `deny_message`) |
| `session.terminate()` | `sessions.archive()` by default (`onTerminate: 'delete' \| 'none'` to change) |

Echoes of these `user.*` events from the stream are ignored, because the runtime records its own
`user.message` and result events.

## Event mapping

Every Managed Agents event type is listed in the coverage table (`src/coverage.ts`), and an SDK
upgrade that adds a type fails the build until it is handled; see [Event coverage](event-coverage.md).
Notable details:

- **Deltas** are requested with `event_deltas: ['agent.message', 'agent.thinking']`. Disable them
  with `deltas: false`.
- **Thinking.** `agent.thinking` events carry no text. When deltas are on, the provider collects
  the thinking deltas and puts them into the `message.completed` thinking block.
- **Permissions.** `agent.tool_use` and `agent.mcp_tool_use` with
  `evaluated_permission: "ask"` become approval requests. Calls evaluated as `allow` or `deny` are
  not shown to your policy.
- **Stop reasons.** `requires_action` becomes `session.status: requires_action`. Other idle stop
  reasons become `session.status: idle` followed by `turn.completed`:

  | Managed Agents stop reason | `turn.completed.stopReason` |
  | --- | --- |
  | `end_turn` | `end_turn` |
  | `retries_exhausted` | `error` |
  | `budget_reached` | `budget` |
  | `refusal` | `refusal` |

## Options

| Option | Default | Description |
| --- | --- | --- |
| `client` | *required* | An `Anthropic` client instance |
| `deltas` | `true` | Stream token deltas |
| `includeRaw` | `true` | Attach the original event as `raw` |
| `onTerminate` | `'archive'` | What `session.terminate()` does: `'archive'`, `'delete'`, or `'none'` |
| `catchUpMarginMs` | `60000` | How far before the cursor the history listing starts |
| `reconnect` | `{ baseMs: 500, maxMs: 30000 }` | Reconnect backoff |
| `logger` | none | `{ debug, info, warn, error }` |

## API usage and rate limits

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
