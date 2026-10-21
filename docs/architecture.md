# Architecture

This page explains how `agent-runtime` works inside. You don't need it to use the library, but it
helps when you are deploying, debugging, or extending it.

## The big picture

```
                 ┌───────────────────── your backend (N instances) ─────────────────────┐
 browser ─SSE──▶ │ instance A                       instance B (owner of session S)    │
                 │  session.events()                 SessionWorker(S)                  │
 browser ─POST─▶ │  session.send() ──commands──┐     ├─ provider stream ◀──────────────┼──▶ provider
                 │                             │     ├─ runs custom tools              │   (Managed Agents,
                 │                             │     ├─ applies approval policy        │    AgentCore, …)
                 │                             │     └─ executes queued commands       │
                 └─────────────────────────────┼───────────────┬───────────────────────┘
                                               ▼               ▼
                                     ┌────────────────────────────────────┐
                                     │ Store (Postgres): sessions, events,│
                                     │ commands, actions, transcripts     │
                                     │ Bus (LISTEN/NOTIFY): wake-ups      │
                                     └────────────────────────────────────┘
```

## Building blocks

| Piece | Role |
| --- | --- |
| **Runtime** | One per process. Creates and looks up sessions, routes commands, scans for orphaned sessions. |
| **Session** | A lightweight handle (`send`, `interrupt`, `resolveApproval`, `events`, …). Cheap to create on any instance. |
| **SessionWorker** | Runs on the one instance that **owns** a session. Holds the provider connection and does all the work. |
| **ProviderAdapter** | Translates between a provider's API and the runtime: opens the stream, maps events, sends messages and results. |
| **Store** | Durable state: sessions, the event log, the command queue, pending tool calls/approvals, agent transcripts. |
| **Bus** | Fire-and-forget notifications between instances ("new event", "new command", "live delta"). |

## Ownership and leases

Exactly one instance owns a session at a time. Ownership is recorded in the session row as
`owner_instance` plus `lease_expires_at`:

1. An instance **acquires** the lease when it needs to act on the session (for example, when it
   receives `send()`) and nobody else holds a valid lease.
2. The owner **renews** the lease every `ttl / 3` (default TTL 15 s), using database time so clock
   skew between machines does not matter.
3. When the session has been **idle** with nothing pending for `idleReleaseMs` (default 60 s), the
   owner closes the provider connection and **releases** the lease. Idle sessions cost nothing.
4. If the owner **dies**, its lease expires. Every instance periodically looks for **orphans**:
   sessions that are busy (`running` / `requires_action`) or have pending work, but whose lease has
   expired. The first instance to claim one takes it over.

## Commands

`send`, `interrupt`, `resolveApproval`, and `terminate` are **commands**. They can be called on any
instance:

1. The command is written to the `commands` table.
2. If this instance owns the session, or can take ownership, it executes the command directly.
3. Otherwise it publishes a wake-up on the bus, and the owner picks the command up.
4. The caller waits until the owner marks the command `done` or `failed`. A failure surfaces as a
   `CommandError` with the provider's error message.

Commands are stored before they run. If the owner crashes, the next owner still executes them.

## Events

The worker converts every provider output into a unified event (see [Event model](event-model.md)):

- **Persisted events** are appended to the `events` table with the next per-session `seq`. A
  provider-supplied `sourceId` (such as the Managed Agents event id) makes the append idempotent,
  so replaying provider history after a reconnect never creates duplicates.
- **Live-only events** (token deltas) go straight to the bus and are never stored.

`session.events({ after })` subscribes to the bus *first*, then reads stored events after `after`,
then follows live notifications. It also polls every `pollIntervalMs` as a safety net. Together
this gives every subscriber, on any instance, a gap-free, duplicate-free stream.

## Actions: tool calls and approvals

Anything the provider is waiting on is an **action** row:

| Field | Meaning |
| --- | --- |
| `kind` | `tool` (a custom tool for us to run) or `approval` (a permission decision) |
| `request_id` | The provider's id for the request; unique per session, which makes repeated requests idempotent |
| `status` | `pending` → `resolved` or `cancelled`, changed with compare-and-set |
| `delivered` | Whether the result has reached the provider |

Because actions are stored, a new owner after a crash can:

- re-run tools that never finished;
- re-arm approval timeouts;
- re-send results that were decided but never delivered.

Details are in [Tools and approvals](tools-and-approvals.md).

## Provider cursors

Each adapter may persist an opaque **cursor**, such as the last Managed Agents event id or the
AgentCore `(bootId, seq)` pair. On reconnect the worker passes the cursor back so the adapter can
resume without re-reading everything.

## Agent transcripts

Some agents keep their own conversation state. The Claude Agent SDK, for example, writes a
transcript file. The store has a small transcript API, so this state can live in your database
instead of on a disposable machine. The AgentCore integration uses it to resume a conversation
when AWS replaces the microVM.

## Delivery guarantees at a glance

| What | Guarantee |
| --- | --- |
| Persisted events seen by subscribers | Exactly once, in `seq` order, no gaps |
| Live deltas | Best effort, not replayed |
| Commands | Executed at least once; each command id runs once per owner |
| Custom tool handlers | At least once (a crash mid-run means a re-run): **make them idempotent** |
| Tool results and approval decisions sent to the provider | At least once; providers ignore duplicates |
