import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { MemoryBus, MemoryStore, type Runtime, type RuntimeEvent, type RuntimeOptions, createRuntime } from '@agent-runtime/core'
import { type AgentCoreServer, type AgentDriver, type DriverSession, startAgentCoreServer } from '@agent-runtime/agentcore-runtime'
import { ClaudeAgentSdkDriver, type ClaudeAgentSdkModule, sdkSessionIdFor } from '@agent-runtime/agentcore-runtime/claude-agent-sdk'
import { AgentCoreProvider, signWebSocketRequest } from '@agent-runtime/provider-agentcore'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {})
})

/** A driver whose turns are scripted by the test. */
class ScriptedDriver implements AgentDriver {
  sessions: DriverSession[] = []
  turn: (s: DriverSession, text: string) => Promise<void> = async (s, text) => {
    s.emit({ type: 'agent.message.completed', data: { messageId: 'm', content: [{ type: 'text', text: `echo ${text}` }] } })
    s.emit({ type: 'session.status', data: { status: 'idle' } })
    s.emit({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } })
    s.setBusy(false)
  }
  start(session: DriverSession) {
    this.sessions.push(session)
    return {
      sendMessage: async (content: Array<{ type: string; text?: string }>) => {
        session.setBusy(true)
        session.emit({ type: 'session.status', data: { status: 'running' } })
        void this.turn(session, content[0]?.text ?? '')
      },
      interrupt: async () => {},
      close: async () => {},
    }
  }
}

async function startServer(driver: AgentDriver, port = 0) {
  const server = await startAgentCoreServer({ driver, port, host: '127.0.0.1' })
  cleanups.push(() => server.close())
  return server
}

function makeRuntime(server: { port: number }, overrides: Partial<RuntimeOptions> = {}, store = new MemoryStore()) {
  const provider = new AgentCoreProvider({
    connectWebSocket: () => new WebSocket(`ws://127.0.0.1:${server.port}/ws`),
    reconnect: { baseMs: 10, maxMs: 50 },
    commandTimeoutMs: 5000,
  })
  const runtime = createRuntime({ store, bus: new MemoryBus(), providers: { ac: provider }, pollIntervalMs: 50, toolCallWaitMs: 20, ...overrides })
  cleanups.push(() => runtime.close())
  return { runtime, store, provider }
}

async function until(session: { events(o?: object): AsyncIterable<RuntimeEvent> }, pred: (e: RuntimeEvent) => boolean, opts: object = {}) {
  const seen: RuntimeEvent[] = []
  const result = await Promise.race([
    (async () => {
      for await (const e of session.events(opts)) {
        seen.push(e)
        if (pred(e)) return seen
      }
      return seen
    })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout; saw ${seen.map((e) => e.type).join(',')}`)), 5000)),
  ])
  return result
}

const waitFor = async (fn: () => boolean, timeoutMs = 5000) => {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('AgentCore provider <-> container runtime', () => {
  it('runs turns over the WebSocket protocol', async () => {
    const driver = new ScriptedDriver()
    const server = await startServer(driver)
    const { runtime } = makeRuntime(server)
    const session = await runtime.createSession({ provider: 'ac', config: { options: { model: 'x' } } })
    const done = until(session, (e) => e.type === 'runtime.turn.completed')
    await session.send('hello')
    const events = await done
    expect(events.map((e) => e.type)).toEqual(['session.created', 'user.message', 'session.status', 'agent.message.completed', 'session.status', 'runtime.turn.completed'])
    expect(events.find((e) => e.type === 'agent.message.completed')).toMatchObject({ data: { content: [{ text: 'echo hello' }] } })
    expect(driver.sessions[0]?.config).toEqual({ options: { model: 'x' } })
    let cursor: unknown
    await waitFor(() => {
      void session.info().then((i) => (cursor = i.providerCursor))
      return (cursor as { seq?: number } | undefined)?.seq === 4
    })
    expect(cursor).toEqual({ bootId: server.bootId, seq: 4 })
  })

  it('round-trips custom tools and approvals to the caller', async () => {
    const driver = new ScriptedDriver()
    driver.turn = async (s) => {
      const tool = await s.requestTool({ toolUseId: 'tu1', name: 'lookup', input: { q: 'k' } })
      const approval = await s.requestApproval({ toolUseId: 'tu2', name: 'Bash', input: { command: 'rm -rf /' } })
      s.emit({ type: 'agent.message.completed', data: { messageId: 'm', content: [{ type: 'text', text: `${JSON.stringify(tool.content)} ${approval.behavior} ${approval.message}` }] } })
      s.emit({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } })
      s.setBusy(false)
    }
    const server = await startServer(driver)
    const { runtime } = makeRuntime(server, {
      tools: { lookup: { description: 'Lookup', inputSchema: { type: 'object' }, handler: (i: { q: string }) => `value-of-${i.q}` } },
      approvals: { policy: (req) => (req.name === 'Bash' ? { decision: 'deny', message: 'too dangerous' } : 'ask') },
    })
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    const done = until(session, (e) => e.type === 'runtime.turn.completed')
    await session.send('go')
    const events = await done
    expect(driver.sessions[0]?.tools).toEqual([{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }])
    const final = events.find((e) => e.type === 'agent.message.completed')
    expect(final?.type === 'agent.message.completed' && final.data.content[0]).toMatchObject({ text: '[{"type":"text","text":"value-of-k"}] deny too dangerous' })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['tool.result', 'approval.resolved']))
  })

  it('survives a dropped socket: replays missed events and delivers decisions after reconnect', async () => {
    const driver = new ScriptedDriver()
    let release!: () => void
    driver.turn = async (s) => {
      const decision = await s.requestApproval({ toolUseId: 'tu', name: 'Write', input: {} })
      // Emitted while the client may be disconnected; must be replayed.
      s.emit({ type: 'agent.message.completed', data: { messageId: 'm', content: [{ type: 'text', text: decision.behavior }] } })
      await new Promise<void>((r) => (release = r))
      s.emit({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } })
      s.setBusy(false)
    }
    const server = await startServer(driver)
    const { runtime } = makeRuntime(server)
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    await session.send('go')
    const requested = await until(session, (e) => e.type === 'approval.requested')
    const approvalId = (requested.at(-1) as RuntimeEvent<'approval.requested'>).data.approvalId

    for (const ws of getSockets(server)) ws.terminate()
    await session.resolveApproval(approvalId, 'allow')
    await waitFor(() => typeof release === 'function')
    for (const ws of getSockets(server)) ws.terminate()
    release()
    const events = await until(session, (e) => e.type === 'runtime.turn.completed')
    expect(events.filter((e) => e.type === 'agent.message.completed')).toHaveLength(1)
    expect(events.find((e) => e.type === 'agent.message.completed')).toMatchObject({ data: { content: [{ text: 'allow' }] } })
    expect(events.filter((e) => e.type === 'approval.requested')).toHaveLength(1)
  })

  it('resets outstanding requests when the microVM is replaced', async () => {
    const driver = new ScriptedDriver()
    driver.turn = async (s) => {
      await s.requestApproval({ toolUseId: 'tu', name: 'Write', input: {} }).catch(() => {})
    }
    const server = await startServer(driver)
    const port = server.port
    const { runtime } = makeRuntime(server)
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    await session.send('go')
    await until(session, (e) => e.type === 'approval.requested')
    const firstBoot = server.bootId

    await server.close()
    cleanups.pop()
    const replacement = await startServer(new ScriptedDriver(), port)
    expect(replacement.bootId).not.toBe(firstBoot)
    const events = await until(session, (e) => e.type === 'approval.resolved')
    expect(events.at(-1)).toMatchObject({ data: { decision: 'deny', by: 'system' } })
    await waitFor(() => replacement.sessions.has(session.id))
    expect(await session.pendingApprovals()).toEqual([])
  })

  it('reports HealthyBusy only while work is in flight and only bumps the timestamp on transitions', async () => {
    const driver = new ScriptedDriver()
    let finish!: () => void
    driver.turn = (s) =>
      new Promise<void>((resolve) => {
        finish = () => {
          s.emit({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } })
          s.setBusy(false)
          resolve()
        }
      })
    const server = await startServer(driver)
    const ping = async () => (await fetch(`http://127.0.0.1:${server.port}/ping`)).json() as Promise<{ status: string; time_of_last_update: number }>
    expect((await ping()).status).toBe('Healthy')
    const { runtime } = makeRuntime(server)
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    await session.send('go')
    const busy = await ping()
    expect(busy.status).toBe('HealthyBusy')
    expect((await ping()).time_of_last_update).toBe(busy.time_of_last_update)
    finish()
    await until(session, (e) => e.type === 'runtime.turn.completed')
    expect((await ping()).status).toBe('Healthy')
  })

  it('serves the driver session store from the runtime Store', async () => {
    const driver = new ScriptedDriver()
    driver.turn = async (s) => {
      const key = { projectKey: 'p', sessionId: 'sdk-1' }
      await s.sessionStore.append(key, [{ type: 'user', n: 1 }])
      const loaded = await s.sessionStore.load(key)
      const has = await s.sessionStore.has('sdk-1')
      s.emit({ type: 'provider.custom', data: { name: 'store', payload: { loaded, has } } })
      s.emit({ type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } })
      s.setBusy(false)
    }
    const server = await startServer(driver)
    const { runtime, store } = makeRuntime(server)
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    await session.send('go')
    const events = await until(session, (e) => e.type === 'runtime.turn.completed')
    expect(events.find((e) => e.type === 'provider.custom')).toMatchObject({ data: { payload: { loaded: [{ type: 'user', n: 1 }], has: true } } })
    expect(await store.loadTranscript({ projectKey: 'p', sessionId: 'sdk-1' })).toEqual([{ type: 'user', n: 1 }])
  })

  it('streams a turn over the /invocations HTTP fallback', async () => {
    const server = await startServer(new ScriptedDriver())
    const res = await fetch(`http://127.0.0.1:${server.port}/invocations`, { method: 'POST', body: JSON.stringify({ sessionId: 'http-1', prompt: 'hi' }) })
    const text = await res.text()
    expect(text).toContain('event: agent.message.completed')
    expect(text).toContain('echo hi')
    expect(text.trim().endsWith('"stopReason":"end_turn"}}')).toBe(true)
  })
})

function getSockets(server: AgentCoreServer): WebSocket[] {
  // The WebSocketServer is internal; reach the live sockets via the HTTP server's connections.
  const sockets: WebSocket[] = []
  for (const s of server.sessions.values()) {
    const ws = (s as unknown as { socket?: WebSocket }).socket
    if (ws) sockets.push(ws)
  }
  return sockets
}

describe('Claude Agent SDK driver', () => {
  function mockSdk() {
    const seen: { options?: Record<string, any>; prompts: unknown[] } = { prompts: [] }
    const sdk = {
      tool: (name: string, description: string, inputSchema: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) => ({ name, description, inputSchema, handler }),
      createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({ type: 'sdk', name: o.name, instance: o }),
      query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
        seen.options = options
        const signal = new AbortController().signal
        async function* run() {
          yield { type: 'system', subtype: 'init', uuid: 'u-init', session_id: options.sessionId }
          for await (const msg of prompt) {
            seen.prompts.push(msg)
            yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }
            yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }
            yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } }
            yield { type: 'assistant', uuid: 'u1', message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello' }] } }
            const toolName = 'mcp__runtime__lookup'
            yield { type: 'assistant', uuid: 'u2', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input: { q: 'x' } }] } }
            for (const m of options.hooks.PreToolUse) {
              if (new RegExp(m.matcher).test(toolName)) {
                for (const h of m.hooks) await h({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { q: 'x' }, tool_use_id: 'toolu_1' }, 'toolu_1', { signal })
              }
            }
            const lookup = options.mcpServers.runtime.instance.tools.find((t: { name: string }) => t.name === 'lookup')
            const r = await lookup.handler({ q: 'x' }, {})
            yield { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: r.content }] } }
            yield { type: 'assistant', uuid: 'u4', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'ls' } }] } }
            const perm = await options.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 'toolu_2' })
            yield {
              type: 'user',
              uuid: 'u5',
              message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: perm.behavior === 'allow' ? 'file.txt' : perm.message, is_error: perm.behavior !== 'allow' }] },
            }
            await options.sessionStore.append({ projectKey: 'proj', sessionId: options.sessionId ?? options.resume }, [{ type: 'user', uuid: 't1' }])
            yield { type: 'result', subtype: 'success', uuid: 'u6', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }
          }
        }
        const q = run() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> }
        q.interrupt = async () => {}
        return q
      },
    }
    return { sdk: sdk as unknown as ClaudeAgentSdkModule, seen }
  }

  it('maps SDK messages, proxies custom tools and permissions, and persists the transcript', async () => {
    const { sdk, seen } = mockSdk()
    const server = await startServer(new ClaudeAgentSdkDriver({ sdk, options: { model: 'claude-sonnet-5-5', allowedTools: ['Read'] } }))
    const { runtime, store } = makeRuntime(server, {
      tools: {
        lookup: {
          description: 'Lookup a key',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          handler: (i: { q: string }, ctx) => `found ${i.q} for ${ctx.toolUseId}`,
        },
      },
      approvals: { policy: () => 'ask' },
    })
    const session = await runtime.createSession({ provider: 'ac', config: { options: { maxTurns: 3 } } })
    const watcher = (async () => {
      for await (const e of session.events()) {
        if (e.type === 'approval.requested') await session.resolveApproval(e.data.approvalId, 'allow')
        if (e.type === 'runtime.turn.completed') return
      }
    })()
    await session.send('look it up')
    await watcher
    const events = await until(session, (e) => e.type === 'runtime.turn.completed', { includeDeltas: false })

    const opts = seen.options!
    expect(opts.model).toBe('claude-sonnet-5-5')
    expect(opts.maxTurns).toBe(3)
    expect(opts.includePartialMessages).toBe(true)
    expect(opts.allowedTools).toEqual(['Read', 'mcp__runtime__lookup'])
    expect(opts.sessionId).toBe(sdkSessionIdFor(session.id))
    expect(opts.resume).toBeUndefined()
    expect(Object.keys(opts.mcpServers.runtime.instance.tools[0].inputSchema)).toEqual(['q'])
    expect(seen.prompts[0]).toMatchObject({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look it up' }] } })

    expect(events.map((e) => e.type)).toEqual([
      'session.created',
      'user.message',
      'session.status', // running: emitted by the runtime right after user.message, for every provider
      'provider.custom', // system/init
      'agent.message.completed',
      'tool.call', // custom lookup
      'tool.result', // from the runtime's handler
      'tool.call', // Bash
      'session.status', // requires_action
      'approval.requested',
      'approval.resolved',
      'session.status', // running
      'tool.result', // Bash output
      'session.status', // idle
      'runtime.turn.completed',
    ])
    expect(events.find((e) => e.type === 'tool.call')).toMatchObject({ data: { toolUseId: 'toolu_1', name: 'lookup', kind: 'custom' } })
    expect(events.find((e) => e.type === 'tool.result')).toMatchObject({ data: { toolUseId: 'toolu_1', content: [{ text: 'found x for toolu_1' }] } })
    expect(events.filter((e) => e.type === 'tool.result')[1]).toMatchObject({ data: { toolUseId: 'toolu_2', content: [{ text: 'file.txt' }] } })
    expect(events.at(-1)).toMatchObject({ data: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } } })
    expect(await store.hasTranscript(sdkSessionIdFor(session.id))).toBe(true)
  })

  it('emulates system context as a <system-reminder> block on the user message', async () => {
    const { sdk, seen } = mockSdk()
    const server = await startServer(new ClaudeAgentSdkDriver({ sdk }))
    const { runtime } = makeRuntime(server, { tools: { lookup: { description: 'l', inputSchema: { type: 'object' }, handler: () => 'ok' } }, approvals: { policy: () => 'allow' } })
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    expect((await session.capabilities()).systemMessages).toBe('emulated')
    await session.send('hi', { system: 'Answer in French' })
    const events = await until(session, (e) => e.type === 'runtime.turn.completed', { includeDeltas: false })
    expect(events.find((e) => e.type === 'user.message')?.data).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      system: [{ type: 'text', text: 'Answer in French' }],
    })
    expect(seen.prompts[0]).toMatchObject({
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '<system-reminder>\nAnswer in French\n</system-reminder>' }] },
    })
  })

  it('resumes the SDK session when a transcript already exists', async () => {
    const { sdk, seen } = mockSdk()
    const server = await startServer(new ClaudeAgentSdkDriver({ sdk }))
    const store = new MemoryStore()
    const { runtime } = makeRuntime(server, {}, store)
    const session = await runtime.createSession({ provider: 'ac', config: {} })
    await store.appendTranscript({ projectKey: 'p', sessionId: sdkSessionIdFor(session.id) }, [{ type: 'user' }])
    const done = until(session, (e) => e.type === 'session.status')
    await session.send('hi')
    await done
    await waitFor(() => seen.options !== undefined)
    expect(seen.options?.resume).toBe(sdkSessionIdFor(session.id))
    expect(seen.options?.sessionId).toBeUndefined()
  })
})

describe('SigV4', () => {
  it('signs the WebSocket upgrade for the runtime endpoint', async () => {
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc'
    const { url, headers } = await signWebSocketRequest({ region: 'us-west-2', runtimeArn: arn, qualifier: 'DEFAULT' }, 'agent-runtime-0123456789abcdef0123', {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
    })
    expect(url).toBe(`wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/${encodeURIComponent(arn)}/ws?qualifier=DEFAULT`)
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request/)
    expect(headers.authorization).toContain('x-amzn-bedrock-agentcore-runtime-session-id')
    expect(headers['X-Amzn-Bedrock-AgentCore-Runtime-Session-Id']).toBe('agent-runtime-0123456789abcdef0123')
  })
})
