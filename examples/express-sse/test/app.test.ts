import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { type Runtime, createRuntime } from '@agent-runtime/core'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { FakeProvider } from '@agent-runtime/core/testing'
import { createApp } from '../src/app.js'
import { simulateAgent } from '../src/simulated-agent.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** Two "instances" behind a load balancer, sharing a store and bus. */
async function cluster() {
  const store = new MemoryStore()
  const bus = new MemoryBus()
  const fake = new FakeProvider()
  simulateAgent(fake, { wordDelayMs: 20 })
  const urls: string[] = []
  for (let i = 0; i < 2; i++) {
    const runtime: Runtime = createRuntime({
      store,
      bus,
      providers: { fake },
      pollIntervalMs: 50,
      tools: { get_time: { description: '', inputSchema: {}, handler: () => '12:00' } },
    })
    const server: Server = createApp(runtime, { defaultProvider: 'fake', defaultConfig: () => ({}) }).listen(0)
    await new Promise((r) => server.once('listening', r))
    urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    cleanups.push(() => {
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    }, () => runtime.close())
  }
  return urls
}

interface SSEEvent {
  id?: string
  event: string
  data: { type: string; data: Record<string, unknown> }
}

/** Read SSE frames until `stop` returns true, then disconnect. */
async function readSSE(url: string, stop: (e: SSEEvent, all: SSEEvent[]) => boolean, lastEventId?: string): Promise<SSEEvent[]> {
  const abort = new AbortController()
  const res = await fetch(url, { headers: lastEventId ? { 'last-event-id': lastEventId } : {}, signal: abort.signal })
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
  const events: SSEEvent[] = []
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return events
      buffer += value
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (frame.startsWith(':')) continue
        const ev: Partial<SSEEvent> = {}
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4)
          else if (line.startsWith('event: ')) ev.event = line.slice(7)
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6))
        }
        events.push(ev as SSEEvent)
        if (stop(ev as SSEEvent, events)) return events
      }
    }
  } finally {
    abort.abort()
  }
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (await r.json()) as any,
  }))

describe('express SSE example', () => {
  it('resumes with Last-Event-ID on another instance while the agent keeps working', async () => {
    const [a, b] = await cluster()
    const { body } = await post(`${a}/sessions`)
    const id = body.id as string

    // Client connects to A, sends a message, and drops mid-stream after the first token.
    const first = readSSE(`${a}/sessions/${id}/events`, (e) => e.event === 'agent.text.delta')
    await post(`${a}/sessions/${id}/messages`, { text: 'hello' })
    const beforeDrop = await first
    const lastId = beforeDrop.filter((e) => e.id).at(-1)?.id
    expect(lastId).toBeDefined()

    // Reconnect to B with Last-Event-ID: no duplicates, nothing missing, through to the end.
    const after = await readSSE(`${b}/sessions/${id}/events`, (e) => e.event === 'runtime.turn.completed', lastId)
    const ids = [...beforeDrop, ...after].filter((e) => e.id).map((e) => Number(e.id))
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1))
    expect(after.find((e) => e.event === 'agent.message.completed')?.data.data).toMatchObject({ content: [{ text: 'You said "hello". The time is [{"type":"text","text":"12:00"}].' }] })
  })

  it('handles approvals from any instance, even with no client attached', async () => {
    const [a, b] = await cluster()
    const id = (await post(`${a}/sessions`)).body.id as string
    await post(`${a}/sessions/${id}/messages`, { text: 'please run bash' })
    let approvals: Array<{ id: string }> = []
    for (let i = 0; i < 100 && approvals.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
      approvals = (await (await fetch(`${b}/sessions/${id}/approvals`)).json()) as Array<{ id: string }>
    }
    expect(approvals).toHaveLength(1)
    expect((await post(`${b}/sessions/${id}/approvals/${approvals[0]!.id}`, { decision: 'allow' })).status).toBe(202)
    expect((await post(`${b}/sessions/${id}/approvals/${approvals[0]!.id}`, { decision: 'deny' })).status).toBe(409)
    const all = await readSSE(`${b}/sessions/${id}/events`, (e) => e.event === 'runtime.turn.completed')
    expect(all.filter((e) => e.event === 'agent.message.completed').at(-1)?.data.data).toMatchObject({ content: [{ text: 'Ran `ls -la`.' }] })
  })
})
