# Scaling and failover

`agent-runtime` is designed to run on several identical instances behind an ordinary load balancer.
No sticky sessions are required.

## Requirements

- A shared **Postgres** database (version 12 or newer; tested on 16).
- Each instance uses `PgStore` and `PgBus` against that database.
- Each instance has a unique `instanceId`. The default is a random UUID per process, which is what
  you want.

```ts
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 20 })
await migrate(pool)

const runtime = createRuntime({
  store: new PgStore({ pool }),
  bus: new PgBus({ pool, listenConfig: { connectionString: DATABASE_URL } }),
  providers,
})
```

> **Connection poolers.** `PgBus` keeps one dedicated `LISTEN` connection per process. Point
> `listenConfig` at Postgres directly or at a session-mode pooler, **not** a transaction-mode
> pooler (such as PgBouncer in transaction mode), because `LISTEN` does not work there. `PgStore`
> works with any pooler.

## What happens where

| Request arrives at… | Result |
| --- | --- |
| The instance that owns the session | Handled directly |
| Another instance, while the session has an owner | The command is queued; the owner is notified and executes it; the caller waits for the result |
| Any instance, while the session has no owner (idle) | That instance takes ownership and handles the command |
| `session.events()` on any instance | Replays from Postgres, then follows live notifications |

## Crash recovery

When the owning instance dies (crash, deploy, OOM):

1. Its lease stops being renewed and expires after `lease.ttlMs` (default 15 s).
2. Another instance's orphan scan, which runs every `orphanScanIntervalMs` (default 5 s), finds the
   session because it is busy or has pending work, and takes it over.
3. The new owner reconnects to the provider using the stored cursor and replays anything missed.
   Duplicates are dropped.
4. It resumes in-flight work:
   - pending tool calls are re-run;
   - approval timers are re-armed;
   - decided-but-undelivered results are sent again;
   - queued commands are executed.

Typical takeover time is `ttl` plus up to one scan interval, so 15–20 s with the defaults.

**Graceful shutdown:** call `await runtime.close()` on `SIGTERM`. It releases leases immediately, so
other instances don't have to wait for expiry.

## Tuning

All options are passed to `createRuntime()`.

| Option | Default | Effect |
| --- | --- | --- |
| `lease.ttlMs` | `15000` | How long ownership lasts without renewal. Lower means faster takeover but more DB writes |
| `lease.renewIntervalMs` | `ttlMs / 3` | How often the owner renews |
| `orphanScanIntervalMs` | `5000` | How often each instance looks for sessions to take over |
| `idleReleaseMs` | `60000` | How long an idle session keeps its provider connection before releasing it |
| `pollIntervalMs` | `2000` | Safety-net polling for subscribers and command waiters, in case a notification was lost |
| `commandTimeoutMs` | `60000` | How long `send()` and the other commands wait for execution before throwing (the command stays queued) |
| `reconnect.baseMs` / `reconnect.maxMs` | `500` / `30000` | Backoff for provider reconnects |

## Database tables

`migrate()` creates these tables in the `agent_runtime` schema (configurable):

| Table | Contents | Grows with |
| --- | --- | --- |
| `sessions` | One row per session: provider, status, cursor, lease | sessions |
| `events` | The persisted event log | messages and tool calls |
| `commands` | Queued and completed commands | user actions |
| `actions` | Tool calls and approvals | tool usage |
| `transcripts` | Agent SDK transcript entries (AgentCore) | conversation length |
| `migrations` | Applied migrations | — |

There is no automatic retention yet. Archive or delete old sessions with your own job. Deleting a
`sessions` row cascades to its events, commands, and actions.

## Running without Postgres

`MemoryStore` and `MemoryBus` give you the same behaviour inside a single process. Several runtimes
can share one `MemoryStore`/`MemoryBus` pair; the test suite uses this to simulate a cluster.
Everything is lost when the process exits.
