import { afterEach, describe, expect, it } from 'vitest'
import { firstValueFrom, filter, take, toArray } from 'rxjs'
import { MemoryBus, MemoryStore, type Runtime, type RuntimeEvent, type RuntimeOptions, createRuntime } from '@agent-runtime/core'
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
      { kind: 'event', event: { type: 'message.start', data: { messageId: 'm1', kind: 'text' } } },
      { kind: 'event', event: { type: 'text.delta', data: { messageId: 'm1', text: text.slice(0, 3) } } },
      { kind: 'event', event: { type: 'message.completed', data: { messageId: 'm1', content: [{ type: 'text', text }] }, sourceId: 'p1' } },
      { kind: 'event', event: { type: 'session.status', data: { status: 'idle' } } },
      { kind: 'event', event: { type: 'turn.completed', data: { stopReason: 'end_turn' } } },
    )
  }
}

describe('runtime basics', () => {
  it('runs a turn and streams persisted + delta events', async () => {
    const { runtime, fake } = setup()
    agentReplies(fake, 'hello world')
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    const events = collect(session.events(), (e) => e.type === 'turn.completed')
    await session.send('hi')
    const got = await events
    expect(got.map((e) => e.type)).toEqual([
      'session.created',
      'user.message',
      'session.status',
      'message.start',
      'text.delta',
      'message.completed',
      'session.status',
      'turn.completed',
    ])
    expect(got.filter((e) => e.seq !== undefined).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(got.find((e) => e.type === 'text.delta')?.ephemeral).toBe(true)
    expect(fake.calls[0]).toMatchObject({ method: 'sendMessage', content: [{ type: 'text', text: 'hi' }] })
    expect((await session.info()).status).toBe('idle')
  })

  it('resumes from a seq without duplicates or gaps (Last-Event-ID)', async () => {
    const { runtime, fake } = setup()
    agentReplies(fake, 'abc')
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('one')
    await collect(session.events({ includeDeltas: false }), (e) => e.type === 'turn.completed')
    const replay = await collect(session.events({ after: 3, follow: false }), () => false)
    expect(replay.map((e) => e.seq)).toEqual([4, 5, 6])
  })

  it('dedupes provider events by sourceId (replay after reconnect)', async () => {
    const { runtime, fake } = setup()
    const session = await runtime.createSession({ provider: 'fake', config: {} })
    await session.send('x')
    const msg = { kind: 'event' as const, event: { type: 'message.completed' as const, data: { messageId: 'a', content: [] }, sourceId: 'evt_1' } }
    fake.emit(session.id, msg)
    fake.disconnect(session.id)
    await waitFor(() => fake.connections.length === 2)
    fake.emit(session.id, msg, { kind: 'event', event: { type: 'turn.completed', data: { stopReason: 'end_turn' }, sourceId: 'evt_2' } })
    const all = await collect(session.events({ includeDeltas: false }), (e) => e.type === 'turn.completed')
    expect(all.filter((e) => e.type === 'message.completed')).toHaveLength(1)
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
        filter((e) => e.type === 'message.completed'),
        take(1),
        toArray(),
      ),
    )
    await session.send('go')
    const [msg] = await completed
    expect(msg?.type === 'message.completed' && msg.data.content).toEqual([{ type: 'text', text: 'rx' }])
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
    const events = collect(remote!.events(), (e) => e.type === 'turn.completed')
    await session.send('hi')
    expect((await events).map((e) => e.type)).toContain('text.delta')
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

  it('releases ownership when idle and re-acquires on the next command', async () => {
    const { runtime, fake } = setup({ idleReleaseMs: 50 })
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
