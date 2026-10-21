# @agent-runtime/core

The heart of `agent-runtime`: the unified event model, the `Runtime` and `Session` API, the session
orchestration (provider streams, tools, approvals, ownership), in-memory storage, an RxJS adapter,
and test helpers.

You always need this package. Add a [store](../store-postgres/README.md) for production and one or
more providers ([Managed Agents](../provider-managed-agents/README.md),
[AgentCore](../provider-agentcore/README.md)).

## Install

```bash
pnpm add @agent-runtime/core
pnpm add rxjs   # only if you use @agent-runtime/core/rxjs
```

## Quick example

```ts
import { createRuntime, MemoryBus, MemoryStore, toSSE } from '@agent-runtime/core'

const runtime = createRuntime({
  store: new MemoryStore(),
  bus: new MemoryBus(),
  providers: { ma: myProvider },
})

const session = await runtime.createSession({ provider: 'ma', config: { … } })
await session.send('Hello!')

for await (const event of session.events()) {
  console.log(event.type, event.data)
  if (event.type === 'turn.completed') break
}
```

## API

### `createRuntime(options): Runtime`

| Option | Default | Description |
| --- | --- | --- |
| `store` | *required* | Where sessions and events are kept (`MemoryStore`, `PgStore`, or your own `Store`) |
| `bus` | *required* | Cross-instance notifications (`MemoryBus`, `PgBus`, or your own `Bus`) |
| `providers` | *required* | `{ [key]: ProviderAdapter }`; sessions refer to providers by key |
| `tools` | `{}` | Server-side custom tools; see [Tools and approvals](../../docs/tools-and-approvals.md) |
| `approvals.policy` | always `'ask'` | `(request) => 'allow' \| 'deny' \| 'ask' \| { decision, message?, timeoutMs? }` |
| `approvals.timeoutMs` | 10 min | How long an `'ask'` waits for a human |
| `approvals.defaultOnTimeout` | `'deny'` | Decision applied on timeout |
| `instanceId` | random UUID | Unique id of this process |
| `lease.ttlMs` / `lease.renewIntervalMs` | 15 s / ttl÷3 | Session ownership lease |
| `idleReleaseMs` | 60 s | Release an idle session's provider connection after this long |
| `orphanScanIntervalMs` | 5 s | How often to look for sessions whose owner died |
| `pollIntervalMs` | 2 s | Safety-net polling interval |
| `commandTimeoutMs` | 60 s | How long commands wait to be executed |
| `reconnect` | `{ baseMs: 500, maxMs: 30000 }` | Provider reconnect backoff |
| `logger` | silent | Any `{ debug, info, warn, error }` object, such as `console` |

### `Runtime`

| Member | Description |
| --- | --- |
| `createSession({ provider, config, metadata?, id? })` | Creates the session at the provider and returns a `Session` |
| `getSession(id)` | Returns a `Session` handle, or `null`; works on any instance |
| `close()` | Stops background work and releases owned sessions; call on shutdown |
| `instanceId` | This process's id |
| `ownedSessions` | Ids of sessions this instance currently owns |

### `Session`

All methods work from any instance.

| Method | Description |
| --- | --- |
| `send(input)` | Send a user message (string, content blocks, or `{ content }`). Resolves once the provider accepted it |
| `interrupt()` | Stop the current turn |
| `resolveApproval(approvalId, decision, message?)` | Answer an approval: `'allow'`, `'deny'`, or `{ behavior, message?, updatedInput? }` |
| `pendingApprovals()` | Approvals still waiting for a human |
| `terminate()` | End the session (and the provider session) |
| `info()` | The stored session record: status, provider ids, owner, metadata |
| `events({ after?, includeDeltas?, follow?, signal? })` | AsyncIterable of events: replays after `after`, then follows live events. Ends when you `break`, `signal` aborts, or the session terminates |

Commands throw `CommandError` when the provider rejects them, or when they were not executed within
`commandTimeoutMs`. In that case they stay queued and run later.

### Helpers

| Export | Description |
| --- | --- |
| `toSSE(event, { includeRaw? })` | Render an event as an SSE frame. Only persisted events get an `id:` line |
| `isEphemeralType(type)` | Whether an event type is live-only |
| `MemoryStore`, `MemoryBus` | In-process implementations; share one pair between runtimes to simulate a cluster |
| `normalizeToolOutput(output)` | Converts handler return values into a `ToolResult` |

### `@agent-runtime/core/rxjs`

```ts
import { toObservable } from '@agent-runtime/core/rxjs'

toObservable(() => session.events())
  .pipe(filter((e) => e.type === 'message.completed'))
  .subscribe(console.log)
```

The Observable is cold, and unsubscribing stops the underlying subscription. `rxjs` is an optional
peer dependency.

### `@agent-runtime/core/testing`

`FakeProvider` is a scriptable provider for tests and demos:

```ts
import { FakeProvider } from '@agent-runtime/core/testing'

const fake = new FakeProvider()
fake.onSend = (sessionId) =>
  fake.emit(sessionId, { kind: 'event', event: { type: 'turn.completed', data: { stopReason: 'end_turn' } } })
// fake.calls records every adapter call; fake.disconnect(sessionId) simulates a dropped stream
```

## Extension points

- **`ProviderAdapter`**: add a new agent backend. See [Writing a provider](../../docs/extending.md).
- **`Store` and `Bus`**: plug in other storage. Use the contract tests in
  `packages/store-postgres/test/store-contract.ts` to check your implementation.

## Further reading

- [Getting started](../../docs/getting-started.md)
- [Architecture](../../docs/architecture.md)
- [Event model](../../docs/event-model.md)
- [Tools and approvals](../../docs/tools-and-approvals.md)
