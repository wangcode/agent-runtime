import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import { Runtime } from '@agent-runtime/core'
import { AGENT_RUNTIME } from '@agent-runtime/nestjs'
import { createAppModule } from '../src/app.module.js'

const apps: INestApplication[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
})

async function boot() {
  const app = await NestFactory.create(createAppModule({ wordDelayMs: 10 }), { logger: false, forceCloseConnections: true })
  apps.push(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: (await app.getUrl()).replace('[::1]', '127.0.0.1') }
}

interface SSEEvent {
  id?: string
  event?: string
  comment?: string
  data?: { type: string; seq?: number; data: Record<string, unknown> }
}

/** Read SSE frames until `stop` returns true, then disconnect. */
async function readSSE(url: string, stop: (e: SSEEvent) => boolean, lastEventId?: string): Promise<SSEEvent[]> {
  const abort = new AbortController()
  const res = await fetch(url, { headers: lastEventId ? { 'last-event-id': lastEventId } : {}, signal: abort.signal })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
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
        const ev: SSEEvent = {}
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4)
          else if (line.startsWith('event: ')) ev.event = line.slice(7)
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6))
          else if (line.startsWith(': ')) ev.comment = line.slice(2)
        }
        if (!ev.event && !ev.comment) continue
        events.push(ev)
        if (stop(ev)) return events
      }
    }
  } finally {
    abort.abort()
  }
}

const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined,
  }))

describe('NestJS example', () => {
  it('injects a started runtime and closes it with the app', async () => {
    const { app } = await boot()
    const runtime = app.get<Runtime>(AGENT_RUNTIME)
    expect(app.get(Runtime)).toBe(runtime)
    expect(runtime.started).toBe(true)
    await app.close()
    apps.splice(0)
    expect(runtime.started).toBe(false)
  })

  it('streams a turn over SSE and resumes with Last-Event-ID without duplicates', async () => {
    const { url } = await boot()
    const { status, body } = await post(`${url}/sessions`)
    expect(status).toBe(201)
    const id = body!.id as string

    const first = readSSE(`${url}/sessions/${id}/events`, (e) => e.event === 'runtime.turn.completed')
    expect((await post(`${url}/sessions/${id}/messages`, { text: 'hello' })).status).toBe(202)
    const events = await first

    const types = events.map((e) => e.event)
    expect(types).toContain('agent.text.delta')
    expect(types).toContain('agent.message.completed')
    // Every message carries the latest persisted seq as its id, deltas included.
    for (const e of events) expect(Number(e.id)).toBe(Math.max(0, ...events.slice(0, events.indexOf(e) + 1).map((x) => x.data?.seq ?? 0)))
    expect(events.find((e) => e.event === 'agent.message.completed')?.data?.data).toMatchObject({ content: [{ text: 'You said "hello".' }] })

    // Reconnect from the middle: only later persisted events are replayed.
    const mid = events.find((e) => e.event === 'agent.message.completed')!
    const resumed = await readSSE(`${url}/sessions/${id}/events`, (e) => e.event === 'runtime.turn.completed', mid.id)
    expect(resumed.map((e) => e.event)).toEqual(['session.status', 'runtime.turn.completed'])
    expect(resumed.every((e) => Number(e.id) > Number(mid.id))).toBe(true)
  })

  it('handles approvals and maps runtime errors to HTTP status codes', async () => {
    const { url } = await boot()
    const id = (await post(`${url}/sessions`)).body!.id as string
    const requested = readSSE(`${url}/sessions/${id}/events`, (e) => e.event === 'approval.requested')
    await post(`${url}/sessions/${id}/messages`, { text: 'please run ls' })
    const approval = (await requested).at(-1)!.data!.data
    const done = readSSE(`${url}/sessions/${id}/events`, (e) => e.event === 'runtime.turn.completed')
    expect((await post(`${url}/sessions/${id}/approvals/${approval.approvalId as string}`, { decision: 'allow' })).status).toBe(202)
    const types = (await done).map((e) => e.event)
    expect(types).toContain('approval.resolved')
    expect(types).toContain('tool.result')

    expect((await post(`${url}/sessions/nope/messages`, { text: 'x' })).status).toBe(404)
    expect((await fetch(`${url}/sessions/nope/events`)).status).toBe(404)
    // Resolving the same approval twice fails the command: 409.
    expect((await post(`${url}/sessions/${id}/approvals/${approval.approvalId as string}`, { decision: 'deny' })).status).toBe(409)
  })
})
