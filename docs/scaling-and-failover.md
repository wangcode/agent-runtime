# Scaling and failover

`agent-runtime` runs on any number of identical instances behind an ordinary load balancer. No
sticky sessions are needed: any instance can create sessions, send messages, answer approvals, and
stream events for any session.

## Setup

Every instance needs:

1. **The same Postgres database**, version 12 or newer (tested on 16).
2. **`PgStore` and `PgBus`** pointing at it.
3. **A unique `instanceId`.** The default random UUID is fine; a pod or host name makes logs
   easier to read.

```ts
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 })
await migrate(pool) // safe to run concurrently on every instance

const runtime = createRuntime({
  store: new PgStore({ pool }),
  bus: new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } }),
  providers,
  instanceId: process.env.HOSTNAME,
})

process.on('SIGTERM', async () => {
  await runtime.close()
  process.exit(0)
})
```

> **Connection poolers.** `PgBus` keeps one dedicated `LISTEN` connection per instance. Point
> `listenConfig` at Postgres directly, or at a **session-mode** pooler. `LISTEN` does not work
> through a transaction-mode pooler (such as PgBouncer in transaction mode). `PgStore` works through
> any pooler.

## How requests are routed

Each active session has one **owner**: the instance holding its provider connection.

| Request arrives at… | What happens |
| --- | --- |
| The owner | Executed directly |
| Another instance, while the session has an owner | Queued in Postgres; the owner is notified within milliseconds, executes it, and the caller's `await` resolves |
| Any instance, while nobody owns the session (it is idle) | That instance becomes the owner and executes it |
| `session.events()` on any instance | Replays stored events from Postgres, then follows new ones via notifications |

Idle sessions have no owner and hold no provider connection. Ownership is taken on the next
command.

## Failover

When the owner of a busy session dies (crash, OOM kill, network partition):

| Time | What happens |
| --- | --- |
| 0 s | Owner dies. Its lease (expiry `lease.ttlMs`, default 15 s) is no longer renewed |
| ≤ 15 s | Lease expires |
| ≤ 20 s | Another instance's orphan scan (every `orphanScanIntervalMs`, default 5 s) claims the session |
| +connect | The new owner reconnects to the provider from the stored cursor, re-runs unfinished tool calls, re-arms approval timeouts, re-sends undelivered results, and executes queued commands |

Expect 15–20 seconds of silence with the defaults. Lower `lease.ttlMs` and `orphanScanIntervalMs`
for faster failover, at the cost of more database writes.

What users see during a failover:

| | Effect |
| --- | --- |
| Open SSE streams on surviving instances | Keep working; events resume when the new owner reconnects |
| Open SSE streams on the dead instance | Dropped; `EventSource` reconnects (through the load balancer) with `Last-Event-ID` and loses nothing |
| `send()` in progress | Waits; it completes when the new owner executes the queued command, or throws after `commandTimeoutMs` (the command still runs later) |
| Pending approvals | Still answerable; their timeouts keep their original deadline |
| Custom tool running on the dead instance | Re-run by the new owner (so handlers must be idempotent) |
| Live token deltas during the gap | Lost; the final text arrives in `agent.message.completed` |
| Interrupt / usage of the turn in progress | May be lost: the next `runtime.turn.completed` might show `end_turn` and incomplete `usage` ([open question](behavior-spec.md#open-questions)) |

### Deploys

On `SIGTERM`, `runtime.close()` releases every lease right away, so other instances take over at
their next orphan scan (≤ 5 s) instead of waiting for leases to expire. Rolling deploys therefore
cause only short pauses.

### Testing failover

Start two instances, begin a long turn, and kill the owner with `kill -9`. The session's
`owner_instance` changes within ~20 s, and the stream continues:

```sql
SELECT owner_instance, lease_expires_at, status FROM agent_runtime.sessions WHERE id = '<session id>';
```

## Capacity

| Resource | Per instance | Notes |
| --- | --- | --- |
| Postgres connections | pool size + 1 | The extra one is the `LISTEN` connection |
| Provider connections | one per **active** session it owns | Released after `idleReleaseMs` of inactivity |
| Background queries | 1 orphan scan per `orphanScanIntervalMs`; 1 lease renewal per owned session per `lease.renewIntervalMs` | Small indexed queries |
| Per event | 1 short transaction (append) + 1 `NOTIFY` | Deltas: `NOTIFY` only, no write |

Load spreads naturally: whichever instance receives the first command of an idle session becomes
its owner.

## Database tables

`migrate()` creates these in the `agent_runtime` schema (configurable with `{ schema }`):

| Table | Contents | Grows with |
| --- | --- | --- |
| `sessions` | One row per session: provider ids, status, cursor, lease, last `seq` | sessions |
| `events` | The persisted event log | messages and tool calls |
| `commands` | Queued and executed commands | user actions |
| `actions` | Tool calls and approvals | tool usage |
| `transcripts` | Agent SDK transcripts (AgentCore) | conversation length |
| `migrations` | Applied migrations | — |

Retention and inspection queries are in [Operations](operations.md#maintenance).

## Running without Postgres

`MemoryStore` and `MemoryBus` give the same behaviour inside one process: for development, tests,
or single-instance deployments that can lose history on restart. Several runtimes can share one
`MemoryStore`/`MemoryBus` pair, which is how the test suite simulates a cluster.
