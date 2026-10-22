import { Observable } from 'rxjs'
import type { EventsOptions, RuntimeEvent, Session } from '@agent-runtime/core'

/** The shape `@Sse()` handlers return (compatible with Nest's `MessageEvent`). */
export interface SseMessage {
  data?: string | object
  id?: string
  type?: string
  retry?: number
  comment?: string
}

export interface SessionEventsOptions extends Pick<EventsOptions, 'includeDeltas'> {
  /** Resume after this `seq`; usually `lastEventId(req)`. */
  after?: number
  /** Send a keep-alive comment this often, so proxies don't close an idle stream. Default 15 s; 0 disables. */
  heartbeatMs?: number
  /** Include the provider's original payload as `raw`. Default `false`. */
  includeRaw?: boolean
}

/**
 * The resume position a reconnecting client asks for: the `Last-Event-ID` header that
 * `EventSource` sends automatically, or an `?after=` query parameter. Works with Express and
 * Fastify requests.
 */
export function lastEventId(req: { headers?: Record<string, string | string[] | undefined>; query?: unknown }): number | undefined {
  const header = req.headers?.['last-event-id']
  const query = (req.query as Record<string, unknown> | undefined)?.after
  const raw = Array.isArray(header) ? header[0] : (header ?? (typeof query === 'string' ? query : undefined))
  const n = Number(raw)
  return raw !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined
}

/**
 * Stream a session's events from an `@Sse()` handler. Each message has `event:` set to the event
 * type and `data:` to the event, like `toSSE()` in core.
 *
 * Every message carries `id:` = the latest persisted `seq`, including live-only deltas and
 * heartbeats. Nest otherwise numbers id-less messages itself, which would corrupt the browser's
 * `Last-Event-ID`; repeating the last seq keeps reconnects exact.
 *
 * Unsubscribing (the client disconnecting) stops the stream. The agent keeps working.
 */
export function sessionEvents(session: Session, opts: SessionEventsOptions = {}): Observable<SseMessage> {
  const { after, includeDeltas, heartbeatMs = 15_000, includeRaw = false } = opts
  return new Observable<SseMessage>((subscriber) => {
    let lastSeq = after ?? 0
    const abort = new AbortController()
    const heartbeat = heartbeatMs > 0 ? setInterval(() => subscriber.next({ id: String(lastSeq), comment: 'ping' }), heartbeatMs) : undefined
    void (async () => {
      try {
        for await (const event of session.events({ after, includeDeltas, signal: abort.signal })) {
          if (event.seq !== undefined) lastSeq = event.seq
          subscriber.next(toMessage(event, lastSeq, includeRaw))
        }
        subscriber.complete()
      } catch (err) {
        if (!abort.signal.aborted) subscriber.error(err)
      }
    })()
    return () => {
      clearInterval(heartbeat)
      abort.abort()
    }
  })
}

function toMessage(event: RuntimeEvent, lastSeq: number, includeRaw: boolean): SseMessage {
  const { raw, ...rest } = event
  return { id: String(lastSeq), type: event.type, data: includeRaw ? event : rest }
}
