# @agent-runtime/store-postgres

Postgres storage and cross-instance messaging for `agent-runtime`. This is what lets you run
several instances of your backend behind a load balancer.

- **`PgStore`**: sessions, the event log, the command queue, tool calls and approvals, leases, and
  agent transcripts.
- **`PgBus`**: instant notifications between instances using Postgres `LISTEN/NOTIFY`. No Redis
  or message broker needed.
- **`migrate()`**: creates and upgrades the schema.

## Install

```bash
pnpm add @agent-runtime/store-postgres pg
```

## Usage

```ts
import pg from 'pg'
import { createRuntime } from '@agent-runtime/core'
import { PgBus, PgStore, migrate } from '@agent-runtime/store-postgres'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 })
await migrate(pool) // idempotent; safe for many instances to run at once

const bus = new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } })
await bus.start()   // optional: fail fast if the LISTEN connection cannot be opened

const runtime = createRuntime({ store: new PgStore({ pool }), bus, providers })

// on shutdown
await runtime.close()
await bus.close()
await pool.end()
```

## API

### `migrate(pool, { schema? })`

Applies pending migrations inside the schema (default `agent_runtime`). An advisory lock lets
every instance call it at boot without racing. To use your own migration tool instead, take the
SQL from `migrationSql(schema)` or `MIGRATIONS`.

### `new PgStore({ pool, schema? })`

| Option | Default | Description |
| --- | --- | --- |
| `pool` | *required* | A `pg.Pool` |
| `schema` | `agent_runtime` | Schema holding the tables |

Works through any connection pooler, including transaction-mode PgBouncer.

### `new PgBus({ pool, listenConfig, channel?, logger? })`

| Option | Default | Description |
| --- | --- | --- |
| `pool` | *required* | Used to send `NOTIFY` |
| `listenConfig` | *required* | `pg.ClientConfig` for the dedicated `LISTEN` connection. Must reach Postgres directly or through a **session-mode** pooler |
| `channel` | `agent_runtime` | Notification channel; use different channels to isolate environments that share a database |
| `logger` | silent | `{ debug, info, warn, error }` |

| Method | Description |
| --- | --- |
| `start()` | Opens the `LISTEN` connection (also opened lazily on first subscribe) |
| `close()` | Closes it |

The bus reconnects automatically. Notifications lost during a reconnect are covered by the
runtime's polling fallback, so nothing is lost, only delayed.

## Schema

| Table | Purpose |
| --- | --- |
| `sessions` | One row per session: provider ids, status, provider cursor, lease (`owner_instance`, `lease_expires_at`), last `seq` |
| `events` | The event log, keyed by `(session_id, seq)`; `source_id` is unique per session for deduplication; `thread_id` for sub-agent attribution |
| `commands` | Queued `send` / `interrupt` / `resolve_approval` / `terminate` commands |
| `actions` | Tool calls and approvals the provider is waiting on, with compare-and-set status |
| `transcripts` | Agent SDK transcript entries (used by the AgentCore integration) |
| `migrations` | Applied migration names |

### How guarantees are enforced

- **Event order.** `seq` is assigned under a row lock on the session, so events become visible in
  order with no gaps.
- **Leases.** Leases are compared against the database clock (`now()`), never the app servers'
  clocks.
- **One decision per approval.** Resolution is an `UPDATE … WHERE status = 'pending'`, so only one
  decision can win.

## Migrations

| Name | Change |
| --- | --- |
| `001_init` | All tables |
| `002_event_thread` | `events.thread_id` |

`migrate()` records applied migrations in `migrations` and applies only new ones.

## Operations notes

- **Retention.** Nothing is deleted automatically. Delete old `sessions` rows to remove everything
  belonging to them (cascades).
- **NOTIFY payload size.** Payloads are capped at 8000 bytes by Postgres. The runtime splits large
  token deltas, and drops oversized notifications with a warning; persisted events are never
  affected, because subscribers read them from the table.
- **Pool size.** Each instance holds one extra connection for `LISTEN`. Size the pool for your
  concurrency; event appends use a short transaction each.

## Testing

The test suite runs the shared store contract against `MemoryStore` always, and against `PgStore`
when `AGENT_RUNTIME_PG_URL` is set. Each run uses a throwaway schema.

```bash
AGENT_RUNTIME_PG_URL=postgres://postgres@localhost:5432/postgres pnpm test
```

Inspection queries and retention SQL: [Operations](../../docs/operations.md#inspecting-state-in-postgres).

## Further reading

- [Scaling and failover](../../docs/scaling-and-failover.md)
- [Architecture](../../docs/architecture.md)
