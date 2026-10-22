import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { type Logger, errorMessage, newId, noopLogger, textContent } from '@agent-runtime/core'
import { type ClientMessage, FrameDecoder, PROTOCOL_VERSION } from '@agent-runtime/protocol'
import type { AgentDriver } from './driver.js'
import { ContainerSession } from './session.js'

export interface AgentCoreServerOptions {
  driver: AgentDriver
  /** Default 8080, as required by AgentCore. */
  port?: number
  host?: string
  /** Replay log size per session. Default 10k events. */
  maxLogEvents?: number
  /** Close a socket that sent no hello within this time. Default 10s. */
  helloTimeoutMs?: number
  logger?: Logger
}

export interface AgentCoreServer {
  readonly server: Server
  readonly bootId: string
  /** The port actually bound (useful with port 0). */
  readonly port: number
  sessions: Map<string, ContainerSession>
  health(): { status: 'Healthy' | 'HealthyBusy'; time_of_last_update: number }
  close(): Promise<void>
}

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'

/**
 * HTTP + WebSocket server implementing the AgentCore Runtime container contract:
 * `GET /ping`, `GET /ws` (the agent-runtime protocol) and `POST /invocations` (a minimal HTTP
 * fallback that runs one turn and streams events as SSE; tools/approvals need a WS client).
 */
export async function startAgentCoreServer(options: AgentCoreServerOptions): Promise<AgentCoreServer> {
  const logger = options.logger ?? noopLogger
  const bootId = newId()
  const sessions = new Map<string, ContainerSession>()
  let status: 'Healthy' | 'HealthyBusy' = 'Healthy'
  let lastUpdate = Math.floor(Date.now() / 1000)

  // Only bump the timestamp on transitions, otherwise AgentCore never considers the session idle.
  const onHealthChange = () => {
    const next = [...sessions.values()].some((s) => s.isBusy) ? 'HealthyBusy' : 'Healthy'
    if (next !== status) {
      status = next
      lastUpdate = Math.floor(Date.now() / 1000)
    }
  }

  const getOrCreate = (sessionId: string, config: unknown, tools: ContainerSession['tools'], features: ContainerSession['features']) => {
    const existing = sessions.get(sessionId)
    if (existing && !existing.ended) return { session: existing, created: false }
    const session = new ContainerSession(sessionId, config, tools, options.driver, features, {
      bootId,
      maxLogEvents: options.maxLogEvents ?? 10_000,
      onHealthChange,
    })
    sessions.set(sessionId, session)
    return { session, created: true }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status, time_of_last_update: lastUpdate }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/invocations') {
      void handleInvocation(req, res).catch((err) => {
        logger.error('invocation failed', { error: errorMessage(err) })
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: errorMessage(err) }))
      })
      return
    }
    res.writeHead(404).end()
  })

  async function handleInvocation(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { sessionId?: string; prompt?: string; config?: unknown }
    const sessionId = body.sessionId ?? (req.headers[SESSION_HEADER] as string | undefined) ?? newId()
    const { session } = getOrCreate(sessionId, body.config ?? {}, [], { approvalUpdatedInput: false })
    await session.start()
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      untap()
      res.end()
    }
    const untap = session.tap((msg) => {
      if (msg.type !== 'event') return
      res.write(`event: ${msg.event.type}\ndata: ${JSON.stringify(msg.event)}\n\n`)
      if (msg.event.type === 'runtime.turn.completed') finish()
    })
    res.on('close', finish)
    await session.onCommand({ type: 'user_message', id: newId(), content: textContent(body.prompt ?? '') })
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws))
  })

  function onConnection(ws: WebSocket) {
    const decoder = new FrameDecoder<ClientMessage>()
    let session: ContainerSession | undefined
    const helloTimer = setTimeout(() => !session && ws.close(4001, 'hello timeout'), options.helloTimeoutMs ?? 10_000)
    ws.on('message', (data) => {
      let msg: ClientMessage | null
      try {
        msg = decoder.decode(data.toString())
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: `bad frame: ${errorMessage(err)}` }))
        return
      }
      if (!msg) return
      if (msg.type === 'hello') {
        clearTimeout(helloTimer)
        if (msg.protocol !== PROTOCOL_VERSION) {
          ws.close(4002, `unsupported protocol ${msg.protocol}`)
          return
        }
        const res = getOrCreate(msg.sessionId, msg.config, msg.tools, { approvalUpdatedInput: msg.features?.approvalUpdatedInput === true })
        session = res.session
        session.attach(ws, msg, res.created)
        void session.start().catch((err) => logger.error('driver start failed', { sessionId: msg?.type === 'hello' ? msg.sessionId : '', error: errorMessage(err) }))
        return
      }
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', message: 'hello required' }))
        return
      }
      if (msg.type === 'store_response') session.onStoreResponse(msg)
      else void session.onCommand(msg)
    })
    ws.on('close', () => {
      clearTimeout(helloTimer)
      session?.detach(ws)
    })
    ws.on('error', (err) => logger.warn('socket error', { error: errorMessage(err) }))
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 8080, options.host ?? '0.0.0.0', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8080)

  return {
    server,
    bootId,
    port,
    sessions,
    health: () => ({ status, time_of_last_update: lastUpdate }),
    async close() {
      for (const client of wss.clients) client.terminate()
      await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
