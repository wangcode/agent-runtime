# @agent-runtime/core

The runtime itself:

- the `Runtime` and `Session` API;
- the unified event model;
- the session worker (provider connections, tools, approvals, ownership, behaviour rules);
- in-memory storage;
- an RxJS adapter and test helpers.

Every application needs this package. Add a [store](../store-postgres/README.md) for production
and one or more providers ([Managed Agents](../provider-managed-agents/README.md),
[AgentCore](../provider-agentcore/README.md)).

```bash
pnpm add @agent-runtime/core
pnpm add rxjs   # only for @agent-runtime/core/rxjs
```

Entry points:

| Import | Contents |
| --- | --- |
| `@agent-runtime/core` | Everything below except RxJS and testing |
| `@agent-runtime/core/rxjs` | `toObservable()` |
| `@agent-runtime/core/testing` | `FakeProvider` |

---

## `createRuntime(options): Runtime`

```ts
const runtime = createRuntime({ store, bus, providers: { ma: managedAgents({ client }) } })
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `store` | `Store` | *required* | `MemoryStore`, `PgStore`, or your own |
| `bus` | `Bus` | *required* | `MemoryBus`, `PgBus`, or your own |
| `providers` | `Record<string, ProviderAdapter>` | *required* | Sessions refer to providers by these keys |
| `tools` | `Record<string, ToolRegistration>` | `{}` | Custom tools; see [Tools and approvals](../../docs/tools-and-approvals.md) |
| `approvals.policy` | `ApprovalPolicy` | always `'ask'` | Automatic permission decisions |
| `approvals.timeoutMs` | number | 600 000 | How long `'ask'` waits for a human |
| `approvals.defaultOnTimeout` | `'allow' \| 'deny'` | `'deny'` | Decision on timeout |
| `instanceId` | string | random UUID | Unique id of this process |
| `lease.ttlMs` | number | 15 000 | Ownership lease duration |
| `lease.renewIntervalMs` | number | ttl ÷ 3 | Lease renewal interval |
| `idleReleaseMs` | number | 60 000 | Release an idle session's provider connection after this long |
| `orphanScanIntervalMs` | number | 5 000 | How often to look for sessions whose owner died |
| `pollIntervalMs` | number | 2 000 | Safety-net polling interval |
| `commandTimeoutMs` | number | 60 000 | How long commands wait to be executed |
| `toolCallWaitMs` | number | 2 000 | How long tool results/approvals wait for their `tool.call` when reported out of order |
| `reconnect` | `{ baseMs, maxMs }` | 500 / 30 000 | Provider reconnect backoff |
| `logger` | `Logger` | silent | `{ debug, info, warn, error }(message, meta)` |

When to change these options is explained in [Operations](../../docs/operations.md#configuration-reference).

## `Runtime`

| Member | Description |
| --- | --- |
| `createSession({ provider, config, metadata?, id? })` | Creates the session at the provider and stores it. `metadata` is any JSON you want to keep with the session (user id, tenant, …). `id` lets you choose the session id. Returns a `Session` |
| `getSession(id)` | A `Session` handle, or `null` if it doesn't exist. Works on every instance |
| `capabilities(providerKey)` | The provider's `ProviderCapabilities` |
| `close()` | Stops background work and releases owned sessions to other instances. Call on shutdown |
| `instanceId` | This process's id |
| `ownedSessions` | Ids of sessions this instance currently owns (for diagnostics) |

## `Session`

A lightweight handle; create as many as you like. Every method works on every instance.

| Method | Returns | Description |
| --- | --- | --- |
| `send(input, opts?)` | `Promise<void>` | Send a user message: a string, `ContentBlock[]`, or `{ content }`. Resolves once the provider accepted it; replies arrive as events. Allowed during a turn. `opts.system` (string or text blocks) adds system-level context; see below |
| `interrupt()` | `Promise<void>` | Stop the current turn. It ends with `stopReason: 'interrupted'` |
| `resolveApproval(approvalId, decision, message?)` | `Promise<void>` | `decision`: `'allow'`, `'deny'`, or `{ behavior, message?, updatedInput? }` |
| `pendingApprovals()` | `Promise<ActionRecord[]>` | Approvals waiting for a human: `id` (the approval id), `toolUseId`, `name`, `input`, `expiresAt` |
| `terminate()` | `Promise<void>` | End the session, including at the provider |
| `capabilities()` | `Promise<ProviderCapabilities>` | This session's provider capabilities |

#### System-level context

```ts
await session.send('Summarise the ticket', { system: 'The user is on the Enterprise plan. Answer in French.' })
```

`system` adds context for this turn **and all later turns** without replacing the agent's system
prompt. It is stored on the `user.message` event (`data.system`). Only text is allowed; other blocks
throw `TypeError`. How it reaches the model depends on `capabilities().systemMessages`:

- `native` (Managed Agents): sent as a `system.message` event. Only models that accept
  mid-conversation system messages support it; others reject the send with a `CommandError`.
- `emulated` (Agent SDK on AgentCore): appended to the user message as a
  `<system-reminder>…</system-reminder>` text block. It stays in the transcript, so it also applies
  to later turns.
| `info()` | `Promise<SessionRecord>` | `id`, `provider`, `providerSessionId`, `status`, `metadata`, `ownerInstance`, `lastSeq`, `createdAt`, `updatedAt`, … |
| `events(options?)` | `AsyncGenerator<RuntimeEvent>` | See below |

### `session.events(options)`

```ts
for await (const event of session.events({ after: lastSeq, signal })) { … }
```

| Option | Default | Description |
| --- | --- | --- |
| `after` | `0` | Replay persisted events with `seq > after`, then follow live ones |
| `includeDeltas` | `true` | Include live `agent.message.start` / `agent.text.delta` / `agent.thinking.delta` |
| `follow` | `true` | `false`: return after the replay |
| `signal` | — | Abort to stop |

The iteration ends when you `break`, when `signal` aborts, after the replay with
`follow: false`, or after the session's `terminated` status. Persisted events arrive in `seq`
order with no gaps or duplicates, regardless of which instance owns the session.

### Errors

| Error | When | Fields |
| --- | --- | --- |
| `CommandError` | The provider rejected a command, an approval was already resolved, or the command was not executed within `commandTimeoutMs` (it then stays queued and runs later) | `message`, `commandId` |
| `CapabilityError` | A feature the provider doesn't support, e.g. `updatedInput` | `message`, `capability` |
| `Error` | Unknown provider, unknown or terminated session | `message` |

## Events

Types: `RuntimeEvent`, `PersistedEvent`, `EventType`, `EventPayloads`, `ContentBlock`,
`SessionStatus`, `StopReason`, `Usage`. Every event and field is documented in
[Event model](../../docs/event-model.md).

| Helper | Description |
| --- | --- |
| `toSSE(event, { includeRaw? })` | Render an event as an SSE frame. Persisted events get an `id:` line; `raw` is omitted unless `includeRaw` |
| `isEphemeralType(type)` | `true` for live-only types |
| `EPHEMERAL_EVENT_TYPES` | The set of live-only types |
| `textContent(text)` | `[{ type: 'text', text }]` |

## Tools and approvals

| Export | Description |
| --- | --- |
| `ToolRegistration` | `{ description, inputSchema, handler(input, ctx) }` |
| `ToolContext` | `ctx` passed to handlers: `sessionId`, `toolUseId`, `name`, `metadata`, `signal` |
| `ToolHandlerOutput` | What a handler may return |
| `normalizeToolOutput(output)` | Converts a handler return value into a `ToolResult` |
| `ApprovalPolicy`, `ApprovalRequestInfo`, `ApprovalPolicyResult` | Policy types |
| `ApprovalDecision` | `{ behavior: 'allow' \| 'deny', message?, updatedInput? }` |

## `@agent-runtime/core/rxjs`

```ts
import { toObservable } from '@agent-runtime/core/rxjs'

const sub = toObservable(() => session.events({ includeDeltas: false }))
  .pipe(filter((e) => e.type === 'agent.message.completed'))
  .subscribe((e) => console.log(e.data.content))

sub.unsubscribe() // stops the underlying subscription
```

`toObservable(iterable | () => iterable)` returns a cold Observable: each subscription starts its
own iteration.

## `@agent-runtime/core/testing`

`FakeProvider` is a scriptable provider for tests, demos, and prototyping a UI without API keys.

```ts
import { FakeProvider } from '@agent-runtime/core/testing'

const fake = new FakeProvider()
fake.onSend = (sessionId, content) => {
  fake.emit(sessionId,
    { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: 'm:0', content: [{ type: 'text', text: 'Hi!' }] } } },
    { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } },
  )
}
const runtime = createRuntime({ store: new MemoryStore(), bus: new MemoryBus(), providers: { fake } })
```

| Member | Description |
| --- | --- |
| `emit(sessionId, ...outputs)` | Push provider outputs (`event`, `tool_request`, `approval_request`, `usage`, …) |
| `onSend`, `onToolResult`, `onApproval` | Hooks to script the agent's reactions |
| `calls` | Every adapter call made by the runtime |
| `disconnect(sessionId)` | Simulate a dropped provider connection |
| `capabilities` | Writable, to test capability handling |

## Storage interfaces

`MemoryStore` and `MemoryBus` implement these in memory. Share one pair between several runtimes to
simulate a cluster in tests.

To use another database, implement `Store` and `Bus`, then run the shared contract tests in
`packages/store-postgres/test/store-contract.ts` against your implementation.

```ts
interface Bus {
  publish(topic: string, payload: string): Promise<void>               // payloads < 7 KB
  subscribe(topic: string, handler: (payload: string) => void): () => void
}
```

`Store` covers six areas: sessions (create/get/update), leases (`tryAcquireLease`, `renewLease`,
`releaseLease`, `findOrphans`), events (`appendEvent` with per-session `seq` and `sourceId`
dedupe, `readEvents`), commands, actions (compare-and-set `resolveAction`), and transcripts. See
`src/store.ts` for the exact contract.

## Provider interface

`ProviderAdapter`, `ProviderOutput`, `ProviderCapabilities`, `ConnectContext`, `ProviderContext`,
`ToolDefinition`, `ToolResult`: see [Writing a provider](../../docs/extending.md).

## Further reading

- [Concepts](../../docs/concepts.md)
- [Getting started](../../docs/getting-started.md)
- [Behaviour spec](../../docs/behavior-spec.md)
- [Frontend guide](../../docs/frontend-guide.md)
