# Getting started

This guide takes you from nothing to a backend that streams an agent conversation to a browser.

- **Part 1** runs without any API keys, using a simulated provider.
- **Part 2** switches to a real provider and Postgres.

Requirements: Node.js 20 or newer.

## Part 1: a working backend in one file

### Install

```bash
pnpm add @agent-runtime/core @agent-runtime/stores-memory express
```

### `server.ts`

```ts
import express from 'express'
import { createRuntime, toSSE } from '@agent-runtime/core'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { FakeProvider } from '@agent-runtime/core/testing'

// A simulated provider: replies "You said: …" to every message.
const fake = new FakeProvider()
fake.onSend = (sessionId, content) => {
  const text = content.map((b) => ('text' in b ? b.text : '')).join('')
  fake.emit(
    sessionId,
    { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: `${Date.now()}:0`, content: [{ type: 'text', text: `You said: ${text}` }] } } },
    { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } },
  )
}

const runtime = createRuntime({
  store: new MemoryStore(), // keeps everything in memory
  bus: new MemoryBus(),     // notifications inside this process
  providers: { fake },      // the key ('fake') is what sessions refer to
})

const app = express()
app.use(express.json())

// Create a session.
app.post('/sessions', async (_req, res) => {
  const session = await runtime.createSession({ provider: 'fake', config: {} })
  res.status(201).json({ id: session.id })
})

// Send a message. Resolves once the provider accepted it; the reply arrives as events.
app.post('/sessions/:id/messages', async (req, res) => {
  const session = await runtime.getSession(req.params.id)
  if (!session) return res.status(404).end()
  await session.send(String(req.body.text))
  res.status(202).end()
})

// Stream events as Server-Sent Events, resuming after Last-Event-ID.
app.get('/sessions/:id/events', async (req, res) => {
  const session = await runtime.getSession(req.params.id)
  if (!session) return res.status(404).end()
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

  const abort = new AbortController()
  req.on('close', () => abort.abort()) // the client left; the agent keeps working

  const after = Number(req.header('last-event-id') ?? 0)
  for await (const event of session.events({ after, signal: abort.signal })) {
    res.write(toSSE(event))
  }
  res.end()
})

app.listen(3000, () => console.log('http://localhost:3000'))
```

### Try it

```bash
npx tsx server.ts

ID=$(curl -s -XPOST localhost:3000/sessions | jq -r .id)
curl -N localhost:3000/sessions/$ID/events &        # terminal stays open, printing events
curl -XPOST localhost:3000/sessions/$ID/messages -H 'content-type: application/json' -d '{"text":"hi"}'
```

You should see:

```
id: 1
event: session.created
data: {"id":"1","sessionId":"…","seq":1,"type":"session.created",…}

id: 2
event: user.message
data: {…"data":{"content":[{"type":"text","text":"hi"}]}}

id: 3
event: session.status
data: {…"data":{"status":"running"}}

id: 4
event: agent.message.completed
data: {…"data":{"messageId":"…:0","content":[{"type":"text","text":"You said: hi"}]}}

id: 5
event: session.status
data: {…"data":{"status":"idle"}}

id: 6
event: runtime.turn.completed
data: {…"data":{"stopReason":"end_turn"}}
```

Reconnect with `curl -N localhost:3000/sessions/$ID/events -H 'Last-Event-ID: 4'`: you get events 5
and 6 only. Browsers send this header automatically when an `EventSource` reconnects.

A fuller version of this server, with approvals, interrupts and a slower simulated agent, is in
[`examples/express-sse`](../examples/express-sse/README.md).

## Part 2: real providers and Postgres

### Install

```bash
pnpm add @agent-runtime/stores-postgres pg
pnpm add @agent-runtime/providers-managed-agents @anthropic-ai/sdk   # Claude Managed Agents
pnpm add @agent-runtime/providers-agentcore                          # Claude Agent SDK on AgentCore
```

### Replace the runtime

```ts
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'
import { createRuntime } from '@agent-runtime/core'
import { PgBus, PgStore, migrate } from '@agent-runtime/stores-postgres'
import { managedAgents } from '@agent-runtime/providers-managed-agents'
import { agentCore } from '@agent-runtime/providers-agentcore'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
await migrate(pool) // creates or upgrades the tables; safe on every boot and on many instances at once

const runtime = createRuntime({
  store: new PgStore({ pool }),
  bus: new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } }),
  providers: {
    ma: managedAgents({ client: new Anthropic() }), // reads ANTHROPIC_API_KEY
    ac: agentCore({ endpoint: { region: 'us-west-2', runtimeArn: process.env.AGENTCORE_RUNTIME_ARN! } }),
  },
})
```

The routes stay the same. Only `createSession` needs a real provider config:

```ts
// Claude Managed Agents: the agent and environment are created beforehand with the Anthropic API.
await runtime.createSession({ provider: 'ma', config: { agent: 'agent_…', environmentId: 'env_…' } })

// Claude Agent SDK on AgentCore: config is passed to the container (see docs/agentcore.md).
await runtime.createSession({ provider: 'ac', config: { options: { model: 'claude-sonnet-5-5' } } })
```

Provider setup is described in [Claude Managed Agents](managed-agents.md) and
[Bedrock AgentCore](agentcore.md).

### Add tools and an approval policy

```ts
const runtime = createRuntime({
  // … store, bus, providers …
  tools: {
    lookup_order: {
      description: 'Look up an order by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => JSON.stringify(await db.orders.find(id)),
    },
  },
  approvals: {
    policy: ({ name }) => (name === 'Read' ? 'allow' : 'ask'), // everything else waits for a human
    timeoutMs: 10 * 60_000,
  },
})
```

Approvals are answered with `session.resolveApproval(approvalId, 'allow' | 'deny')` from any
route on any instance. Details: [Tools and approvals](tools-and-approvals.md).

### Shut down cleanly

```ts
process.on('SIGTERM', async () => {
  await runtime.close() // hands sessions to other instances immediately
  process.exit(0)
})
```

## Next steps

| To… | Read |
| --- | --- |
| Build the UI that consumes these events | [Frontend guide](frontend-guide.md) |
| Use the runtime in a NestJS app | [NestJS](nestjs.md) |
| Understand every event and field | [Event model](event-model.md) |
| Run several instances | [Scaling and failover](scaling-and-failover.md) |
| Configure, monitor and troubleshoot | [Operations](operations.md) |
