import type Anthropic from '@anthropic-ai/sdk'
import type { SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions'
import {
  type ApprovalDecision,
  type ConnectContext,
  type ContentBlock,
  type Logger,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderOutput,
  type ToolResult,
  backoff,
  errorMessage,
  noopLogger,
  sleep,
} from '@agent-runtime/core'
import { type MAEvent, mapEvent, newMappingState, toMAContent } from './mapping.js'

export interface ManagedAgentsSessionConfig {
  /** Agent id (latest version) or a pinned `{ type: 'agent', id, version }`. */
  agent: SessionCreateParams['agent']
  environmentId: string
  /** Extra `sessions.create` params (vault_ids, resources, budget, title, metadata...). */
  params?: Omit<SessionCreateParams, 'agent' | 'environment_id'>
}

export interface ManagedAgentsCursor {
  lastEventId: string
  processedAt: string
}

export interface ManagedAgentsOptions {
  client: Anthropic
  /** Stream token deltas for agent messages and thinking. Default true. */
  deltas?: boolean
  /** Attach the original event to persisted events. Default true. */
  includeRaw?: boolean
  /** What `session.terminate()` does on the provider side. Default `archive`. */
  onTerminate?: 'archive' | 'delete' | 'none'
  /**
   * Catch-up after reconnect lists events processed since the cursor minus this margin; duplicates
   * are dropped by event id. Default 60s.
   */
  catchUpMarginMs?: number
  reconnect?: { baseMs?: number; maxMs?: number }
  logger?: Logger
}

const isNotFound = (err: unknown) => (err as { status?: number } | null)?.status === 404

/** Bounded set of recently seen event ids. */
class RecentIds {
  private readonly ids = new Set<string>()
  constructor(private readonly max = 5000) {}
  has(id: string) {
    return this.ids.has(id)
  }
  add(id: string) {
    this.ids.add(id)
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value as string)
  }
}

/**
 * Claude Managed Agents provider.
 *
 * The SSE stream only carries events emitted after it opens and has no resume cursor, so each
 * (re)connect opens the stream first, then lists history since the persisted cursor and dedupes
 * by event id before switching to live events.
 */
export class ManagedAgentsProvider implements ProviderAdapter<ManagedAgentsSessionConfig> {
  readonly name = 'managed-agents'
  private readonly client: Anthropic
  private readonly opts: Required<Omit<ManagedAgentsOptions, 'client' | 'reconnect' | 'logger'>> & {
    reconnect: { baseMs: number; maxMs: number }
    logger: Logger
  }

  constructor(options: ManagedAgentsOptions) {
    this.client = options.client
    this.opts = {
      deltas: options.deltas ?? true,
      includeRaw: options.includeRaw ?? true,
      onTerminate: options.onTerminate ?? 'archive',
      catchUpMarginMs: options.catchUpMarginMs ?? 60_000,
      reconnect: { baseMs: options.reconnect?.baseMs ?? 500, maxMs: options.reconnect?.maxMs ?? 30_000 },
      logger: options.logger ?? noopLogger,
    }
  }

  async createSession(input: { sessionId: string; config: ManagedAgentsSessionConfig; metadata: Record<string, unknown> }) {
    const { config } = input
    const session = await this.client.beta.sessions.create({
      ...config.params,
      agent: config.agent,
      environment_id: config.environmentId,
      metadata: { ...config.params?.metadata, agent_runtime_session_id: input.sessionId },
    })
    return { providerSessionId: session.id, cursor: null }
  }

  async *connect(ctx: ConnectContext<ManagedAgentsSessionConfig>): AsyncGenerator<ProviderOutput> {
    const { signal } = ctx
    const seen = new RecentIds()
    let cursor = (ctx.cursor as ManagedAgentsCursor | null) ?? null
    let attempt = 0
    const sessions = this.client.beta.sessions

    while (!signal.aborted) {
      const state = newMappingState()
      try {
        const stream = await sessions.events.stream(
          ctx.providerSessionId,
          this.opts.deltas ? { event_deltas: ['agent.message', 'agent.thinking'] } : {},
          { signal },
        )

        const handle = function* (this: ManagedAgentsProvider, ev: MAEvent): Generator<ProviderOutput> {
          const id = 'id' in ev ? (ev.id as string) : undefined
          if (id) {
            if (seen.has(id)) return
            seen.add(id)
          }
          yield* mapEvent(ev, state, { includeRaw: this.opts.includeRaw })
          if (id && 'processed_at' in ev && ev.processed_at) {
            cursor = { lastEventId: id, processedAt: ev.processed_at as string }
            yield { kind: 'cursor', cursor }
          }
        }.bind(this)

        // Catch up on anything emitted while we were not connected.
        const since = cursor ? new Date(Date.parse(cursor.processedAt) - this.opts.catchUpMarginMs).toISOString() : undefined
        const history = sessions.events.list(ctx.providerSessionId, { order: 'asc', ...(since ? { 'created_at[gte]': since } : {}) }, { signal })
        let terminated = false
        for await (const ev of history) {
          for (const out of handle(ev as MAEvent)) {
            if (out.kind === 'event' && out.event.type === 'session.status' && out.event.data.status === 'terminated') terminated = true
            yield out
          }
        }
        if (terminated) return
        yield { kind: 'ready' }
        attempt = 0

        for await (const ev of stream) {
          if (signal.aborted) return
          for (const out of handle(ev as MAEvent)) {
            yield out
            if (out.kind === 'event' && out.event.type === 'session.status' && out.event.data.status === 'terminated') return
          }
        }
        this.opts.logger.info('managed agents stream ended; reconnecting', { sessionId: ctx.sessionId })
      } catch (err) {
        if (signal.aborted) return
        if (isNotFound(err)) {
          yield { kind: 'event', event: { type: 'session.status', data: { status: 'terminated', reason: 'not_found' } } }
          return
        }
        this.opts.logger.warn('managed agents stream failed', { sessionId: ctx.sessionId, error: errorMessage(err), attempt })
      }
      attempt += 1
      await sleep(backoff(attempt, this.opts.reconnect.baseMs, this.opts.reconnect.maxMs), signal)
    }
  }

  async sendMessage(ctx: ProviderContext<ManagedAgentsSessionConfig>, content: ContentBlock[]) {
    await this.client.beta.sessions.events.send(ctx.providerSessionId, {
      events: [{ type: 'user.message', content: toMAContent(content) }],
    })
  }

  async interrupt(ctx: ProviderContext<ManagedAgentsSessionConfig>) {
    await this.client.beta.sessions.events.send(ctx.providerSessionId, { events: [{ type: 'user.interrupt' }] })
  }

  async submitToolResult(ctx: ProviderContext<ManagedAgentsSessionConfig>, requestId: string, result: ToolResult) {
    await this.client.beta.sessions.events.send(ctx.providerSessionId, {
      events: [
        {
          type: 'user.custom_tool_result',
          custom_tool_use_id: requestId,
          content: toMAContent(result.content),
          ...(result.isError ? { is_error: true } : {}),
        },
      ],
    })
  }

  async submitApproval(ctx: ProviderContext<ManagedAgentsSessionConfig>, requestId: string, decision: ApprovalDecision) {
    await this.client.beta.sessions.events.send(ctx.providerSessionId, {
      events: [
        {
          type: 'user.tool_confirmation',
          tool_use_id: requestId,
          result: decision.behavior,
          ...(decision.behavior === 'deny' && decision.message ? { deny_message: decision.message } : {}),
        },
      ],
    })
  }

  async terminate(ctx: ProviderContext<ManagedAgentsSessionConfig>) {
    if (this.opts.onTerminate === 'archive') await this.client.beta.sessions.archive(ctx.providerSessionId)
    else if (this.opts.onTerminate === 'delete') await this.client.beta.sessions.delete(ctx.providerSessionId)
  }
}

export const managedAgents = (options: ManagedAgentsOptions): ManagedAgentsProvider => new ManagedAgentsProvider(options)
