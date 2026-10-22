# Writing a provider or driver

How to add a new agent backend, such as Mastra. Read [Concepts](concepts.md) and the
[behaviour spec](behavior-spec.md) first: whatever you build must produce exactly the events the
spec describes.

## Provider or driver?

| You want to… | Implement | Runs in | Examples |
| --- | --- | --- | --- |
| Connect to a service that hosts agents and has its own API | a **provider** (`ProviderAdapter`) | your backend | `provider-managed-agents` |
| Run an agent framework inside an AgentCore container | a **driver** (`AgentDriver`) | the container | Claude Agent SDK driver |

A driver needs no new provider: `provider-agentcore` talks to any driver.

---

## Writing a provider

The runtime does persistence, commands, tool execution, approvals, ownership, fan-out and the
behaviour rules. A provider only **translates** between the remote API and the runtime.

### Step 1: the adapter skeleton

```ts
import {
  CapabilityError,
  type ApprovalDecision, type ConnectContext, type ContentBlock, type ProviderAdapter,
  type ProviderCapabilities, type ProviderContext, type ProviderOutput, type SendMessageOptions, type ToolResult,
} from '@agent-runtime/core'

export interface MyConfig { agentId: string }

export class MyProvider implements ProviderAdapter<MyConfig> {
  readonly name = 'my-provider'
  readonly capabilities: ProviderCapabilities = { approvalUpdatedInput: false, thinkingContent: 'full', turnCost: false, systemMessages: 'emulated' }

  constructor(private readonly api: MyApiClient) {}

  async createSession({ sessionId, config }: { sessionId: string; config: MyConfig }) {
    const remote = await this.api.createSession({ agentId: config.agentId, metadata: { runtimeSessionId: sessionId } })
    return { providerSessionId: remote.id, cursor: null }
  }

  async *connect(ctx: ConnectContext<MyConfig>): AsyncGenerator<ProviderOutput> {
    // See step 2.
  }

  async sendMessage(ctx: ProviderContext<MyConfig>, content: ContentBlock[], opts?: SendMessageOptions) {
    // No system role in this API: carry `opts.system` as a reminder block (systemMessages: 'emulated').
    const system = opts?.system?.map((b) => `<system-reminder>\n${b.type === 'text' ? b.text : ''}\n</system-reminder>`) ?? []
    await this.api.send(ctx.providerSessionId, { role: 'user', content: [...content, ...system.map((text) => ({ type: 'text', text }))] })
  }
  async interrupt(ctx: ProviderContext<MyConfig>) {
    await this.api.cancel(ctx.providerSessionId)
  }
  async submitToolResult(ctx: ProviderContext<MyConfig>, requestId: string, result: ToolResult) {
    await this.api.toolResult(ctx.providerSessionId, requestId, result)
  }
  async submitApproval(ctx: ProviderContext<MyConfig>, requestId: string, decision: ApprovalDecision) {
    if (decision.updatedInput) throw new CapabilityError('my-provider cannot change tool input', 'approvalUpdatedInput')
    await this.api.confirm(ctx.providerSessionId, requestId, decision.behavior === 'allow', decision.message)
  }
  async terminate(ctx: ProviderContext<MyConfig>) {
    await this.api.close(ctx.providerSessionId)
  }
}
```

| Method | Contract |
| --- | --- |
| `capabilities` | Declare truthfully; see [capabilities](behavior-spec.md#capabilities) |
| `createSession` | Create the remote session. Return its id and an optional initial cursor. Called once |
| `connect(ctx)` | Long-lived stream of outputs (step 2). Called on the owner; called again after a reconnect or takeover |
| `sendMessage` | Deliver a user message, plus `opts.system` (text-only system context) if given; declare `systemMessages` accordingly. Throwing fails the caller's `send()` with `CommandError` |
| `interrupt` | Ask the agent to stop the current turn. The runtime sets `stopReason: 'interrupted'` itself |
| `submitToolResult` | Answer a `tool_request` you yielded, identified by your `requestId` |
| `submitApproval` | Answer an `approval_request`. May be called more than once for the same request after a crash; must be safe |
| `terminate` | Optional. End the remote session |

`ctx` contains `sessionId`, `providerSessionId`, `config`, `metadata`, and `tools` (the
definitions of the runtime's custom tools, if your API needs them).

### Step 2: `connect()`

`connect()` yields **outputs**. The runtime turns them into stored events, tool executions, and
approval decisions.

```ts
async *connect(ctx: ConnectContext<MyConfig>): AsyncGenerator<ProviderOutput> {
  let cursor = ctx.cursor as string | null
  while (!ctx.signal.aborted) {
    try {
      const stream = await this.api.stream(ctx.providerSessionId, { after: cursor, signal: ctx.signal })
      yield { kind: 'ready' }
      for await (const ev of stream) {
        yield* mapEvent(ev)                       // step 3
        cursor = ev.id
        yield { kind: 'cursor', cursor }
      }
    } catch (err) {
      if (ctx.signal.aborted) return
      if (isGone(err)) {
        yield { kind: 'event', event: { type: 'session.status', data: { status: 'terminated' } } }
        return
      }
      await sleep(1000, ctx.signal)               // reconnect
    }
  }
}
```

| Output | Meaning |
| --- | --- |
| `{ kind: 'ready' }` | The stream is live: anything the provider does from now on will be seen. The runtime starts executing queued commands (e.g. `send()`) only after this, so replies can't be missed. Yield once per (re)connect |
| `{ kind: 'event', event }` | A unified event (step 3) |
| `{ kind: 'cursor', cursor }` | A resume point (any JSON value). Stored after the preceding outputs are handled; passed back as `ctx.cursor` |
| `{ kind: 'tool_request', requestId, toolUseId, name, input }` | The agent called a runtime custom tool. The runtime runs the handler and calls `submitToolResult(requestId, …)` |
| `{ kind: 'approval_request', requestId, toolUseId, name, input }` | The agent needs permission. The runtime decides and calls `submitApproval(requestId, …)` |
| `{ kind: 'usage', usage }` | Usage of one model request; summed into `runtime.turn.completed.usage` |
| `{ kind: 'actions_reset', reason }` | The provider lost its pending requests (e.g. it restarted); the runtime cancels them |

Rules:

- **When to end.** End only when `ctx.signal` aborts or the remote session is gone. If you throw,
  the runtime reconnects with backoff and calls `connect()` again with the stored cursor.
- **Abort promptly.** Stop reading when `ctx.signal` aborts. The runtime stops waiting anyway,
  but the connection should close.
- **Repeated requests are fine.** Yielding the same `tool_request` or `approval_request` again
  after a reconnect is safe: the runtime recognises the `requestId` and does not run it twice.

### Step 3: map events

Emit the unified events defined in the [event model](event-model.md), following the
[behaviour spec](behavior-spec.md):

| The provider reports | Yield |
| --- | --- |
| a text/thinking block streaming | `agent.message.start` once, then `agent.text.delta` / `agent.thinking.delta` with `messageId: <message id>:<block index>` |
| a finished content block | one `agent.message.completed` per block, same `messageId`, `content: [block]` |
| the agent calls a built-in or MCP tool | `tool.call` with `kind: 'builtin' \| 'mcp'`; its `tool.result` when done |
| the agent calls one of the runtime's custom tools | `tool.call` with `kind: 'custom'` **and** a `tool_request` output |
| a tool call needs permission | `tool.call`, then an `approval_request` output |
| the agent is working | `session.status: running` (optional; the runtime starts turns itself) |
| the turn ended | `runtime.turn.completed` with `stopReason`; the runtime adds `session.status: idle` before it |
| errors | `session.error` |
| usage | `usage` outputs, or `usage` on `runtime.turn.completed` |
| a sub-agent produced it | set `threadId` on the event |
| anything else | `provider.custom` with the provider's type name and payload |

Don't emit:

- **`user.message`**: the runtime records your `send()` itself; skip the provider's echo.
- **`tool.result` for custom tools**: the runtime records it.
- **`session.status: idle`**: the runtime emits it before `runtime.turn.completed`.

**Give every persisted event a stable `sourceId`.** Use the provider's event id; if one provider
event yields several unified events, add a suffix (`<id>:0`, `<id>:1`). Replaying the same history
must produce the same `sourceId`s: that is how the runtime drops duplicates after a reconnect or
takeover.

**Drive the mapper from a coverage table.** List every event type your provider's SDK declares:

```ts
import type { SdkEvent } from 'my-provider-sdk'

export const COVERAGE = {
  'message': 'mapped',
  'tool_call': 'mapped',
  'heartbeat': 'ignored',
  'workflow_step': 'custom',
  // …every type, nothing missing
} as const satisfies Record<SdkEvent['type'], 'mapped' | 'custom' | 'ignored'>
```

`satisfies Record<…>` makes the build fail when an SDK upgrade adds a type. At runtime, map types
not in the table to `provider.custom`, never drop them. See [Event coverage](event-coverage.md).

### Step 4: prove it with the conformance suite

1. Write a harness in `packages/conformance/src/harnesses/`: a fake of your provider's API that
   plays each scenario step natively (stream events, tool requests, …). Use the existing harnesses
   as templates.
2. Add it to `HARNESSES` in `packages/conformance/test/conformance.test.ts`.
3. Run `pnpm test`. Every scenario must produce exactly the expected unified events.

See the [conformance README](../packages/conformance/README.md).

### Checklist

- [ ] `capabilities` declared truthfully; unsupported features throw `CapabilityError`
- [ ] `ready` yielded only once events can no longer be missed
- [ ] Stable `sourceId` on every persisted event
- [ ] One `agent.message.completed` per block; deltas share its `messageId`
- [ ] `tool.call` for every tool use; `tool_request` for custom tools; `approval_request` for permissions
- [ ] No `user.message`, custom-tool `tool.result`, or `idle` status emitted
- [ ] Coverage table with `satisfies Record<…>`; unknown types become `provider.custom`
- [ ] Conformance harness passes every scenario

---

## Writing a driver (AgentCore)

A driver hosts an agent framework inside the AgentCore container. The container server handles the
WebSocket, replay, health checks, and reconnects. The caller side needs no changes.

```ts
import type { AgentDriver } from '@agent-runtime/agentcore-runtime'

export const myDriver: AgentDriver = {
  async start(session) {
    const agent = createMyAgent({
      tools: session.tools,                              // the runtime's custom tools (name, description, inputSchema)
      callTool: async (toolUseId, name, input) => {
        session.emit({ type: 'tool.call', data: { toolUseId, name, input, kind: 'custom' } })
        return session.requestTool({ toolUseId, name, input }) // runs in your backend
      },
      askPermission: async (toolUseId, name, input) => {
        session.emit({ type: 'tool.call', data: { toolUseId, name, input, kind: 'builtin' } })
        const d = await session.requestApproval({ toolUseId, name, input })
        return d.behavior === 'allow'
      },
    })

    return {
      async sendMessage(content) {
        session.setBusy(true)
        const messageId = `${crypto.randomUUID()}:0`
        session.emit({ type: 'agent.message.start', data: { messageId, kind: 'text' } })
        void agent.run(content, {
          onText: (text) => session.emit({ type: 'agent.text.delta', data: { messageId, text } }),
          onDone: (fullText, usage) => {
            session.emit({ type: 'agent.message.completed', data: { messageId, content: [{ type: 'text', text: fullText }] } })
            session.emit({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn', usage } })
            session.setBusy(false)
          },
        })
      },
      async interrupt() { agent.stop() },
      async close() { agent.dispose() },
    }
  },
}

await startAgentCoreServer({ driver: myDriver })
```

### `DriverSession` API

| Member | Purpose |
| --- | --- |
| `sessionId` | Runtime session id |
| `config` | The `config` the caller passed to `createSession` |
| `tools` | Definitions of the runtime's custom tools |
| `features.approvalUpdatedInput` | Whether the caller enabled approvals with modified input; ignore `updatedInput` otherwise |
| `emit(event)` | Send a unified event. Delta types are sent live; everything else is logged and replayed after reconnects |
| `requestTool({ toolUseId, name, input })` | Run a custom tool in the caller's backend; resolves with the result, even across reconnects |
| `requestApproval({ toolUseId, name, input })` | Ask the caller's policy or a human; resolves with the decision |
| `sessionStore` | `append`/`load`/`listSubkeys`/`delete`/`has` for transcripts, stored in the caller's database |
| `setBusy(busy)` | Report whether work is in flight. Drives `/ping`, so AgentCore doesn't reclaim a busy microVM |

The same event rules as for providers apply. To verify a driver, add a harness that runs it in a
real `startAgentCoreServer` (see `packages/conformance/src/harnesses/agentcore.ts`).
