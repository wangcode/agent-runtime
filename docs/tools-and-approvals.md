# Tools and approvals

The agent keeps working when no browser is connected, so two kinds of interaction have to be
handled on the server:

1. **Custom tools.** The agent calls a function that you implement, such as "look up an order".
2. **Permissions.** The agent wants to do something that needs a yes or no, such as "run this shell
   command".

## Custom tools

Register tools once on the runtime. Every provider and every session can use them.

```ts
createRuntime({
  // …
  tools: {
    lookup_order: {
      description: 'Look up an order by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async (input: { id: string }, ctx) => {
        const order = await db.orders.find(input.id, { signal: ctx.signal })
        return order ? JSON.stringify(order) : { content: [{ type: 'text', text: 'not found' }], isError: true }
      },
    },
  },
})
```

### Handler return values

| You return | The agent receives |
| --- | --- |
| a string | one text block |
| `ContentBlock[]` | those blocks |
| `{ content, isError? }` | exactly that |
| any other object | its JSON as text |
| `null` / `undefined` | an empty result |
| *(throws)* | the error message, marked `isError` |

### Handler context

`ctx` contains `sessionId`, `toolUseId`, `name`, the session `metadata`, and a `signal`. The
signal is aborted if this instance loses ownership of the session; another instance will run the
tool again.

### Rules for handlers

- **Make handlers idempotent.** If an instance crashes while a handler runs, the next owner runs
  it again. Use `ctx.toolUseId` as an idempotency key for side effects.
- **No frontend needed.** Handlers run on whichever instance owns the session, whether or not a
  browser is connected.
- **Unknown tools fail cleanly.** A custom tool with no registered handler returns an error result
  to the agent instead of hanging.

### Declaring tools to the provider

- **Managed Agents:** declare custom tools in the agent definition you create with the Anthropic
  API (`type: 'custom'`). The runtime matches calls to handlers by name.
- **AgentCore:** nothing to do. The runtime sends the tool list to the container, which exposes the
  tools to the Claude Agent SDK automatically.

## Approvals

When the provider asks whether a tool may run, the runtime first asks your **policy**:

```ts
createRuntime({
  // …
  approvals: {
    policy: async ({ name, input, metadata, sessionId, provider }) => {
      if (name === 'read_file') return 'allow'
      if (name === 'delete_database') return { decision: 'deny', message: 'Never.' }
      if (metadata.plan === 'enterprise') return { decision: 'ask', timeoutMs: 30 * 60_000 }
      return 'ask'
    },
    timeoutMs: 10 * 60_000,   // how long 'ask' waits (default 10 minutes)
    defaultOnTimeout: 'deny', // what happens when nobody answers (default 'deny')
  },
})
```

| Policy returns | What happens |
| --- | --- |
| `'allow'` / `{ decision: 'allow' }` | Approved immediately; an `approval.resolved` event with `by: 'policy'` is recorded |
| `'deny'` / `{ decision: 'deny', message }` | Denied immediately; the message is shown to the agent |
| `'ask'` / `{ decision: 'ask', timeoutMs? }` | An `approval.requested` event is emitted and the runtime waits for a human |
| *(throws)* | Treated as `'ask'`, so a policy bug never blocks the session |

With no policy configured, everything is `'ask'`.

### Answering an approval

```ts
await session.resolveApproval(approvalId, 'allow')
await session.resolveApproval(approvalId, 'deny', 'Please use the staging database')
await session.resolveApproval(approvalId, { behavior: 'allow', updatedInput: { path: '/safe/dir' } })
```

- `approvalId` comes from the `approval.requested` event, or from `session.pendingApprovals()`
  after a page reload.
- Any instance can answer, even one that doesn't own the session.
- Exactly one decision wins. A second answer, or an answer after the timeout, is rejected with a
  `CommandError` ("already resolved").
- `updatedInput` lets the reviewer change the tool's input. The Claude Agent SDK supports it;
  Managed Agents ignores it.

### Timeouts

Each approval stores its deadline in the database. If the owner crashes, the new owner re-arms
the timer with the remaining time. When it fires, `defaultOnTimeout` is applied and recorded as
`by: 'timeout'`.

### Which tools ask for permission?

That is decided by the provider, before the runtime is involved:

- **Managed Agents:** the agent's permission policies (`always_allow`, `always_ask`, `auto`). Only
  calls the service evaluates as `ask` reach your policy.
- **Claude Agent SDK:** the SDK's `permissionMode` and `allowedTools`. Tools not pre-allowed go
  through `canUseTool`, which forwards them to your policy. Custom tools registered on the runtime
  are always allowed.

## Cancelled requests

Sometimes the provider forgets what it was waiting for. The typical case is an AgentCore microVM
being replaced. The adapter then reports `actions_reset`, and the runtime:

- marks every pending tool call and approval as `cancelled`;
- emits `approval.resolved` with `decision: 'deny', by: 'system'` for open approvals, so your UI
  can close the dialog.
