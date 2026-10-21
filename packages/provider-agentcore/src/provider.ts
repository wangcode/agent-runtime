import WebSocket from 'ws'
import {
  type ApprovalDecision,
  AsyncQueue,
  type ConnectContext,
  type ContentBlock,
  type Logger,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderOutput,
  type ToolResult,
  type TranscriptStore,
  backoff,
  deferred,
  errorMessage,
  newId,
  noopLogger,
  sleep,
} from '@agent-runtime/core'
import {
  type ClientCommand,
  type ClientMessage,
  type ContainerMessage,
  FrameDecoder,
  PROTOCOL_VERSION,
  type StoreOp,
  encodeFrames,
  runtimeSessionIdFor,
} from '@agent-runtime/protocol'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'
import { type AgentCoreEndpoint, SESSION_ID_HEADER, agentCoreWsTarget, signWebSocketRequest } from './sigv4.js'

/** Per-session config, forwarded to the container driver in `hello.config`. */
export type AgentCoreSessionConfig = Record<string, unknown>

export interface AgentCoreCursor {
  bootId: string
  seq: number
}

export interface AgentCoreOptions {
  /** Real AgentCore endpoint. Either this or `connectWebSocket` is required. */
  endpoint?: AgentCoreEndpoint
  /** AWS credentials; defaults to the Node default provider chain. */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider
  /** Use an OAuth bearer token instead of SigV4 (runtimes with a JWT authorizer). */
  bearerToken?: () => string | Promise<string>
  /** Custom socket factory, e.g. to reach a local container in development or tests. */
  connectWebSocket?: (input: { runtimeSessionId: string; sessionId: string }) => WebSocket | Promise<WebSocket>
  /** Reconnect before AgentCore's 60-minute stream limit. Default 55 minutes. */
  maxConnectionMs?: number
  /** How long commands wait for a live connection and an ack. Default 30s. */
  commandTimeoutMs?: number
  /** Optionally stop the microVM on terminate (e.g. call StopRuntimeSession). */
  stopRuntimeSession?: (runtimeSessionId: string) => Promise<void>
  reconnect?: { baseMs?: number; maxMs?: number }
  logger?: Logger
}

interface Connection {
  ws: WebSocket
  ready: ReturnType<typeof deferred<void>>
  acks: Map<string, { resolve: () => void; reject: (err: Error) => void }>
}

/**
 * Bedrock AgentCore provider: talks the agent-runtime WebSocket protocol to a container running
 * `@agent-runtime/agentcore-runtime`. The container keeps a replay log per boot, so reconnects
 * resume by `(bootId, seq)`; a changed boot id means a fresh microVM and outstanding requests are
 * reset. Transcript store requests from the container are served from the runtime's Store.
 */
export class AgentCoreProvider implements ProviderAdapter<AgentCoreSessionConfig> {
  readonly name = 'agentcore'
  private readonly connections = new Map<string, Connection>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private readonly logger: Logger

  constructor(private readonly opts: AgentCoreOptions) {
    if (!opts.endpoint && !opts.connectWebSocket) throw new Error('AgentCoreProvider needs `endpoint` or `connectWebSocket`')
    this.logger = opts.logger ?? noopLogger
  }

  async createSession(input: { sessionId: string }) {
    // The microVM is created lazily by the first connection with this runtime session id.
    return { providerSessionId: runtimeSessionIdFor(input.sessionId), cursor: null }
  }

  async *connect(ctx: ConnectContext<AgentCoreSessionConfig>): AsyncGenerator<ProviderOutput> {
    let cursor = (ctx.cursor as AgentCoreCursor | null) ?? null
    let attempt = 0
    while (!ctx.signal.aborted) {
      const out = new AsyncQueue<ProviderOutput>()
      let ws: WebSocket | undefined
      try {
        ws = await this.open(ctx)
        const conn: Connection = { ws, ready: deferred(), acks: new Map() }
        this.wire(ctx, conn, out, () => cursor, (c) => (cursor = c))
        const lifetime = setTimeout(() => ws?.close(1000, 'rotating before max connection duration'), this.opts.maxConnectionMs ?? 55 * 60_000)
        const onAbort = () => ws?.close(1000, 'session released')
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        try {
          for await (const item of out) {
            if (item.kind === 'ready') attempt = 0
            yield item
          }
        } finally {
          clearTimeout(lifetime)
          ctx.signal.removeEventListener('abort', onAbort)
        }
      } catch (err) {
        if (ctx.signal.aborted) return
        this.logger.warn('agentcore connection failed', { sessionId: ctx.sessionId, error: errorMessage(err), attempt })
      } finally {
        if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate()
      }
      if (ctx.signal.aborted) return
      attempt += 1
      await sleep(backoff(attempt, this.opts.reconnect?.baseMs ?? 500, this.opts.reconnect?.maxMs ?? 30_000), ctx.signal)
    }
  }

  async sendMessage(ctx: ProviderContext<AgentCoreSessionConfig>, content: ContentBlock[]) {
    await this.command(ctx, { type: 'user_message', id: newId(), content })
  }

  async interrupt(ctx: ProviderContext<AgentCoreSessionConfig>) {
    await this.command(ctx, { type: 'interrupt', id: newId() })
  }

  async submitToolResult(ctx: ProviderContext<AgentCoreSessionConfig>, requestId: string, result: ToolResult) {
    await this.command(ctx, { type: 'tool_result', id: newId(), requestId, result })
  }

  async submitApproval(ctx: ProviderContext<AgentCoreSessionConfig>, requestId: string, decision: ApprovalDecision) {
    await this.command(ctx, { type: 'approval_decision', id: newId(), requestId, decision })
  }

  async terminate(ctx: ProviderContext<AgentCoreSessionConfig>) {
    try {
      await this.command(ctx, { type: 'terminate', id: newId() })
    } finally {
      await this.opts.stopRuntimeSession?.(ctx.providerSessionId)
    }
  }

  private async open(ctx: ConnectContext<AgentCoreSessionConfig>): Promise<WebSocket> {
    let ws: WebSocket
    if (this.opts.connectWebSocket) {
      ws = await this.opts.connectWebSocket({ runtimeSessionId: ctx.providerSessionId, sessionId: ctx.sessionId })
    } else {
      const ep = this.opts.endpoint as AgentCoreEndpoint
      if (this.opts.bearerToken) {
        const { hostname, path, query } = agentCoreWsTarget(ep)
        const qs = new URLSearchParams(query).toString()
        ws = new WebSocket(`wss://${hostname}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${await this.opts.bearerToken()}`, [SESSION_ID_HEADER]: ctx.providerSessionId } })
      } else {
        const credentials = this.opts.credentials ?? (await import('@aws-sdk/credential-provider-node')).defaultProvider()
        const { url, headers } = await signWebSocketRequest(ep, ctx.providerSessionId, credentials)
        ws = new WebSocket(url, { headers })
      }
    }
    if (ws.readyState === WebSocket.OPEN) return ws
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`WebSocket upgrade failed with HTTP ${res.statusCode}`)))
    })
    return ws
  }

  private wire(
    ctx: ConnectContext<AgentCoreSessionConfig>,
    conn: Connection,
    out: AsyncQueue<ProviderOutput>,
    getCursor: () => AgentCoreCursor | null,
    setCursor: (c: AgentCoreCursor) => void,
  ) {
    const { ws } = conn
    const decoder = new FrameDecoder<ContainerMessage>()
    const send = (msg: ClientMessage) => {
      for (const frame of encodeFrames(msg)) ws.send(frame)
    }
    let bootId: string | undefined

    ws.on('message', (data) => {
      let msg: ContainerMessage | null
      try {
        msg = decoder.decode(data.toString())
      } catch (err) {
        this.logger.warn('bad frame from container', { error: errorMessage(err) })
        return
      }
      if (!msg) return
      switch (msg.type) {
        case 'welcome': {
          bootId = msg.bootId
          const prev = getCursor()
          if (prev && prev.bootId !== msg.bootId) {
            // A different microVM: anything it was waiting on is gone.
            out.push({ kind: 'actions_reset', reason: 'agent runtime restarted' })
          }
          const cursor = prev && prev.bootId === msg.bootId ? prev : { bootId: msg.bootId, seq: 0 }
          setCursor(cursor)
          out.push({ kind: 'cursor', cursor })
          this.connections.set(ctx.sessionId, conn)
          conn.ready.resolve()
          for (const w of this.waiters.get(ctx.sessionId) ?? []) w()
          this.waiters.delete(ctx.sessionId)
          out.push({ kind: 'ready' })
          break
        }
        case 'event':
          if (msg.seq === undefined) {
            out.push({ kind: 'event', event: msg.event })
          } else {
            const cursor = { bootId: bootId as string, seq: msg.seq }
            out.push({ kind: 'event', event: { ...msg.event, sourceId: `${cursor.bootId}:${cursor.seq}` } })
            setCursor(cursor)
            out.push({ kind: 'cursor', cursor })
          }
          break
        case 'tool_request':
          out.push({ kind: 'tool_request', requestId: msg.requestId, toolUseId: msg.toolUseId, name: msg.name, input: msg.input })
          break
        case 'approval_request':
          out.push({ kind: 'approval_request', requestId: msg.requestId, toolUseId: msg.toolUseId, name: msg.name, input: msg.input })
          break
        case 'store_request':
          void this.serveStore(ctx.transcripts, msg).then((res) => send({ type: 'store_response', requestId: msg.requestId, ...res }))
          break
        case 'ack': {
          const pending = conn.acks.get(msg.id)
          conn.acks.delete(msg.id)
          if (msg.ok) pending?.resolve()
          else pending?.reject(new Error(msg.error ?? 'command rejected by agent runtime'))
          break
        }
        case 'error':
          this.logger.warn('agent runtime reported an error', { sessionId: ctx.sessionId, message: msg.message })
          break
        default: {
          // Compile-time: every protocol message must be handled. Runtime: a newer container may send more.
          const unhandled: never = msg
          this.logger.warn('unknown message from agent runtime', { sessionId: ctx.sessionId, type: (unhandled as { type?: string }).type })
        }
      }
    })

    ws.on('close', (code, reason) => {
      if (this.connections.get(ctx.sessionId) === conn) this.connections.delete(ctx.sessionId)
      for (const p of conn.acks.values()) p.reject(new Error(`connection closed (${code} ${reason.toString()})`))
      conn.acks.clear()
      out.close()
    })
    ws.on('error', (err) => this.logger.warn('agentcore socket error', { sessionId: ctx.sessionId, error: errorMessage(err) }))

    const cursor = getCursor()
    send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      sessionId: ctx.sessionId,
      ...(cursor ? { bootId: cursor.bootId, afterSeq: cursor.seq } : {}),
      config: ctx.config ?? {},
      tools: ctx.tools,
    })
  }

  private async serveStore(store: TranscriptStore, req: StoreOp): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      switch (req.op) {
        case 'append':
          await store.appendTranscript(req.key, req.entries)
          return { ok: true }
        case 'load':
          return { ok: true, data: await store.loadTranscript(req.key) }
        case 'listSubkeys':
          return { ok: true, data: await store.listTranscriptSubkeys(req.key) }
        case 'delete':
          await store.deleteTranscript(req.key)
          return { ok: true }
        case 'has':
          return { ok: true, data: await store.hasTranscript(req.sessionId) }
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  /** Send a command over the live connection (waiting for one if needed) and await its ack. */
  private async command(ctx: ProviderContext<AgentCoreSessionConfig>, cmd: ClientCommand): Promise<void> {
    const timeoutMs = this.opts.commandTimeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    let conn = this.connections.get(ctx.sessionId)
    while (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`No live connection to agent runtime for session ${ctx.sessionId}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 1000))
        const list = this.waiters.get(ctx.sessionId) ?? []
        list.push(() => {
          clearTimeout(timer)
          resolve()
        })
        this.waiters.set(ctx.sessionId, list)
      })
      conn = this.connections.get(ctx.sessionId)
    }
    const live = conn
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        live.acks.delete(cmd.id)
        reject(new Error(`Timed out waiting for ${cmd.type} ack`))
      }, Math.max(1, deadline - Date.now()))
      live.acks.set(cmd.id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      for (const frame of encodeFrames(cmd)) live.ws.send(frame)
    })
  }
}

export const agentCore = (options: AgentCoreOptions): AgentCoreProvider => new AgentCoreProvider(options)
