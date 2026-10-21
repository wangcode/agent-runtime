import express, { type Express, type Request, type Response } from 'express'
import { CommandError, type Runtime, toSSE } from '@agent-runtime/core'

/**
 * HTTP surface for a frontend. Any instance can serve any route: the runtime routes commands to
 * whichever instance owns the provider stream and fans events out across instances.
 */
export function createApp(runtime: Runtime, opts: { defaultProvider: string; defaultConfig: () => unknown }): Express {
  const app = express()
  app.use(express.json())

  app.post('/sessions', async (req, res) => {
    const session = await runtime.createSession({
      provider: req.body?.provider ?? opts.defaultProvider,
      config: req.body?.config ?? opts.defaultConfig(),
      metadata: req.body?.metadata ?? {},
    })
    res.status(201).json({ id: session.id })
  })

  app.post('/sessions/:id/messages', (req, res) => command(req, res, (s) => s.send(String(req.body?.text ?? ''))))
  app.post('/sessions/:id/interrupt', (req, res) => command(req, res, (s) => s.interrupt()))
  app.post('/sessions/:id/approvals/:approvalId', (req, res) =>
    command(req, res, (s) => s.resolveApproval(String(req.params.approvalId), req.body?.decision === 'allow' ? 'allow' : 'deny', req.body?.message)),
  )
  app.get('/sessions/:id/approvals', async (req, res) => {
    const session = await runtime.getSession(String(req.params.id))
    if (!session) return void res.status(404).end()
    res.json(await session.pendingApprovals())
  })

  /** SSE: replays everything after Last-Event-ID, then streams live events (with deltas). */
  app.get('/sessions/:id/events', async (req, res) => {
    const session = await runtime.getSession(String(req.params.id))
    if (!session) return void res.status(404).end()
    const after = Number(req.header('last-event-id') ?? req.query.after ?? 0) || 0
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.flushHeaders()
    const abort = new AbortController()
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
    req.on('close', () => abort.abort())
    try {
      // The agent keeps working when the client goes away; it just stops receiving.
      for await (const event of session.events({ after, signal: abort.signal })) res.write(toSSE(event))
    } finally {
      clearInterval(heartbeat)
      res.end()
    }
  })

  async function command(req: Request, res: Response, fn: (s: NonNullable<Awaited<ReturnType<Runtime['getSession']>>>) => Promise<void>) {
    const session = await runtime.getSession(String(req.params.id))
    if (!session) return void res.status(404).end()
    try {
      await fn(session)
      res.status(202).json({ ok: true })
    } catch (err) {
      res.status(err instanceof CommandError ? 409 : 500).json({ error: (err as Error).message })
    }
  }

  return app
}
