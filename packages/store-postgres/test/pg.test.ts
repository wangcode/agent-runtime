import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { MemoryStore, type Runtime, type RuntimeEvent, createRuntime } from '@agent-runtime/core'
import { FakeProvider } from '@agent-runtime/core/testing'
import { PgBus, PgStore, migrate } from '@agent-runtime/store-postgres'
import { storeContract } from './store-contract.js'

storeContract('memory', () => new MemoryStore())

/**
 * Postgres tests need a database: `AGENT_RUNTIME_PG_URL=postgres://postgres@127.0.0.1:54329/postgres`.
 * Each run uses its own schema and drops it afterwards.
 */
const url = process.env.AGENT_RUNTIME_PG_URL
const schema = `ar_test_${process.pid}_${Date.now()}`

describe.skipIf(!url)('postgres', () => {
  let pool: pg.Pool
  const buses: PgBus[] = []
  const runtimes: Runtime[] = []

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 20 })
    await Promise.all([migrate(pool, { schema }), migrate(pool, { schema })])
  })

  afterAll(async () => {
    await Promise.all(runtimes.map((r) => r.close()))
    await Promise.all(buses.map((b) => b.close()))
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.end()
  })

  storeContract('postgres', () => new PgStore({ pool, schema }))

  const newBus = async () => {
    const bus = new PgBus({ pool, listenConfig: { connectionString: url }, channel: schema })
    buses.push(bus)
    await bus.start()
    return bus
  }

  it('delivers notifications across bus instances', async () => {
    const [a, b] = await Promise.all([newBus(), newBus()])
    const received = new Promise<string>((resolve) => b.subscribe('topic:x', resolve))
    a.subscribe('topic:y', () => {
      throw new Error('wrong topic')
    })
    await a.publish('topic:x', 'hello')
    expect(await received).toBe('hello')
  })

  it('runs a session across two instances backed by Postgres', async () => {
    const fake = new FakeProvider()
    const make = async () => {
      const rt = createRuntime({
        store: new PgStore({ pool, schema }),
        bus: await newBus(),
        providers: { fake },
        pollIntervalMs: 200,
        orphanScanIntervalMs: 100,
        lease: { ttlMs: 500, renewIntervalMs: 150 },
        reconnect: { baseMs: 10, maxMs: 50 },
        tools: { echo: { description: '', inputSchema: {}, handler: (i: { v: string }) => i.v } },
      })
      runtimes.push(rt)
      return rt
    }
    const a = await make()
    const b = await make()
    fake.onSend = (sid, content) =>
      fake.emit(
        sid,
        { kind: 'event', event: { type: 'session.status', data: { status: 'running' } } },
        { kind: 'event', event: { type: 'agent.text.delta', data: { messageId: 'm', text: 'he' } } },
        { kind: 'tool_request', requestId: `r-${JSON.stringify(content)}`, toolUseId: 't', name: 'echo', input: { v: 'pong' } },
      )
    fake.onToolResult = (sid) =>
      fake.emit(
        sid,
        { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: 'm', content: [{ type: 'text', text: 'hello' }] } } },
        { kind: 'event', event: { type: 'session.status', data: { status: 'idle' } } },
        { kind: 'event', event: { type: 'turn.completed', data: { stopReason: 'end_turn' } } },
      )

    const session = await a.createSession({ provider: 'fake', config: {} })
    const remote = (await b.getSession(session.id))!
    const seen: RuntimeEvent[] = []
    const done = (async () => {
      for await (const e of remote.events()) {
        seen.push(e)
        if (e.type === 'turn.completed') return
      }
    })()
    await remote.send('ping')
    await done
    const types = seen.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['user.message', 'agent.text.delta', 'tool.result', 'agent.message.completed', 'turn.completed']))
    expect(seen.find((e) => e.type === 'tool.result')).toMatchObject({ data: { content: [{ type: 'text', text: 'pong' }] } })
    // The instance that received the command took ownership because the session was unowned.
    expect(b.ownedSessions).toContain(session.id)

    // Kill the owner without releasing its lease; the other instance takes over the busy session.
    await pool.query(`UPDATE ${schema}.sessions SET status = 'running' WHERE id = $1`, [session.id])
    const workers = (b as unknown as { workers: Map<string, { stop(o: { release: boolean }): Promise<void> }> }).workers
    await workers.get(session.id)?.stop({ release: false })
    await b.close()
    const start = Date.now()
    while (!a.ownedSessions.includes(session.id)) {
      if (Date.now() - start > 5000) throw new Error('takeover did not happen')
      await new Promise((r) => setTimeout(r, 50))
    }
    expect((await new PgStore({ pool, schema }).getSession(session.id))?.ownerInstance).toBe(a.instanceId)
  })
})
