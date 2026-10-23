import { afterEach, describe, expect, it } from 'vitest'
import { firstValueFrom, filter, take, toArray } from 'rxjs'
import { CapabilityError, Runtime, type RuntimeEvent, type RuntimeOptions, createRuntime } from '@agent-runtime/core'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { toObservable } from '@agent-runtime/core/rxjs'
import { FakeProvider } from '@agent-runtime/core/testing'

const runtimes: Runtime[] = []

function setup(overrides: Partial<RuntimeOptions> = {}, shared?: { store: MemoryStore; bus: MemoryBus; fake: FakeProvider }) {
  const store = shared?.store ?? new MemoryStore()
  const bus = shared?.bus ?? new MemoryBus()
  const fake = shared?.fake ?? new FakeProvider()
  const runtime = createRuntime({
    store,
    bus,
    providers: { fake },
    pollIntervalMs: 50,
    orphanScanIntervalMs: 50,
    idleReleaseMs: 200,
    lease: { ttlMs: 300, renewIntervalMs: 100 },
    reconnect: { baseMs: 10, maxMs: 50 },
    toolCallWaitMs: 20,
    ...overrides,
  })
  runtimes.push(runtime)
  return { runtime, store, bus, fake }
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()))
})

/** Collect events until `until` matches (inclusive). */
async function collect(iter: AsyncIterable<RuntimeEvent>, until: (e: RuntimeEvent) => boolean, timeoutMs = 3000): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = []
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout; got ${out.map((e) => e.type).join(',')}`)), timeoutMs))
  const run = (async () => {
    for await (const e of iter) {
      out.push(e)
      if (until(e)) return out
    }
    return out
  })()
  return Promise.race([run, timeout])
}

const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const agentReplies = (fake: FakeProvider, text: string) => {
  fake.onSend = (sessionId) => {
    fake.emit(
      sessionId,
      { kind: 'event', event: { type: 'session.status', data: { status: 'running' } } },
      { kind: 'event', event: { type: 'agent.message.start', data: { messageId: 'm1', kind: 'text' } } },
      { kind: 'event', event: { type: 'agent.text.delta', data: { messageId: 'm1', text: text.slice(0, 3) } } },
      { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: 'm1', content: [{ type: 'text', text }] }, sourceId: 'p1' } },
      { kind: 'event', event: { type: 'session.status', data: { status: 'idle' } } },
      { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } },
    )
  }
}

describe('runtime basics', () => {
  it('runs a turn and streams persisted + delta events', async () => {
    const { runtime, fake } = setup()
    agentReplies(fake, 'hello world')
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    const events = collect(session.events(), (e) => e.type === 'runtime.turn.completed')
    await session.send('hi')
    const got = await events
    expect(got.map((e) => e.type)).toEqual([
      'session.created',
      'user.message',
      'session.status',
      'agent.message.start',
      'agent.text.delta',
      'agent.message.completed',
      'session.status',
      'runtime.turn.completed',
    ])
    expect(got.filter((e) => e.seq !== undefined).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(got.find((e) => e.type === 'agent.text.delta')?.ephemeral).toBe(true)
    expect(fake.calls[0]).toMatchObject({ method: 'sendMessage', content: [{ type: 'text', text: 'hi' }] })
    expect((await session.info()).status).toBe('idle')
  })

  it('resumes from a seq without duplicates or gaps (Last-Event-ID)', async () => {
    const { runtime, fake } = setup()
    agentReplies(fake, 'abc')
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('one')
    await collect(session.events({ includeDeltas: false }), (e) => e.type === 'runtime.turn.completed')
    const replay = await collect(session.events({ after: 3, follow: false }), () => false)
    expect(replay.map((e) => e.seq)).toEqual([4, 5, 6])
  })

  it('dedupes provider events by sourceId (replay after reconnect)', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    const msg = { kind: 'event' as const, event: { type: 'agent.message.completed' as const, data: { messageId: 'a', content: [] }, sourceId: 'evt_1' } }
    fake.emit(session.id, msg)
    fake.disconnect(session.id)
    await waitFor(() => fake.connections.length === 2)
    fake.emit(session.id, msg, { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' }, sourceId: 'evt_2' } })
    const all = await collect(session.events({ includeDeltas: false }), (e) => e.type === 'runtime.turn.completed')
    expect(all.filter((e) => e.type === 'agent.message.completed')).toHaveLength(1)
  })

  it('persists provider cursors and reconnects with them', async () => {
    const { runtime, fake, store } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, { kind: 'cursor', cursor: { last: 'evt_9' } })
    await waitFor(async () => JSON.stringify((await store.getSession(session.id))?.providerCursor) === '{"last":"evt_9"}')
    fake.disconnect(session.id)
    await waitFor(() => fake.connections.length === 2)
    expect(fake.connections[1]?.cursor).toEqual({ last: 'evt_9' })
  })

  it('exposes events as an Observable', async () => {
    const { runtime, fake } = setup()
    agentReplies(fake, 'rx')
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    const completed = firstValueFrom(
      toObservable(() => session.events()).pipe(
        filter((e) => e.type === 'agent.message.completed'),
        take(1),
        toArray(),
      ),
    )
    await session.send('go')
    const [msg] = await completed
    expect(msg?.type === 'agent.message.completed' && msg.data.content).toEqual([{ type: 'text', text: 'rx' }])
  })
})

describe('custom tools', () => {
  it('executes registered handlers server-side and returns results to the provider', async () => {
    const { runtime, fake } = setup({
      tools: {
        weather: {
          description: 'Get weather',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
          handler: async (input: { city: string }, ctx) => `sunny in ${input.city} (${ctx.toolUseId})`,
        },
      },
    })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('weather?')
    fake.emit(
      session.id,
      { kind: 'event', event: { type: 'tool.call', data: { toolUseId: 'tu1', name: 'weather', input: { city: 'Paris' }, kind: 'custom' } } },
      { kind: 'tool_request', requestId: 'req1', toolUseId: 'tu1', name: 'weather', input: { city: 'Paris' } },
    )
    const events = await collect(session.events(), (e) => e.type === 'tool.result')
    expect(events.at(-1)).toMatchObject({ type: 'tool.result', data: { toolUseId: 'tu1', content: [{ type: 'text', text: 'sunny in Paris (tu1)' }] } })
    await waitFor(() => fake.calls.some((c) => c.method === 'submitToolResult'))
    expect(fake.calls.find((c) => c.method === 'submitToolResult')).toMatchObject({ requestId: 'req1', result: { content: [{ text: 'sunny in Paris (tu1)' }] } })
  })

  it('reports handler errors and unknown tools as isError', async () => {
    const { runtime, fake } = setup({
      tools: { boom: { description: '', inputSchema: {}, handler: () => { throw new Error('kaput') } } },
    })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, { kind: 'tool_request', requestId: 'r1', toolUseId: 't1', name: 'boom', input: {} })
    fake.emit(session.id, { kind: 'tool_request', requestId: 'r2', toolUseId: 't2', name: 'nope', input: {} })
    await waitFor(() => fake.calls.filter((c) => c.method === 'submitToolResult').length === 2)
    const results = fake.calls.filter((c) => c.method === 'submitToolResult')
    expect(results.every((r) => r.method === 'submitToolResult' && r.result.isError)).toBe(true)
  })

  it('does not re-run a tool when the same request is replayed', async () => {
    let runs = 0
    const { runtime, fake } = setup({ tools: { t: { description: '', inputSchema: {}, handler: () => `run ${++runs}` } } })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    const req = { kind: 'tool_request' as const, requestId: 'r1', toolUseId: 't1', name: 't', input: {} }
    fake.emit(session.id, req)
    await waitFor(() => fake.calls.some((c) => c.method === 'submitToolResult'))
    fake.emit(session.id, req)
    await new Promise((r) => setTimeout(r, 100))
    expect(runs).toBe(1)
    expect(fake.calls.filter((c) => c.method === 'submitToolResult')).toHaveLength(1)
  })
})

describe('approvals', () => {
  const approvalRequest = { kind: 'approval_request' as const, requestId: 'ar1', toolUseId: 'tu9', name: 'bash', input: { cmd: 'ls' } }

  it('auto-resolves with the policy', async () => {
    const { runtime, fake } = setup({ approvals: { policy: (req) => (req.name === 'bash' ? { decision: 'deny', message: 'no shell' } : 'allow') } })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, approvalRequest)
    const events = await collect(session.events(), (e) => e.type === 'approval.resolved')
    expect(events.at(-1)).toMatchObject({ data: { decision: 'deny', by: 'policy', message: 'no shell' } })
    expect(events.some((e) => e.type === 'approval.requested')).toBe(false)
    await waitFor(() => fake.calls.some((c) => c.method === 'submitApproval'))
    expect(fake.calls.find((c) => c.method === 'submitApproval')).toMatchObject({ requestId: 'ar1', decision: { behavior: 'deny', message: 'no shell' } })
  })

  it('waits for a human decision, possibly from another instance', async () => {
    const a = setup()
    const b = setup({}, a)
    const session = await a.runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    a.fake.emit(session.id, approvalRequest)
    const [requested] = (await collect(session.events(), (e) => e.type === 'approval.requested')).slice(-1)
    expect(requested?.type).toBe('approval.requested')
    const approvalId = requested?.type === 'approval.requested' ? requested.data.approvalId : ''

    const remote = await b.runtime.getSession(session.id)
    expect(await remote?.pendingApprovals()).toHaveLength(1)
    await remote?.resolveApproval(approvalId, 'allow')
    expect(a.runtime.ownedSessions).toContain(session.id)
    expect(b.runtime.ownedSessions).not.toContain(session.id)
    expect(a.fake.calls.find((c) => c.method === 'submitApproval')).toMatchObject({ decision: { behavior: 'allow' } })
    await expect(remote?.resolveApproval(approvalId, 'deny')).rejects.toThrow(/already resolved/)
  })

  it('falls back to asking when the policy throws', async () => {
    const { runtime, fake } = setup({
      approvals: {
        policy: () => {
          throw new Error('policy bug')
        },
      },
    })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, approvalRequest)
    await collect(session.events(), (e) => e.type === 'approval.requested')
    expect(await session.pendingApprovals()).toHaveLength(1)
  })

  it('applies the default decision when an approval times out', async () => {
    const { runtime, fake } = setup({ approvals: { timeoutMs: 100 } })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, approvalRequest)
    const events = await collect(session.events(), (e) => e.type === 'approval.resolved')
    expect(events.at(-1)).toMatchObject({ data: { decision: 'deny', by: 'timeout' } })
  })

  it('cancels outstanding requests on actions_reset', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, approvalRequest)
    await collect(session.events(), (e) => e.type === 'approval.requested')
    fake.emit(session.id, { kind: 'actions_reset', reason: 'runtime restarted' })
    const events = await collect(session.events(), (e) => e.type === 'approval.resolved')
    expect(events.at(-1)).toMatchObject({ data: { decision: 'deny', by: 'system' } })
    expect(await session.pendingApprovals()).toHaveLength(0)
  })
})

describe('multi-instance', () => {
  it('routes commands from a non-owner instance to the owner', async () => {
    const a = setup()
    const b = setup({}, a)
    const session = await a.runtime.createSession({ provider: 'fake', config: {} })
    await session.send('first')
    expect(a.runtime.ownedSessions).toEqual([session.id])
    const remote = await b.runtime.getSession(session.id)
    await remote?.send('second')
    await remote?.interrupt()
    expect(b.runtime.ownedSessions).toEqual([])
    expect(a.fake.calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage', 'interrupt'])
  })

  it('streams live deltas to subscribers on other instances', async () => {
    const a = setup()
    const b = setup({}, a)
    agentReplies(a.fake, 'cross instance')
    const session = await a.runtime.createSession({ provider: 'fake', config: {} })
    const remote = await b.runtime.getSession(session.id)
    const events = collect(remote!.events(), (e) => e.type === 'runtime.turn.completed')
    await session.send('hi')
    expect((await events).map((e) => e.type)).toContain('agent.text.delta')
  })

  it('takes over a busy session when the owner dies and resumes pending work', async () => {
    let runs = 0
    const shared = { store: new MemoryStore(), bus: new MemoryBus(), fake: new FakeProvider() }
    const tools = { slow: { description: '', inputSchema: {}, handler: async () => `done ${++runs}` } }
    const a = setup({ tools, approvals: { timeoutMs: 60_000 } }, shared)
    const session = await a.runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    shared.fake.emit(session.id, { kind: 'event', event: { type: 'session.status', data: { status: 'running' } } })
    shared.fake.emit(session.id, { kind: 'approval_request', requestId: 'ar', toolUseId: 'tu', name: 'bash', input: {} })
    await collect(session.events(), (e) => e.type === 'approval.requested')

    // Simulate a crash: stop the worker without releasing the lease.
    const internals = (a.runtime as unknown as { workers: Map<string, { stop(o: { release: boolean }): Promise<void> }> }).workers
    await internals.get(session.id)?.stop({ release: false })
    await a.runtime.close()

    const b = setup({ tools, approvals: { timeoutMs: 60_000 } }, shared)
    await waitFor(() => b.runtime.ownedSessions.includes(session.id))
    expect(shared.fake.connections.length).toBe(2)

    // The new owner still honours the pending approval and keeps running tools.
    const [approval] = await session.pendingApprovals()
    const remote = await b.runtime.getSession(session.id)
    await remote?.resolveApproval(approval!.id, 'allow')
    shared.fake.emit(session.id, { kind: 'tool_request', requestId: 'tr', toolUseId: 'tu2', name: 'slow', input: {} })
    await waitFor(() => shared.fake.calls.some((c) => c.method === 'submitToolResult'))
    expect(runs).toBe(1)
  })

  it('only adopts orphaned sessions after start()', async () => {
    const shared = { store: new MemoryStore(), bus: new MemoryBus(), fake: new FakeProvider() }
    const a = setup({}, shared)
    const session = await a.runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    const workers = (a.runtime as unknown as { workers: Map<string, { stop(o: { release: boolean }): Promise<void> }> }).workers
    await workers.get(session.id)?.stop({ release: false })
    await a.runtime.close()

    const b = new Runtime({ store: shared.store, bus: shared.bus, providers: { fake: shared.fake }, orphanScanIntervalMs: 50, lease: { ttlMs: 300, renewIntervalMs: 100 } })
    runtimes.push(b)
    expect(b.started).toBe(false)
    await new Promise((r) => setTimeout(r, 500)) // lease expired, but nobody scans
    expect(b.ownedSessions).toEqual([])
    expect(b.start().start()).toBe(b) // idempotent
    expect(b.started).toBe(true)
    await waitFor(() => b.ownedSessions.includes(session.id))
    await b.close()
    expect(b.started).toBe(false)
    expect(() => b.start()).toThrow(/closed/)
  })

  it('releases ownership when idle and re-acquires on the next command', async () => {
    const { runtime, fake } = setup({ idleReleaseMs: 50 })
    fake.onSend = (sid) => fake.emit(sid, { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    await waitFor(() => runtime.ownedSessions.length === 0)
    await session.send('y')
    expect(fake.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2)
  })

  it('terminates sessions and ends event streams', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.terminate()
    const events = await collect(session.events(), () => false)
    expect(events.at(-1)).toMatchObject({ type: 'session.status', data: { status: 'terminated' } })
    expect(fake.calls.at(-1)?.method).toBe('terminate')
    await expect(session.send('x')).rejects.toThrow(/terminated/)
  })
})

describe('behaviour normalization', () => {
  const ev = (event: object) => ({ kind: 'event' as const, event: event as never })

  it('ends every turn with idle then runtime.turn.completed, without repeated statuses', async () => {
    const { runtime, fake } = setup()
    fake.onSend = (sid) =>
      fake.emit(
        sid,
        ev({ type: 'session.status', data: { status: 'running' } }),
        ev({ type: 'session.status', data: { status: 'running' } }),
        ev({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } }),
      )
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    const types = (await collect(session.events({ includeDeltas: false }), (e) => e.type === 'runtime.turn.completed')).map((e) =>
      e.type === 'session.status' ? `status:${e.data.status}` : e.type,
    )
    expect(types).toEqual(['session.created', 'user.message', 'status:running', 'status:idle', 'runtime.turn.completed'])
  })

  it('reports interrupted for a turn that was interrupted, whatever the provider said', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('long task')
    await session.interrupt()
    fake.emit(session.id, ev({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } }))
    const done = (await collect(session.events(), (e) => e.type === 'runtime.turn.completed')).at(-1)
    expect(done).toMatchObject({ data: { stopReason: 'interrupted' } })

    // The next turn is not affected.
    fake.onSend = (sid) => fake.emit(sid, ev({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } }))
    await session.send('again')
    const next = (await collect(session.events({ after: done!.seq }), (e) => e.type === 'runtime.turn.completed')).at(-1)
    expect(next).toMatchObject({ data: { stopReason: 'end_turn' } })
  })

  it('sums per-request usage into runtime.turn.completed, unless the provider reports a turn total', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(
      session.id,
      { kind: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { kind: 'usage', usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.01 } },
      ev({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } }),
    )
    const first = (await collect(session.events(), (e) => e.type === 'runtime.turn.completed')).at(-1)
    expect(first).toMatchObject({ data: { usage: { inputTokens: 15, outputTokens: 5, costUsd: 0.01 } } })

    await session.send('y')
    fake.emit(
      session.id,
      { kind: 'usage', usage: { inputTokens: 99 } },
      ev({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } }),
    )
    const second = (await collect(session.events({ after: first!.seq }), (e) => e.type === 'runtime.turn.completed')).at(-1)
    expect(second).toMatchObject({ data: { usage: { inputTokens: 1, outputTokens: 1 } } })
  })

  it('persists and streams thread attribution', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, ev({ type: 'agent.message.completed', data: { messageId: 'm:0', content: [] }, threadId: 'sub_1' }))
    const msg = (await collect(session.events(), (e) => e.type === 'agent.message.completed')).at(-1)
    expect(msg?.threadId).toBe('sub_1')
  })

  it('sends system context with a message and records it on user.message', async () => {
    const { runtime, fake } = setup()
    agentReplies(fake, 'ok')
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    const events = collect(session.events(), (e) => e.type === 'runtime.turn.completed')
    await session.send('hi', { system: 'Be brief' })
    const user = (await events).find((e) => e.type === 'user.message')
    expect(user?.data).toEqual({ content: [{ type: 'text', text: 'hi' }], system: [{ type: 'text', text: 'Be brief' }] })
    expect(fake.calls.find((c) => c.method === 'sendMessage')).toMatchObject({ system: [{ type: 'text', text: 'Be brief' }] })
    await expect(session.send('x', { system: [{ type: 'image', source: {} } as never] })).rejects.toBeInstanceOf(TypeError)
    await session.send('plain')
    const plain = (await collect(session.events(), (e) => e.type === 'user.message' && JSON.stringify(e.data).includes('plain'))).at(-1)
    expect(plain?.data).toEqual({ content: [{ type: 'text', text: 'plain' }] })
  })

  it('rejects updatedInput when the provider does not support it, from callers and policies', async () => {
    const { runtime, fake } = setup({ approvals: { policy: () => ({ decision: 'allow', updatedInput: { safe: true } }) } })
    fake.capabilities = { ...fake.capabilities, approvalUpdatedInput: false }
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    expect(await session.capabilities()).toMatchObject({ approvalUpdatedInput: false })
    await session.send('x')
    fake.emit(session.id, { kind: 'approval_request', requestId: 'r', toolUseId: 't', name: 'bash', input: {} })
    // The policy's updatedInput can't be honoured, so a human is asked instead.
    const requested = (await collect(session.events(), (e) => e.type === 'approval.requested')).at(-1)
    const approvalId = requested?.type === 'approval.requested' ? requested.data.approvalId : ''
    await expect(session.resolveApproval(approvalId, { behavior: 'allow', updatedInput: { x: 1 } })).rejects.toBeInstanceOf(CapabilityError)
    await session.resolveApproval(approvalId, 'allow')
    expect(fake.calls.find((c) => c.method === 'submitApproval')).toMatchObject({ decision: { behavior: 'allow' } })
  })

  it('passes updatedInput through when supported', async () => {
    const { runtime, fake } = setup({ approvals: { policy: () => ({ decision: 'allow', updatedInput: { safe: true } }) } })
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    fake.emit(session.id, { kind: 'approval_request', requestId: 'r', toolUseId: 't', name: 'bash', input: {} })
    await waitFor(() => fake.calls.some((c) => c.method === 'submitApproval'))
    expect(fake.calls.find((c) => c.method === 'submitApproval')).toMatchObject({ decision: { behavior: 'allow', updatedInput: { safe: true } } })
  })
})
