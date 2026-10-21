import express from 'express'
import { createRuntime, MemoryBus, MemoryStore, toSSE } from '@agent-runtime/core'
import { FakeProvider } from '@agent-runtime/core/testing'

// A simulated provider: replies "You said: …" to every message.
const fake = new FakeProvider()
fake.onSend = (sessionId, content) => {
  const text = content.map((b) => ('text' in b ? b.text : '')).join('')
  fake.emit(
    sessionId,
    { kind: 'event', event: { type: 'message.completed', data: { messageId: `${Date.now()}:0`, content: [{ type: 'text', text: `You said: ${text}` }] } } },
    { kind: 'event', event: { type: 'turn.completed', data: { stopReason: 'end_turn' } } },
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

app.listen(3931, () => console.log('http://localhost:3000'))
