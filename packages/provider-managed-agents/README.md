# @agent-runtime/provider-managed-agents

Connects [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents) to
`agent-runtime`. Your backend gets the runtime's unified events, server-side tools, approvals,
and multi-instance support on top of Anthropic-hosted agents.

## Install

```bash
pnpm add @agent-runtime/provider-managed-agents @anthropic-ai/sdk
```

`@anthropic-ai/sdk` is a peer dependency. Use a version that includes the Managed Agents beta
(tested with 0.137).

## Usage

```ts
import Anthropic from '@anthropic-ai/sdk'
import { createRuntime } from '@agent-runtime/core'
import { managedAgents, type ManagedAgentsSessionConfig } from '@agent-runtime/provider-managed-agents'

const runtime = createRuntime({
  store,
  bus,
  providers: { ma: managedAgents({ client: new Anthropic() }) },
  tools: { /* handlers for the agent's custom tools, by name */ },
})

const session = await runtime.createSession<ManagedAgentsSessionConfig>({
  provider: 'ma',
  config: { agent: 'agent_123', environmentId: 'env_456' },
})
await session.send('Hi!')
```

Create the agent (including any `custom` tools) and the environment beforehand, with the Anthropic
API or Console.

## Session config

| Field | Description |
| --- | --- |
| `agent` | Agent id (uses the latest version) or `{ type: 'agent', id, version }` to pin one |
| `environmentId` | Environment to run in |
| `params` | Any other `sessions.create` parameters: `title`, `vault_ids`, `resources`, `budget`, `metadata`, … |

## Provider options

| Option | Default | Description |
| --- | --- | --- |
| `client` | *required* | An `Anthropic` client |
| `deltas` | `true` | Stream token deltas for messages and thinking |
| `includeRaw` | `true` | Attach the original Managed Agents event as `raw` |
| `onTerminate` | `'archive'` | What `session.terminate()` does: `'archive'`, `'delete'`, or `'none'` |
| `catchUpMarginMs` | `60000` | How far before the cursor the history catch-up starts |
| `reconnect` | `{ baseMs: 500, maxMs: 30000 }` | Stream reconnect backoff |
| `logger` | silent | `{ debug, info, warn, error }` |

## Behaviour

- **Connecting:** opens the event stream, then catches up on history since the stored cursor
  (deduplicated by event id), then lets commands flow. Reconnects with backoff when the stream
  drops.
- **Custom tools:** `agent.custom_tool_use` runs your registered handler and replies with
  `user.custom_tool_result`.
- **Permissions:** tool calls the service evaluates as `ask` go to your approval policy and are
  answered with `user.tool_confirmation`.
- **Deleted sessions:** a 404 from the API marks the session `terminated`.

Event mapping, API-call costs, and open design questions are described in
[docs/managed-agents.md](../../docs/managed-agents.md).

## Exports

| Export | Description |
| --- | --- |
| `managedAgents(options)` / `ManagedAgentsProvider` | The provider |
| `ManagedAgentsSessionConfig`, `ManagedAgentsOptions`, `ManagedAgentsCursor` | Types |
| `MA_EVENT_COVERAGE`, `MA_STOP_REASONS`, `MA_PERMISSIONS`, `MA_DELTA_TYPES`, `MA_MESSAGE_BLOCKS`, `maEventHandling()` | Coverage tables: how every Managed Agents type is handled; see [Event coverage](../../docs/event-coverage.md) |
| `mapEvent(event, state, opts)`, `newMappingState()` | The pure event mapper, useful for testing or offline conversion of stored Managed Agents events |

## Further reading

- [Claude Managed Agents guide](../../docs/managed-agents.md)
- [Event model](../../docs/event-model.md)
- [Tools and approvals](../../docs/tools-and-approvals.md)
