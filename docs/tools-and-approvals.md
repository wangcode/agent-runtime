# Tools and approvals

An agent can do two things that need your backend's involvement while a turn is running:

1. **Call a custom tool**: a function you implement, such as "look up an order". The runtime runs
   your handler and sends the result back.
2. **Ask for permission**: before running a tool, such as "run this shell command". Your policy
   decides, or a human does.

Both work whether or not a browser is connected, and on whichever instance owns the session.

## Custom tools

### Register a tool

Register tools once, on the runtime. Every session and every provider can use them.

```ts
createRuntime({
  // …
  tools: {
    lookup_order: {
      description: 'Look up an order by id. Returns status and shipping date.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Order id, e.g. "42"' } },
        required: ['id'],
      },
      handler: async (input: { id: string }, ctx) => {
        const order = await db.orders.find(input.id, { signal: ctx.signal })
        if (!order) return { content: [{ type: 'text', text: `No order ${input.id}` }], isError: true }
        return JSON.stringify({ status: order.status, shippedAt: order.shippedAt })
      },
    },
  },
})
```

| Field | Description |
| --- | --- |
| key (`lookup_order`) | The tool name the agent uses. Must match the name declared to the provider (see below) |
| `description` | Shown to the model; say what the tool does and returns |
| `inputSchema` | JSON Schema of the input, `type: 'object'` |
| `handler(input, ctx)` | Your code. May be sync or async |

### What happens during a call

```
agent                     runtime (owner instance)                 your handler
  │ calls lookup_order ──▶  tool.call event
  │                         stores the call (pending) ───────────▶  handler(input, ctx)
  │                                                    ◀───────────  returns result
  │                         stores the result, tool.result event
  │ ◀── result sent to the provider
  │ continues the turn
```

Because the call is stored before the handler runs, an instance crash in the middle is recovered.
The next owner runs the handler again and sends the result.

### Handler return values

| You return | The agent receives |
| --- | --- |
| a string | one text block |
| `ContentBlock[]` | those blocks (text, image, …) |
| `{ content, isError? }` | exactly that |
| any other object | its JSON, as text |
| `null` / `undefined` | an empty result |
| *(throws)* | the error message as text, with `isError: true` |

### Handler context (`ctx`)

| Field | Description |
| --- | --- |
| `sessionId` | Runtime session id |
| `toolUseId` | Id of this call. Stable across retries; use it as an idempotency key |
| `name` | Tool name |
| `metadata` | The session metadata you passed to `createSession` (e.g. user id, tenant) |
| `signal` | Aborted if this instance loses ownership of the session; another instance will retry |

### Rules for handlers

- **Idempotent.** A crash mid-call means the handler runs again. For side effects (payments,
  emails), deduplicate with `ctx.toolUseId`.
- **No built-in timeout.** The turn waits for the handler. Enforce your own timeout and return an
  error result if it expires.
- **Authorization is yours.** Use `ctx.metadata` to know on whose behalf the call runs. The runtime
  does no access control.
- **Unknown tools.** A call to a custom tool without a registered handler gets an error result
  immediately, so the turn never hangs.

### Declaring tools to the provider

The model only calls tools it knows about.

**Claude Managed Agents:** declare the tool on the agent when you create it with the Anthropic
API. Use the same name and schema:

```ts
await anthropic.beta.agents.create({
  name: 'Support agent',
  model: 'claude-sonnet-5-5',
  tools: [
    { type: 'agent_toolset_20260401' }, // built-in tools (bash, files, web, …)
    {
      type: 'custom',
      name: 'lookup_order',
      description: 'Look up an order by id. Returns status and shipping date.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ],
})
```

**Claude Agent SDK on AgentCore:** nothing to do. The runtime sends its tool list to the
container, which registers the tools with the SDK.

## Approvals

### Which tool calls need a decision

The provider decides which calls need permission. Only those reach the runtime:

| Provider | Configured by | Notes |
| --- | --- | --- |
| Claude Managed Agents | the agent's permission policy: `always_allow`, `always_ask`, or `auto` (the service decides per call) | Calls the service evaluates as `ask` come to the runtime. Custom tools never need permission |
| Claude Agent SDK | `permissionMode` and `allowedTools` in the SDK options | Tools not pre-allowed go through the SDK's `canUseTool`, which the driver forwards to the runtime. Custom tools are always allowed |

Example: require confirmation for every built-in tool on a Managed Agents agent:

```ts
tools: [{ type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'always_ask' } } }]
```

### Your policy decides first

```ts
createRuntime({
  // …
  approvals: {
    policy: async ({ name, input, metadata, sessionId, provider, toolUseId }) => {
      if (name === 'Read' || name === 'Grep') return 'allow'
      if (name === 'Bash' && /rm\s+-rf/.test(String(input.command))) return { decision: 'deny', message: 'Deleting files is not allowed.' }
      if (metadata.role === 'admin') return 'allow'
      return { decision: 'ask', timeoutMs: 30 * 60_000 }
    },
    timeoutMs: 10 * 60_000,   // default wait for 'ask'
    defaultOnTimeout: 'deny', // applied when nobody answers in time
  },
})
```

The policy receives:

| Field | Description |
| --- | --- |
| `name` | Tool name |
| `input` | Tool input |
| `toolUseId` | Id of the call |
| `sessionId` | Runtime session id |
| `provider` | Provider key of the session |
| `metadata` | Session metadata |

It returns one of:

| Return value | Effect | Events |
| --- | --- | --- |
| `'allow'` or `{ decision: 'allow', message? }` | Runs immediately | `approval.resolved` (`by: 'policy'`) |
| `'deny'` or `{ decision: 'deny', message? }` | Refused; the agent sees the message | `approval.resolved` (`by: 'policy'`), then `tool.result` with `isError` |
| `'ask'` or `{ decision: 'ask', timeoutMs? }` | Waits for a human | `approval.requested` |
| `{ decision: 'allow', updatedInput }` | Runs with modified input, if the provider supports it ([see below](#approving-with-modified-input-updatedinput)) | `approval.resolved` (`by: 'policy'`) |
| *(throws)* | Treated as `'ask'`, so a bug in the policy never blocks a session | `approval.requested` |

Without a policy, every call is `'ask'`.

### Waiting for a human

```
tool.call              { toolUseId: "t1", name: "Bash", input: {…} }
approval.requested     { approvalId: "a1", toolUseId: "t1", expiresAt: "…" }
       … a person decides in your UI …
approval.resolved      { approvalId: "a1", decision: "allow", by: "user" }
tool.result            { toolUseId: "t1", … }
```

Answer from any route, on any instance:

```ts
await session.resolveApproval(approvalId, 'allow')
await session.resolveApproval(approvalId, 'deny', 'Please use the staging database')
```

- **Where the id comes from.** `approvalId` is in the `approval.requested` event. After a page
  reload, `await session.pendingApprovals()` returns the open ones, with `id`, `toolUseId`,
  `name`, `input`, and `expiresAt`.
- **Exactly one decision wins.** Answering again, or after the timeout, throws
  `CommandError: Approval … is already resolved`. Map it to HTTP 409.
- **Denials.** A denied call ends with a `tool.result` that has `isError: true` and your message as
  its text. Every `tool.call` gets exactly one `tool.result`.

### Timeouts

The deadline (`expiresAt`) is stored in the database. If the owner crashes, the new owner re-arms
the timer with the remaining time. When it expires, `defaultOnTimeout` is applied and recorded as
`by: 'timeout'`.

### Approving with modified input (`updatedInput`)

Besides allow and deny, a reviewer can **allow the call with different input**. For example, they
might narrow `rm -rf ./build` to `rm -rf ./build/tmp`, correct an email before it is sent, or let a
policy add `--dry-run` to every `git push`:

```ts
await session.resolveApproval(approvalId, { behavior: 'allow', updatedInput: { command: 'rm -rf ./build/tmp' } })

// in a policy
policy: ({ name, input }) =>
  name === 'Bash' && String(input.command).startsWith('git push')
    ? { decision: 'allow', updatedInput: { ...input, command: `${input.command} --dry-run` } }
    : 'ask'
```

This is **off by default**. A reviewer who believes they changed the input while the original
runs is a safety problem, so the runtime never ignores `updatedInput` silently:

| Provider | Support |
| --- | --- |
| Claude Managed Agents | Not supported; the API can only allow or deny |
| Claude Agent SDK (AgentCore) | Supported after enabling it: `agentCore({ allowUpdatedInput: true, … })` |

- **Check before offering it.** `(await session.capabilities()).approvalUpdatedInput` tells your
  UI whether to offer "edit and approve".
- **From a person.** `resolveApproval` with `updatedInput` throws `CapabilityError` when it is not
  available.
- **From a policy.** A policy result with `updatedInput` is logged as an error when it is not
  available, and the call goes to a human instead.

## Cancelled requests

A provider can lose what it was waiting for. The typical case is an AgentCore microVM being
replaced. The runtime then:

- marks every pending tool call and approval as cancelled;
- emits `approval.resolved` with `decision: 'deny', by: 'system'` for each open approval, so your
  UI closes the dialog;
- emits an error `tool.result` for those calls.

The conversation continues normally with the next message.
