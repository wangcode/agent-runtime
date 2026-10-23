import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { firstValueFrom, takeWhile, toArray } from 'rxjs'
import { CapabilityError, CommandError, Runtime } from '@agent-runtime/core'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { FakeProvider } from '@agent-runtime/core/testing'
import { AGENT_RUNTIME, AGENT_RUNTIME_OPTIONS, AgentRuntimeModule, lastEventId, sessionEvents, toHttpException } from '@agent-runtime/nestjs'

describe('AgentRuntimeModule', () => {
  it('builds the runtime from forRootAsync and ties it to the app lifecycle', async () => {
    @Module({ providers: [{ provide: 'STORE', useValue: new MemoryStore() }], exports: ['STORE'] })
    class StoreModule {}
    const fake = new FakeProvider()
    @Module({
      imports: [
        AgentRuntimeModule.forRootAsync({
          imports: [StoreModule],
          inject: ['STORE'],
          useFactory: async (store: MemoryStore) => ({ store, bus: new MemoryBus(), providers: { fake } }),
        }),
      ],
    })
    class App {}

    const app = await NestFactory.createApplicationContext(App, { logger: false })
    const runtime = app.get<Runtime>(AGENT_RUNTIME)
    expect(runtime).toBeInstanceOf(Runtime)
    expect(app.get(Runtime)).toBe(runtime)
    expect(app.get(AGENT_RUNTIME_OPTIONS).store).toBe(app.get('STORE'))
    expect(runtime.started).toBe(true)
    await app.close()
    expect(runtime.started).toBe(false)
  })
})

describe('SSE helpers', () => {
  it('reads Last-Event-ID, then ?after=', () => {
    expect(lastEventId({ headers: { 'last-event-id': '42' }, query: { after: '7' } })).toBe(42)
    expect(lastEventId({ headers: {}, query: { after: '7' } })).toBe(7)
    expect(lastEventId({ headers: { 'last-event-id': 'abc' } })).toBeUndefined()
    expect(lastEventId({ headers: {} })).toBeUndefined()
  })

  it('stamps every message, deltas and heartbeats included, with the latest persisted seq', async () => {
    const fake = new FakeProvider()
    fake.onSend = (sid) => fake.emit(sid, { kind: 'event', event: { type: 'agent.text.delta', data: { messageId: 'm', text: 'hi' } } })
    const runtime = new Runtime({ store: new MemoryStore(), bus: new MemoryBus(), providers: { fake } })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    const stream = sessionEvents(session, { heartbeatMs: 5 }).pipe(takeWhile((m) => m.type !== 'agent.text.delta', true), toArray())
    const messages = firstValueFrom(stream)
    await new Promise((r) => setTimeout(r, 20)) // a few heartbeats with id 1
    await session.send('x')
    const all = await messages
    const types = all.map((m) => m.type ?? 'ping')
    expect(types[0]).toBe('session.created')
    expect(types).toContain('ping')
    expect(types.slice(-3)).toEqual(['user.message', 'session.status', 'agent.text.delta'])
    expect(all.filter((m) => m.comment === 'ping' && all.indexOf(m) < types.indexOf('user.message')).every((m) => m.id === '1')).toBe(true)
    expect(all.at(-1)).toMatchObject({ id: '3', type: 'agent.text.delta' }) // live-only, carries the last seq
    await runtime.close()
  })

  it('maps runtime errors to HTTP exceptions', () => {
    expect(toHttpException(new CommandError('x', 'c'))?.getStatus()).toBe(409)
    expect(toHttpException(new CapabilityError('x', 'approvalUpdatedInput'))?.getStatus()).toBe(422)
    expect(toHttpException(new Error('Session s1 not found'))?.getStatus()).toBe(404)
    expect(toHttpException(new Error('Session s1 is terminated'))?.getStatus()).toBe(409)
    expect(toHttpException(new Error('boom'))).toBeUndefined()
  })
})
