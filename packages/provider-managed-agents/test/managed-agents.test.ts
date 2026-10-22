import { afterEach, describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AsyncQueue, MemoryBus, MemoryStore, type ProviderOutput, type Runtime, type RuntimeEvent, createRuntime } from '@agent-runtime/core'
import { ManagedAgentsProvider, type ManagedAgentsSessionConfig, mapEvent, newMappingState } from '@agent-runtime/provider-managed-agents'

/** Minimal stand-in for `client.beta.sessions`. */
class MockSessions {
  streams: AsyncQueue<unknown>[] = []
  history: Array<Record<string, unknown>> = []
  sent: Array<{ id: string; events: unknown[] }> = []
  listCalls: Array<Record<string, unknown>> = []
  created: Array<Record<string, unknown>> = []
  archived: string[] = []
  streamError: unknown
  onSend?: (events: Array<Record<string, unknown>>) => void

  create = async (params: Record<string, unknown>) => {
    this.created.push(params)
    return { id: 'sesn_1' }
  }
  archive = async (id: string) => {
    this.archived.push(id)
  }
  delete = async () => {}
  events = {
    stream: async () => {
      if (this.streamError) {
        const err = this.streamError
        this.streamError = undefined
        throw err
      }
      const q = new AsyncQueue<unknown>()
      this.streams.push(q)
      return q
    },
    list: (_id: string, params: Record<string, unknown>) => {
      this.listCalls.push(params)
      const items = [...this.history]
      return (async function* () {
        yield* items
      })()
    },
    send: async (id: string, params: { events: Array<Record<string, unknown>> }) => {
      this.sent.push({ id, events: params.events })
      this.onSend?.(params.events)
    },
  }

  /** Emit a live event (also recorded in history, like the real API). */
  push(ev: Record<string, unknown>) {
    if ('id' in ev) this.history.push(ev)
    this.streams.at(-1)?.push(ev)
  }
}

const mockClient = (sessions: MockSessions) => ({ beta: { sessions } }) as unknown as Anthropic

let counter = 0
const ev = (type: string, fields: Record<string, unknown> = {}) => ({
  id: `sevt_${++counter}`,
  type,
  processed_at: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
  ...fields,
})

const runtimes: Runtime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.close()))
})

describe('event mapping', () => {
  const map = (e: Record<string, unknown>, state = newMappingState()) => mapEvent(e as never, state, { includeRaw: false })

  it('maps deltas and messages per content block, with matching ids', () => {
    const state = newMappingState()
    expect(map({ type: 'event_start', event: { id: 'm1', type: 'agent.message' } }, state)).toEqual([])
    const delta = (index: number, text: string) => ({ type: 'event_delta', event_id: 'm1', delta: { type: 'content_delta', content: { type: 'text', text }, index } })
    expect(map(delta(0, 'Hi'), state)).toEqual([
      { kind: 'event', event: { type: 'agent.message.start', data: { messageId: 'm1:0', kind: 'text' } } },
      { kind: 'event', event: { type: 'agent.text.delta', data: { messageId: 'm1:0', text: 'Hi', index: 0 } } },
    ])
    expect(map(delta(0, '!'), state)).toEqual([{ kind: 'event', event: { type: 'agent.text.delta', data: { messageId: 'm1:0', text: '!', index: 0 } } }])
    expect(map(delta(1, 'Bye'), state)[0]).toEqual({ kind: 'event', event: { type: 'agent.message.start', data: { messageId: 'm1:1', kind: 'text' } } })
    expect(map({ id: 'm1', type: 'agent.message', content: [{ type: 'text', text: 'Hi!' }, { type: 'text', text: 'Bye' }], processed_at: 'x' }, state)).toEqual([
      { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: 'm1:0', content: [{ type: 'text', text: 'Hi!' }] }, sourceId: 'm1:0' } },
      { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: 'm1:1', content: [{ type: 'text', text: 'Bye' }] }, sourceId: 'm1:1' } },
    ])
  })

  it('suppresses deltas when asked, but still assembles thinking', () => {
    const state = newMappingState()
    const opts = { includeRaw: false, forwardDeltas: false }
    mapEvent({ type: 'event_start', event: { id: 't1', type: 'agent.thinking' } } as never, state, opts)
    expect(mapEvent({ type: 'event_delta', event_id: 't1', delta: { type: 'content_delta', content: { type: 'text', text: 'deep' } } } as never, state, opts)).toEqual([])
    expect(mapEvent({ id: 't1', type: 'agent.thinking', processed_at: 'x' } as never, state, opts)[0]).toMatchObject({
      event: { type: 'agent.message.completed', data: { messageId: 't1:0', content: [{ type: 'thinking', thinking: 'deep' }] } },
    })
  })

  it('turns cumulative session cost into per-request cost deltas', () => {
    const state = newMappingState({ lastCostCents: 100 })
    const usage = (amount: string, currency = 'USD') => map({ id: 'u', type: 'session.usage', usage: { list_cost: { amount, currency } } }, state)
    expect(usage('150')).toEqual([{ kind: 'usage', usage: { costUsd: 0.5 } }])
    expect(usage('150')).toEqual([])
    expect(usage('120')).toEqual([])
    expect(usage('900', 'EUR')).toEqual([])
    expect(usage('175')).toEqual([{ kind: 'usage', usage: { costUsd: 0.25 } }])
  })

  it('accumulates thinking deltas into the completed thinking event', () => {
    const state = newMappingState()
    map({ type: 'event_start', event: { id: 't1', type: 'agent.thinking' } }, state)
    expect(map({ type: 'event_delta', event_id: 't1', delta: { type: 'content_delta', content: { type: 'text', text: 'hmm' } } }, state)[1]).toMatchObject({
      event: { type: 'agent.thinking.delta', data: { text: 'hmm' } },
    })
    expect(map({ id: 't1', type: 'agent.thinking', processed_at: 'x' }, state)[0]).toMatchObject({
      event: { type: 'agent.message.completed', data: { messageId: 't1:0', content: [{ type: 'thinking', thinking: 'hmm' }] } },
    })
  })

  it('maps tool use, permissions and custom tools', () => {
    expect(map({ id: 'tu', type: 'agent.tool_use', name: 'bash', input: { c: 1 }, evaluated_permission: 'allow', processed_at: 'x' })).toHaveLength(1)
    const ask = map({ id: 'tu', type: 'agent.mcp_tool_use', name: 'fetch', mcp_server_name: 'web', input: {}, evaluated_permission: 'ask', processed_at: 'x' })
    expect(ask).toEqual([
      { kind: 'event', event: { type: 'tool.call', data: { toolUseId: 'tu', name: 'fetch', input: {}, kind: 'mcp', mcpServer: 'web' }, sourceId: 'tu' } },
      { kind: 'approval_request', requestId: 'tu', toolUseId: 'tu', name: 'fetch', input: {} },
    ])
    const custom = map({ id: 'c1', type: 'agent.custom_tool_use', name: 'lookup', input: { q: 1 }, processed_at: 'x' })
    expect(custom[1]).toEqual({ kind: 'tool_request', requestId: 'c1', toolUseId: 'c1', name: 'lookup', input: { q: 1 } })
    expect(map({ id: 'r', type: 'agent.tool_result', tool_use_id: 'tu', content: [], is_error: true, processed_at: 'x' })[0]).toMatchObject({
      event: { type: 'tool.result', data: { toolUseId: 'tu', isError: true } },
    })
  })

  it('maps session status, errors, usage and unknown events', () => {
    expect(map({ id: 'i', type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['x'] }, processed_at: 'x' })).toEqual([
      { kind: 'event', event: { type: 'session.status', data: { status: 'requires_action' }, sourceId: 'i' } },
    ])
    // The runtime inserts `session.status: idle` before runtime.turn.completed itself.
    expect(map({ id: 'i', type: 'session.status_idle', stop_reason: { type: 'retries_exhausted' }, processed_at: 'x' })).toEqual([
      { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'error' }, sourceId: 'i' } },
    ])
    expect(map({ id: 'e', type: 'session.error', error: { type: 'model_overloaded_error', message: 'busy', retry_status: { type: 'retrying' } } })[0]).toMatchObject({
      event: { type: 'session.error', data: { message: 'busy', code: 'model_overloaded_error', retryable: true } },
    })
    expect(
      map({ id: 'u', type: 'span.model_request_end', model_usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } })[0],
    ).toEqual({ kind: 'usage', usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } })
    expect(map({ id: 'u', type: 'user.message', content: [] })).toEqual([])
    expect(map({ id: 'w', type: 'workflow_run.created' })[0]).toMatchObject({ event: { type: 'provider.custom', data: { name: 'workflow_run.created' } } })
  })
})

describe('ManagedAgentsProvider', () => {
  const ctx = (signal: AbortSignal, cursor: unknown = null) => ({
    sessionId: 's1',
    providerSessionId: 'sesn_1',
    config: { agent: 'agent_1', environmentId: 'env_1' } as ManagedAgentsSessionConfig,
    metadata: {},
    tools: [],
    cursor,
    signal,
    transcripts: new MemoryStore(),
  })

  async function take(iter: AsyncIterator<ProviderOutput>, n: number) {
    const out: ProviderOutput[] = []
    while (out.length < n) {
      const { value, done } = await iter.next()
      if (done) break
      out.push(value)
    }
    return out
  }

  it('creates sessions with the runtime session id in metadata', async () => {
    const sessions = new MockSessions()
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions) })
    const created = await provider.createSession({
      sessionId: 'rt_1',
      config: { agent: 'agent_1', environmentId: 'env_1', params: { title: 'T', metadata: { team: 'x' } } },
      metadata: {},
    })
    expect(created.providerSessionId).toBe('sesn_1')
    expect(sessions.created[0]).toEqual({ title: 'T', agent: 'agent_1', environment_id: 'env_1', metadata: { team: 'x', agent_runtime_session_id: 'rt_1' } })
  })

  it('catches up from history, dedupes against the live stream, and tracks the cursor', async () => {
    const sessions = new MockSessions()
    const before = ev('session.status_running')
    sessions.history.push(before)
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions), includeRaw: false })
    const abort = new AbortController()
    const iter = provider.connect(ctx(abort.signal))[Symbol.asyncIterator]()

    const first = await take(iter, 3)
    expect(first.map((o) => o.kind)).toEqual(['event', 'cursor', 'ready'])
    // An event already delivered via history shows up again on the live stream: ignored.
    sessions.streams[0]?.push(before)
    const msg = ev('agent.message', { content: [{ type: 'text', text: 'yo' }] })
    sessions.push(msg)
    const next = await take(iter, 2)
    expect(next[0]).toMatchObject({ kind: 'event', event: { type: 'agent.message.completed', sourceId: `${msg.id}:0` } })
    expect(next[1]).toEqual({ kind: 'cursor', cursor: { lastEventId: msg.id, processedAt: msg.processed_at, costCents: 0 } })
    abort.abort()
  })

  it('reconnects after a stream failure and lists since the cursor', async () => {
    const sessions = new MockSessions()
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions), reconnect: { baseMs: 1, maxMs: 5 }, catchUpMarginMs: 1000 })
    const abort = new AbortController()
    const cursor = { lastEventId: 'sevt_x', processedAt: '2026-01-01T00:00:10.000Z' }
    const iter = provider.connect(ctx(abort.signal, cursor))[Symbol.asyncIterator]()
    await take(iter, 1) // ready
    expect(sessions.listCalls[0]).toEqual({ order: 'asc', 'created_at[gte]': '2026-01-01T00:00:09.000Z' })
    sessions.streams[0]?.fail(new Error('socket hang up'))
    const missed = ev('agent.message', { content: [{ type: 'text', text: 'missed' }], processed_at: '2026-01-01T00:01:00.000Z' })
    sessions.history.push(missed)
    const out = await take(iter, 3)
    expect(out.map((o) => o.kind)).toEqual(['event', 'cursor', 'ready'])
    expect(sessions.streams).toHaveLength(2)
    abort.abort()
  })

  it('does not count usage of events an earlier connection already handled', async () => {
    const sessions = new MockSessions()
    const old = ev('span.model_request_end', { model_usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    const fresh = ev('span.model_request_end', { model_usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    sessions.history.push(old, fresh)
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions) })
    const abort = new AbortController()
    const iter = provider.connect(ctx(abort.signal, { lastEventId: old.id, processedAt: old.processed_at, costCents: 0 }))[Symbol.asyncIterator]()
    const out = await take(iter, 4)
    expect(out.filter((o) => o.kind === 'usage')).toEqual([{ kind: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }])
    abort.abort()
  })

  it('ends with a terminated status when the session is gone', async () => {
    const sessions = new MockSessions()
    sessions.streamError = Object.assign(new Error('not found'), { status: 404 })
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions) })
    const out = await take(provider.connect(ctx(new AbortController().signal))[Symbol.asyncIterator](), 5)
    expect(out).toEqual([{ kind: 'event', event: { type: 'session.status', data: { status: 'terminated', reason: 'not_found' } } }])
  })

  it('sends user events in the Managed Agents format', async () => {
    const sessions = new MockSessions()
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions) })
    const c = ctx(new AbortController().signal)
    await provider.sendMessage(c, [{ type: 'text', text: 'hi' }])
    await provider.interrupt(c)
    await provider.submitToolResult(c, 'ctu_1', { content: [{ type: 'text', text: 'r' }], isError: true })
    await provider.submitApproval(c, 'tu_1', { behavior: 'deny', message: 'nope' })
    await provider.submitApproval(c, 'tu_2', { behavior: 'allow', message: 'ignored' })
    await expect(provider.submitApproval(c, 'tu_3', { behavior: 'allow', updatedInput: { x: 1 } })).rejects.toThrow(/cannot change tool input/)
    expect(provider.capabilities).toEqual({ approvalUpdatedInput: false, thinkingContent: 'best_effort', turnCost: true, systemMessages: 'native' })
    await provider.terminate(c)
    expect(sessions.sent.map((s) => s.events[0])).toEqual([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      { type: 'user.interrupt' },
      { type: 'user.custom_tool_result', custom_tool_use_id: 'ctu_1', content: [{ type: 'text', text: 'r' }], is_error: true },
      { type: 'user.tool_confirmation', tool_use_id: 'tu_1', result: 'deny', deny_message: 'nope' },
      { type: 'user.tool_confirmation', tool_use_id: 'tu_2', result: 'allow' },
    ])
    expect(sessions.archived).toEqual(['sesn_1'])
    expect(sessions.sent[0]?.events).toHaveLength(1)
  })

  it('sends system context as a system.message right after the user.message', async () => {
    const sessions = new MockSessions()
    const provider = new ManagedAgentsProvider({ client: mockClient(sessions) })
    await provider.sendMessage(ctx(new AbortController().signal), [{ type: 'text', text: 'hi' }], { system: [{ type: 'text', text: 'Be brief' }] })
    expect(sessions.sent[0]?.events).toEqual([
      { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      { type: 'system.message', content: [{ type: 'text', text: 'Be brief' }] },
    ])
  })

  it('runs end-to-end through the runtime with a custom tool', async () => {
    const sessions = new MockSessions()
    sessions.onSend = (events) => {
      const e = events[0] as { type: string; custom_tool_use_id?: string }
      setTimeout(() => {
        if (e.type === 'user.message') {
          sessions.push(ev('session.status_running'))
          sessions.push({ type: 'event_start', event: { id: 'msg_a', type: 'agent.message' } })
          sessions.push({ type: 'event_delta', event_id: 'msg_a', delta: { type: 'content_delta', content: { type: 'text', text: 'Look' } } })
          sessions.push(ev('agent.message', { id: 'msg_a', content: [{ type: 'text', text: 'Looking up' }] }))
          sessions.push(ev('agent.custom_tool_use', { name: 'lookup', input: { q: 'x' } }))
          sessions.push(ev('session.status_idle', { stop_reason: { type: 'requires_action', event_ids: [] } }))
        } else if (e.type === 'user.custom_tool_result') {
          sessions.push(ev('session.status_running'))
          sessions.push(ev('agent.message', { content: [{ type: 'text', text: 'Found it' }] }))
          sessions.push(ev('session.status_idle', { stop_reason: { type: 'end_turn' } }))
        }
      }, 5)
    }
    const runtime = createRuntime({
      store: new MemoryStore(),
      bus: new MemoryBus(),
      providers: { ma: new ManagedAgentsProvider({ client: mockClient(sessions) }) },
      tools: { lookup: { description: 'Lookup', inputSchema: { type: 'object' }, handler: async (i: { q: string }) => `result for ${i.q}` } },
      pollIntervalMs: 50,
    })
    runtimes.push(runtime)
    const session = await runtime.createSession<ManagedAgentsSessionConfig>({ provider: 'ma', config: { agent: 'agent_1', environmentId: 'env_1' } })
    const seen: RuntimeEvent[] = []
    const done = (async () => {
      for await (const e of session.events()) {
        seen.push(e)
        if (e.type === 'runtime.turn.completed') return
      }
    })()
    await session.send('find x')
    await done
    const types = seen.map((e) => e.type)
    expect(types.slice(0, 7)).toEqual(['session.created', 'user.message', 'session.status', 'agent.message.start', 'agent.text.delta', 'agent.message.completed', 'tool.call'])
    // The tool runs concurrently with the requires_action idle status, so their order may vary.
    expect(types.slice(7, 9).sort()).toEqual(['session.status', 'tool.result'])
    expect(types.slice(9)).toEqual(['session.status', 'agent.message.completed', 'session.status', 'runtime.turn.completed'])
    const toolResult = sessions.sent.find((s) => (s.events[0] as { type: string }).type === 'user.custom_tool_result')
    expect(toolResult?.events[0]).toMatchObject({ content: [{ type: 'text', text: 'result for x' }] })
    expect((await session.info()).status).toBe('idle')
  })
})
