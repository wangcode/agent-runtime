# @agent-runtime/stores-memory

In-memory implementations of the runtime's `Store` and `Bus` interfaces. Nothing to set up and no
database, for:

- local development and demos;
- tests (including multi-instance tests: see below);
- a single-instance deployment that can afford to lose its state on restart.

For anything that must survive a restart or run on more than one process, use
[`@agent-runtime/stores-postgres`](../postgres/README.md).

## Install

```bash
pnpm add @agent-runtime/stores-memory
```

## Usage

```ts
import { createRuntime } from '@agent-runtime/core'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'

const runtime = createRuntime({ store: new MemoryStore(), bus: new MemoryBus(), providers })
```

### Simulating a cluster

Runtimes that share one `MemoryStore` and one `MemoryBus` behave like instances of a real
deployment. They share leases and command routing, events reach every instance, and a runtime
takes over the sessions of another runtime that stopped. The test suites use this to cover
multi-instance behaviour without a database.

```ts
const store = new MemoryStore()
const bus = new MemoryBus()
const a = createRuntime({ store, bus, providers })
const b = createRuntime({ store, bus, providers })
```

## API

| Export | Description |
| --- | --- |
| `MemoryStore` | `Store`: sessions, the event log, commands, actions, leases, and transcripts in `Map`s. Values are deep-copied on the way in and out, so callers can't mutate stored state |
| `MemoryBus` | `Bus`: synchronous publish/subscribe inside the process |

Both follow the same contract as the Postgres store. The shared contract tests
(`storeContract` from `@agent-runtime/core/testing`) run against `MemoryStore`.

## Limits

- **State lives only in the process.** A restart loses every session, event, and pending
  approval. Provider-side sessions keep running, but the runtime can no longer reach them.
- **One process.** `MemoryBus` doesn't cross process boundaries, so two servers using separate
  memory stores are two separate systems.
- **No retention.** Nothing is ever deleted, so memory grows with every event.
