# agent-runtime

A TypeScript abstraction layer over hosted agent providers. It does the plumbing so your backend
only deals with one session API and one event model:

- **Provider streams**: keeps the connection to the provider open, reconnects with backoff, and fills
  gaps from a persisted cursor.
- **Frontend independence**: the agent keeps working when the browser's SSE connection drops. While
  it does, server-side custom tools run, tool permissions are decided by policy, and human approvals
  wait (with a timeout that defaults to deny).
- **Horizontal scaling**: any instance can serve any request. Commands are routed to the instance
  that owns the provider stream. Events are fanned out across instances via Postgres
  `LISTEN/NOTIFY`, and clients resume with `Last-Event-ID`.
- **Failover**: ownership is a lease. If the owner dies, another instance takes over the busy
  session, reconnects to the provider, and finishes pending tool calls and approvals.
- **One event model**: every provider maps onto the same `RuntimeEvent` union. The original
  payload stays available as `raw`.

Phase 1 providers:

| Provider | Package | How it connects |
| --- | --- | --- |
| Claude Managed Agents | `@agent-runtime/provider-managed-agents` | `@anthropic-ai/sdk` beta sessions API (SSE stream plus event list catch-up) |
| Claude Agent SDK on Bedrock AgentCore | `@agent-runtime/provider-agentcore` + `@agent-runtime/agentcore-runtime` | SigV4 WebSocket to a container that runs the SDK |

## Packages

| Package | Purpose |
| --- | --- |
| `@agent-runtime/core` | Event model, `Runtime`/`Session` API, session orchestration, `Store`/`Bus` interfaces with in-memory implementations, `core/rxjs` adapter, and `core/testing` FakeProvider |
| `@agent-runtime/store-postgres` | `PgStore`, `PgBus` (LISTEN/NOTIFY), `migrate()` |
| `@agent-runtime/provider-managed-agents` | Managed Agents adapter |
| `@agent-runtime/provider-agentcore` | Caller-side AgentCore adapter (WebSocket, SigV4 or bearer auth) |
| `@agent-runtime/agentcore-runtime` | Container side: `/ping`, `/ws`, `/invocations`, the `AgentDriver` contract, and the Claude Agent SDK driver (`agentcore-runtime/claude-agent-sdk`) |
| `@agent-runtime/protocol` | WebSocket protocol shared by the two AgentCore packages |

## Usage

```ts
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'
import { createRuntime, toSSE } from '@agent-runtime/core'
import { PgBus, PgStore, migrate } from '@agent-runtime/store-postgres'
import { managedAgents } from '@agent-runtime/provider-managed-agents'
import { agentCore } from '@agent-runtime/provider-agentcore'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
await migrate(pool)
const bus = new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } })

const runtime = createRuntime({
  store: new PgStore({ pool }),
  bus,
  providers: {
    ma: managedAgents({ client: new Anthropic() }),
    ac: agentCore({ endpoint: { region: 'us-west-2', runtimeArn: process.env.RUNTIME_ARN! } }),
  },
  // Custom tools run on whichever instance owns the session, with or without a frontend attached.
  tools: {
    lookup_order: {
      description: 'Look up an order',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }, ctx) => db.orders.find(id),
    },
  },
  approvals: {
    policy: ({ name }) => (name === 'Read' ? 'allow' : 'ask'), // 'allow' | 'deny' | 'ask'
    timeoutMs: 10 * 60_000,
    defaultOnTimeout: 'deny',
  },
})

const session = await runtime.createSession({ provider: 'ma', config: { agent: 'agent_...', environmentId: 'env_...' } })
await session.send('Where is order 42?')

// In an SSE route, on any instance:
for await (const event of session.events({ after: Number(req.header('last-event-id') ?? 0), signal })) {
  res.write(toSSE(event))
}

// From any instance:
await session.resolveApproval(approvalId, 'allow')
await session.interrupt()
```

If you prefer RxJS:

```ts
import { toObservable } from '@agent-runtime/core/rxjs'
toObservable(() => session.events()).pipe(filter((e) => e.type === 'message.completed'))
```

## Event model

Every event has the shape `{ id, sessionId, seq?, ephemeral?, ts, type, data, provider?, raw? }`.

- **Persisted events** have a per-session, gap-free `seq`, which is also the SSE `id`.
- **Ephemeral events** (`message.start`, `text.delta`, `thinking.delta`) are live only. They are
  never replayed, and the authoritative content always arrives later in `message.completed`.

| Unified event | Managed Agents | Claude Agent SDK (AgentCore) |
| --- | --- | --- |
| `user.message` | written by the runtime | written by the runtime |
| `message.start` / `text.delta` / `thinking.delta` | `event_start` / `event_delta` | `stream_event` content blocks |
| `message.completed` | `agent.message`, `agent.thinking` | `assistant` text and thinking blocks (one event per block) |
| `tool.call` (`builtin` / `mcp` / `custom`) | `agent.tool_use`, `agent.mcp_tool_use`, `agent.custom_tool_use` | `assistant` `tool_use` blocks |
| `tool.result` | `agent.tool_result`, `agent.mcp_tool_result`; custom tools: written by the runtime | `user` `tool_result` blocks; custom tools: written by the runtime |
| `approval.requested` / `approval.resolved` | `evaluated_permission: ask` → `user.tool_confirmation` | `canUseTool` → caller |
| `session.status` | `session.status_*` (idle + `requires_action`) | derived from turns and pending approvals |
| `turn.completed` | `session.status_idle.stop_reason` | `result` |
| `usage` / `session.error` | `span.model_request_end` / `session.error` | inside `turn.completed` / `result` errors |
| `provider.custom` | anything else | `system/init`, `compact_boundary`, `api_retry` |

## How it works

```
 browser ──SSE──▶ any instance ──┐      session.events(): replay from Postgres, then follow
                                 │      NOTIFY (persisted) and ephemeral deltas
 browser ──POST─▶ any instance ──┤      send/interrupt/resolveApproval → commands table + NOTIFY
                                 ▼
                      owner instance (lease in sessions table)
                      SessionWorker: provider stream ⇄ adapter
                        ├─ persist events (seq, dedupe by provider sourceId)
                        ├─ run custom tool handlers → submitToolResult
                        ├─ approval policy / human decision / timeout → submitApproval
                        └─ drain commands; release lease when idle
```

- **Lease.** Every `lease.ttlMs / 3` the owner extends `owner_instance` / `lease_expires_at`, using
  database time. Each instance looks for orphans every `orphanScanIntervalMs`. An orphan is a
  session that is busy or has pending commands/actions and whose lease has expired; the instance
  takes it over with a conditional `UPDATE`.
- **Exactly-once.** Provider events carry a `sourceId` (the Managed Agents event id, or the AgentCore
  `bootId:seq`), so replays after a reconnect or takeover are dropped. Tool calls and approvals live
  in the `actions` table with compare-and-set resolution and a `delivered` flag. Results that never
  reached the provider are re-sent. Tool handlers run at least once, so keep them idempotent.
- **Managed Agents.** The stream has no resume cursor, so every (re)connect opens the stream, lists
  events since the stored cursor minus a safety margin, and dedupes by event id.
- **AgentCore.** The container keeps a per-boot replay log and resends outstanding tool and approval
  requests when a client reconnects. The adapter rotates connections before the 60-minute stream
  limit. A changed `bootId` means a fresh microVM: outstanding requests are cancelled, and the
  Agent SDK resumes from the transcript that its `sessionStore` mirrored into Postgres. `/ping`
  reports `HealthyBusy` only while a turn or request is in flight, and bumps `time_of_last_update`
  only on transitions, so idle microVMs are reclaimed.

## Running the AgentCore container

See `examples/agentcore-container` for the Dockerfile and entrypoint. The default driver runs the
Claude Agent SDK with `CLAUDE_CODE_USE_BEDROCK=1`. Per-session SDK options can be passed as
`config: { options: { model, systemPrompt, maxTurns, ... } }` in `createSession`.

To write a driver for another framework, implement `AgentDriver` from
`@agent-runtime/agentcore-runtime`: emit unified events, call `requestTool` / `requestApproval`,
and report busy state.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test                                        # Postgres tests are skipped without a database
AGENT_RUNTIME_PG_URL=postgres://postgres@localhost:5432/postgres pnpm test
PROVIDER=fake pnpm --filter @agent-runtime/example-express-sse start
```

Tests use mocks only: a scriptable `FakeProvider`, a mocked Anthropic client, a real container
server driven by a mocked Agent SDK, and an optional local Postgres. No external APIs are called.

## Known gaps / to verify against live services

- **Managed Agents event listing.** `events.list` filters on `created_at`, while events expose
  `processed_at`. Catch-up uses a configurable margin (`catchUpMarginMs`) and relies on id dedupe.
- **Multi-agent threads.** Managed Agents multi-agent threads (`session_thread_id`) and Agent SDK
  subagent messages (`parent_tool_use_id`) are not modelled separately yet.
- **WebSocket session id.** AgentCore `/ws` is addressed with the session id header. The presigned
  query-parameter variant, needed for browser-direct connections, is not implemented.
