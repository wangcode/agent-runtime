import pg from 'pg'
import { type Bus, type Deferred, type Logger, backoff, deferred, errorMessage, noopLogger, sleep } from '@agent-runtime/core'

export interface PgBusOptions {
  /** Used for NOTIFY. */
  pool: pg.Pool
  /** Connection config for the dedicated LISTEN connection (it must not go through a transaction pooler). */
  listenConfig: pg.ClientConfig
  /** NOTIFY channel. Default `agent_runtime`. */
  channel?: string
  logger?: Logger
}

/** NOTIFY payloads are limited to 8000 bytes. */
const MAX_PAYLOAD = 7900

/**
 * Bus over Postgres LISTEN/NOTIFY. One LISTEN connection per process; topics are multiplexed in
 * the payload and fanned out locally. Notifications missed while reconnecting are covered by the
 * runtime's polling fallback.
 */
export class PgBus implements Bus {
  private readonly handlers = new Map<string, Set<(payload: string) => void>>()
  private readonly channel: string
  private readonly logger: Logger
  private client: pg.Client | undefined
  private closed = false
  private started: Deferred<void> | undefined
  private readonly abort = new AbortController()

  constructor(private readonly opts: PgBusOptions) {
    this.channel = opts.channel ?? 'agent_runtime'
    if (!/^[a-z_][a-z0-9_]*$/.test(this.channel)) throw new Error(`Invalid channel "${this.channel}"`)
    this.logger = opts.logger ?? noopLogger
  }

  /** Open the LISTEN connection. Called lazily by `subscribe()`; await it to surface connection errors early. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = deferred()
      void this.supervise(this.started)
    }
    return this.started.promise
  }

  async publish(topic: string, payload: string): Promise<void> {
    const message = JSON.stringify({ t: topic, p: payload })
    if (Buffer.byteLength(message) > MAX_PAYLOAD) {
      this.logger.warn('bus payload too large; dropped', { topic, bytes: Buffer.byteLength(message) })
      return
    }
    await this.opts.pool.query('SELECT pg_notify($1, $2)', [this.channel, message])
  }

  subscribe(topic: string, handler: (payload: string) => void): () => void {
    void this.start()
    let set = this.handlers.get(topic)
    if (!set) this.handlers.set(topic, (set = new Set()))
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(topic)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.abort.abort()
    await this.client?.end().catch(() => {})
  }

  /** Keep one LISTEN connection alive, reconnecting with backoff until closed. */
  private async supervise(started: Deferred<void>) {
    let attempt = 0
    while (!this.closed) {
      const client = new pg.Client(this.opts.listenConfig)
      const lost = new Promise<void>((resolve) => {
        client.on('error', (err) => {
          this.logger.warn('bus connection error', { error: errorMessage(err) })
          resolve()
        })
        client.on('end', () => resolve())
      })
      try {
        await client.connect()
        client.on('notification', (msg) => this.dispatch(msg.payload))
        await client.query(`LISTEN ${this.channel}`)
        this.client = client
        attempt = 0
        if (!started.settled) started.resolve()
        await lost
      } catch (err) {
        this.logger.warn('bus connect failed', { error: errorMessage(err), attempt })
        if (!started.settled && attempt >= 2) started.reject(err)
      }
      await client.end().catch(() => {})
      attempt += 1
      if (!this.closed) await sleep(backoff(attempt, 200, 10_000), this.abort.signal)
    }
  }

  private dispatch(raw: string | undefined) {
    if (!raw) return
    let msg: { t: string; p: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    for (const h of [...(this.handlers.get(msg.t) ?? [])]) {
      try {
        h(msg.p)
      } catch (err) {
        this.logger.error('bus handler threw', { topic: msg.t, error: errorMessage(err) })
      }
    }
  }
}
