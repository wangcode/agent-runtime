# Getting started

This guide wires `agent-runtime` into a Node.js backend and streams agent events to a browser over
Server-Sent Events (SSE).

## 1. Install

Pick the packages you need:

```bash
# always
pnpm add @agent-runtime/core

# production storage (needed for more than one instance)
pnpm add @agent-runtime/store-postgres pg

# providers
pnpm add @agent-runtime/provider-managed-agents @anthropic-ai/sdk
pnpm add @agent-runtime/provider-agentcore

# optional: RxJS interop
pnpm add rxjs
```

Requires Node.js 20 or newer.

## 2. Create a runtime

A **runtime** is the object your backend keeps for its whole lifetime. You give it:

- a **store**, where sessions and events are kept;
- a **bus**, which carries notifications between instances;
- the **providers** you want to use;
- optionally, **tools** that run on your server and an **approval policy**.

```ts
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'
import { createRuntime } from '@agent-runtime/core'
import { PgBus, PgStore, migrate } from '@agent-runtime/store-postgres'
import { managedAgents } from '@agent-runtime/provider-managed-agents'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
await migrate(pool) // creates the tables; safe to run on every boot

const runtime = createRuntime({
  store: new PgStore({ pool }),
  bus: new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } }),
  providers: {
    ma: managedAgents({ client: new Anthropic() }),
  },
  tools: {
    lookup_order: {
      description: 'Look up an order by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => JSON.stringify(await db.orders.find(id)),
    },
  },
  approvals: {
    policy: ({ name }) => (name === 'read' ? 'allow' : 'ask'),
  },
})
```

> **Single process, no database?** Use `new MemoryStore()` and `new MemoryBus()` from
> `@agent-runtime/core`. They are fine for development, tests, and single-instance deployments that
> can afford to lose history on restart.

## 3. Create a session and send a message

```ts
const session = await runtime.createSession({
  provider: 'ma', // the key you used in `providers`
  config: { agent: 'agent_123', environmentId: 'env_456' },
  metadata: { userId: 'u_1' }, // anything you want to keep with the session
})

await session.send('Where is order 42?')
```

`send()` resolves once the message has been handed to the provider. It does **not** wait for the
agent's reply; replies arrive as events.

## 4. Stream events to the browser

Any instance can serve this route, whichever instance is actually talking to the provider:

```ts
import { toSSE } from '@agent-runtime/core'

app.get('/sessions/:id/events', async (req, res) => {
  const session = await runtime.getSession(req.params.id)
  if (!session) return res.status(404).end()

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const abort = new AbortController()
  req.on('close', () => abort.abort())

  const after = Number(req.header('last-event-id') ?? 0)
  for await (const event of session.events({ after, signal: abort.signal })) {
    res.write(toSSE(event))
  }
  res.end()
})
```

The browser's `EventSource` sends `Last-Event-ID` automatically when it reconnects, so a dropped
connection resumes exactly where it stopped: nothing is missed and nothing is repeated. Closing the
connection only stops delivery; **the agent keeps working**.

## 5. Handle approvals and interrupts

```ts
app.post('/sessions/:id/approvals/:approvalId', async (req, res) => {
  const session = await runtime.getSession(req.params.id)
  await session!.resolveApproval(req.params.approvalId, req.body.decision) // 'allow' | 'deny'
  res.status(202).end()
})

app.post('/sessions/:id/interrupt', async (req, res) => {
  await (await runtime.getSession(req.params.id))!.interrupt()
  res.status(202).end()
})
```

The `approvalId` comes from the `approval.requested` event. `session.pendingApprovals()` lists the
ones that are still open, which is useful when a page reloads.

## 6. Shut down cleanly

```ts
process.on('SIGTERM', async () => {
  await runtime.close() // releases ownership so another instance can take over immediately
  process.exit(0)
})
```

## Next steps

- [Event model](event-model.md): what each event contains.
- [Tools and approvals](tools-and-approvals.md): writing tool handlers and policies.
- [Scaling and failover](scaling-and-failover.md): running more than one instance.
- [`examples/express-sse`](../examples/express-sse/README.md): a complete, runnable version of this guide.
