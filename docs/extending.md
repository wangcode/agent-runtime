# Writing a provider or driver

There are two ways to add a new agent backend, such as Mastra:

| You want to… | Implement | Where it runs |
| --- | --- | --- |
| Connect to a service that hosts agents and has its own API | a **provider** (`ProviderAdapter`) | your backend |
| Run an agent framework inside an AgentCore container | a **driver** (`AgentDriver`) | the container |

## Providers

A provider adapts one external API to the runtime. The runtime handles persistence, commands,
tools, approvals, ownership, and fan-out. The provider only translates.

```ts
import type { ProviderAdapter, ProviderOutput } from '@agent-runtime/core'

export class MyProvider implements ProviderAdapter<MyConfig> {
  readonly name = 'my-provider'

  async createSession({ sessionId, config, metadata, tools }) {
    const remote = await api.createSession(config)
    return { providerSessionId: remote.id, cursor: null }
  }

  async *connect(ctx): AsyncGenerator<ProviderOutput> {
    // Open the stream, resuming from ctx.cursor. Reconnect internally until ctx.signal aborts.
    const stream = await api.stream(ctx.providerSessionId, { after: ctx.cursor, signal: ctx.signal })
    yield { kind: 'ready' } // commands may flow now
    for await (const raw of stream) {
      yield { kind: 'event', event: { type: 'message.completed', data: { … }, raw, sourceId: raw.id } }
      yield { kind: 'cursor', cursor: raw.id }
    }
  }

  async sendMessage(ctx, content) { await api.send(ctx.providerSessionId, content) }
  async interrupt(ctx) { … }
  async submitToolResult(ctx, requestId, result) { … }
  async submitApproval(ctx, requestId, decision) { … }
  async terminate(ctx) { … } // optional
}
```

### What `connect()` may yield

| Output | Meaning |
| --- | --- |
| `{ kind: 'ready' }` | The stream is live; the runtime starts executing queued commands. Yield it once per (re)connect |
| `{ kind: 'event', event }` | A unified event. Set `sourceId` to a stable provider id so replays are deduplicated |
| `{ kind: 'cursor', cursor }` | A resume point, stored with the session and passed back on the next `connect()` |
| `{ kind: 'tool_request', requestId, toolUseId, name, input }` | The agent called a custom tool; the runtime runs the handler and calls `submitToolResult(requestId, …)` |
| `{ kind: 'approval_request', requestId, toolUseId, name, input }` | The agent needs permission; the runtime decides and calls `submitApproval(requestId, …)` |
| `{ kind: 'actions_reset', reason }` | The provider forgot its pending requests; the runtime cancels them |

### Rules

- **Coverage table.** Declare a coverage table typed with `satisfies Record<SdkEventType, 'mapped' | 'custom' | 'ignored'>`
  over your provider SDK's event type union, and drive the mapper from it, so SDK upgrades fail the
  build instead of silently dropping events. Unknown types at runtime must become `provider.custom`.
  See [Event coverage](event-coverage.md).

- **Who records what.** Don't emit `user.message`, or `tool.result` for custom tools: the runtime
  records those itself. Skip the provider's echoes of them.
- **Stable ids.** Use stable `sourceId`s. Replaying history must produce the same ids.
- **When to end.** End the iterable only when `ctx.signal` aborts or the remote session no longer
  exists. Throwing makes the runtime reconnect with backoff.
- **Ready means connected.** Only yield `ready` once events emitted after this point cannot be
  missed.
- **Testing.** Use `FakeProvider` from `@agent-runtime/core/testing` as a reference and for
  runtime-level tests.

## Drivers

A driver hosts an agent framework inside the AgentCore container. The container handles the
WebSocket, replay, health, and reconnects.

```ts
import type { AgentDriver } from '@agent-runtime/agentcore-runtime'

export const myDriver: AgentDriver = {
  async start(session) {
    // session.config, session.tools (caller-side tools), session.sessionStore
    const agent = createAgent({
      tools: session.tools.map((t) => ({
        ...t,
        run: async (input, toolUseId) => (await session.requestTool({ toolUseId, name: t.name, input })).content,
      })),
      approve: async (call) => (await session.requestApproval(call)).behavior === 'allow',
    })
    return {
      async sendMessage(content) {
        session.setBusy(true)
        session.emit({ type: 'session.status', data: { status: 'running' } })
        void agent.run(content, {
          onText: (t) => session.emit({ type: 'text.delta', data: { messageId: 'm1', text: t } }),
          onDone: (msg) => {
            session.emit({ type: 'message.completed', data: { messageId: 'm1', content: msg } })
            session.emit({ type: 'session.status', data: { status: 'idle' } })
            session.emit({ type: 'turn.completed', data: { stopReason: 'end_turn' } })
            session.setBusy(false)
          },
        })
      },
      async interrupt() { agent.stop() },
      async close() { agent.dispose() },
    }
  },
}
```

### `DriverSession` API

| Member | Purpose |
| --- | --- |
| `sessionId`, `config`, `tools` | From the caller's `hello` |
| `emit(event)` | Send a unified event. Delta types are sent live; everything else is logged for replay |
| `requestTool({ toolUseId, name, input })` | Run a caller-side tool; resolves with its result, even across reconnects |
| `requestApproval({ toolUseId, name, input })` | Ask the caller's policy or a human; resolves with the decision |
| `sessionStore` | Durable key/value transcript storage in the caller's database |
| `setBusy(busy)` | Drives `/ping`: report `true` while working, so AgentCore doesn't reclaim the microVM |
