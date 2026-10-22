import type { ContentBlock, PersistedEvent, RuntimeEvent } from './events.js'
import { type ApprovalDecision, CapabilityError, type ProviderAdapter, type ProviderCapabilities, type ToolDefinition } from './provider.js'
import type { ActionRecord, Bus, CommandKind, SessionRecord, Store } from './store.js'
import { topics } from './store.js'
import { type ApprovalPolicy, type ToolRegistration, toolDefinitions } from './tools.js'
import { type Logger, Notifier, errorMessage, newId, noopLogger } from './util.js'
import { SessionWorker } from './worker.js'

export interface RuntimeOptions {
  store: Store
  bus: Bus
  providers: Record<string, ProviderAdapter<any>>
  /** Custom tools executed on the server, shared by every provider. */
  tools?: Record<string, ToolRegistration>
  approvals?: {
    /** Defaults to `'ask'` for everything. */
    policy?: ApprovalPolicy
    /** How long an `'ask'` waits for `resolveApproval()`. Default 10 minutes. */
    timeoutMs?: number
    /** Decision applied when the timeout fires. Default `'deny'`. */
    defaultOnTimeout?: 'allow' | 'deny'
  }
  /** Unique per process. Defaults to a random UUID. */
  instanceId?: string
  lease?: { ttlMs?: number; renewIntervalMs?: number }
  /** Release ownership after the session has been idle with nothing pending this long. Default 60s. */
  idleReleaseMs?: number
  /** How often to look for sessions whose owner died. Default 5s. */
  orphanScanIntervalMs?: number
  /** Fallback poll for event/command notifications that may have been missed. Default 2s. */
  pollIntervalMs?: number
  /** How long `send()` & co. wait for the owner to execute the command. Default 60s. */
  commandTimeoutMs?: number
  reconnect?: { baseMs?: number; maxMs?: number }
  /**
   * Tool results and approval events are held until the tool.call they refer to was emitted, at
   * most this long. Default 2s.
   */
  toolCallWaitMs?: number
  logger?: Logger
}

export interface ResolvedOptions {
  approvals: { policy: ApprovalPolicy; timeoutMs: number; defaultOnTimeout: 'allow' | 'deny' }
  lease: { ttlMs: number; renewIntervalMs: number }
  idleReleaseMs: number
  orphanScanIntervalMs: number
  pollIntervalMs: number
  commandTimeoutMs: number
  reconnect: { baseMs: number; maxMs: number }
  toolCallWaitMs: number
}

/** What a SessionWorker needs from its runtime. */
export interface RuntimeInternals {
  store: Store
  bus: Bus
  providers: Record<string, ProviderAdapter>
  tools: Record<string, ToolRegistration>
  toolDefinitions: ToolDefinition[]
  instanceId: string
  options: ResolvedOptions
  logger: Logger
}

export interface CreateSessionInput<Config = unknown> {
  provider: string
  config: Config
  metadata?: Record<string, unknown>
  /** Optional caller-chosen id; must be unique. */
  id?: string
}

export interface EventsOptions {
  /** Resume after this seq (e.g. the SSE `Last-Event-ID`). Default 0 = from the beginning. */
  after?: number
  /** Include live token deltas. Default true. */
  includeDeltas?: boolean
  /** Keep following live events after the replay. Default true. */
  follow?: boolean
  signal?: AbortSignal
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly commandId: string,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

export class Runtime {
  private readonly internals: RuntimeInternals
  private readonly workers = new Map<string, SessionWorker>()
  private scanTimer: NodeJS.Timeout | undefined
  private closed = false

  constructor(options: RuntimeOptions) {
    const tools = options.tools ?? {}
    this.internals = {
      store: options.store,
      bus: options.bus,
      providers: options.providers,
      tools,
      toolDefinitions: toolDefinitions(tools),
      instanceId: options.instanceId ?? newId(),
      logger: options.logger ?? noopLogger,
      options: {
        approvals: {
          policy: options.approvals?.policy ?? (() => 'ask'),
          timeoutMs: options.approvals?.timeoutMs ?? 10 * 60_000,
          defaultOnTimeout: options.approvals?.defaultOnTimeout ?? 'deny',
        },
        lease: {
          ttlMs: options.lease?.ttlMs ?? 15_000,
          renewIntervalMs: options.lease?.renewIntervalMs ?? Math.floor((options.lease?.ttlMs ?? 15_000) / 3),
        },
        idleReleaseMs: options.idleReleaseMs ?? 60_000,
        orphanScanIntervalMs: options.orphanScanIntervalMs ?? 5_000,
        pollIntervalMs: options.pollIntervalMs ?? 2_000,
        commandTimeoutMs: options.commandTimeoutMs ?? 60_000,
        reconnect: { baseMs: options.reconnect?.baseMs ?? 500, maxMs: options.reconnect?.maxMs ?? 30_000 },
        toolCallWaitMs: options.toolCallWaitMs ?? 2_000,
      },
    }
  }

  /**
   * Start background work: periodically look for sessions whose owner died and take them over.
   * Idempotent. `createRuntime()` calls it for you; call it yourself when you construct with
   * `new Runtime()` (for example once your app has finished booting).
   *
   * Everything else works before `start()`: creating sessions, sending, reading events, approvals.
   * Without it, this instance only never adopts orphaned sessions on its own.
   */
  start(): this {
    if (this.closed) throw new Error('Runtime is closed')
    if (this.scanTimer) return this
    this.scanTimer = setInterval(() => void this.scanOrphans(), this.internals.options.orphanScanIntervalMs)
    this.scanTimer.unref?.()
    void this.scanOrphans()
    return this
  }

  /** Whether `start()` has been called (and `close()` has not). */
  get started(): boolean {
    return !!this.scanTimer && !this.closed
  }

  get instanceId(): string {
    return this.internals.instanceId
  }

  /** Sessions currently owned (streamed) by this instance. */
  get ownedSessions(): string[] {
    return [...this.workers.keys()]
  }

  async createSession<Config>(input: CreateSessionInput<Config>): Promise<Session> {
    const adapter = this.internals.providers[input.provider]
    if (!adapter) throw new Error(`Unknown provider "${input.provider}"`)
    const id = input.id ?? newId()
    const metadata = input.metadata ?? {}
    const created = await adapter.createSession({ sessionId: id, config: input.config, metadata, tools: this.internals.toolDefinitions })
    await this.internals.store.createSession({
      id,
      provider: input.provider,
      providerSessionId: created.providerSessionId,
      config: input.config,
      metadata,
      status: 'idle',
      providerCursor: created.cursor ?? null,
    })
    await this.internals.store.appendEvent(id, {
      type: 'session.created',
      data: { provider: input.provider, providerSessionId: created.providerSessionId, metadata },
      provider: input.provider,
    })
    return new Session(this, id)
  }

  /** What the provider registered under `providerKey` supports beyond the common behaviour. */
  capabilities(providerKey: string): ProviderCapabilities {
    const adapter = this.internals.providers[providerKey]
    if (!adapter) throw new Error(`Unknown provider "${providerKey}"`)
    return { ...adapter.capabilities }
  }

  /** Works on any instance, regardless of which one owns the session. */
  async getSession(id: string): Promise<Session | null> {
    const record = await this.internals.store.getSession(id)
    return record ? new Session(this, id) : null
  }

  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.scanTimer)
    await Promise.all([...this.workers.values()].map((w) => w.stop({ release: true })))
  }

  /** @internal */
  get _internals(): RuntimeInternals {
    return this.internals
  }

  /** @internal Enqueue a command and wait until the session owner executed it. */
  async _dispatch(sessionId: string, kind: CommandKind, payload: unknown): Promise<void> {
    const { store, bus, options } = this.internals
    const record = await store.getSession(sessionId)
    if (!record) throw new Error(`Session ${sessionId} not found`)
    if (record.status === 'terminated') throw new Error(`Session ${sessionId} is terminated`)
    const id = newId()
    const notifier = new Notifier()
    const unsubscribe = bus.subscribe(topics.commandDone(sessionId), (cmdId) => cmdId === id && notifier.notify())
    try {
      await store.enqueueCommand({ id, sessionId, kind, payload })
      if (!(await this.ensureWorker(sessionId))) await bus.publish(topics.commands(sessionId), id)
      const deadline = Date.now() + options.commandTimeoutMs
      while (Date.now() < deadline) {
        const cmd = await store.getCommand(id)
        if (cmd?.status === 'done') return
        if (cmd?.status === 'failed') throw new CommandError(cmd.error ?? 'command failed', id)
        await notifier.wait(Math.min(options.pollIntervalMs, Math.max(0, deadline - Date.now())))
      }
      throw new CommandError(`Timed out waiting for ${kind} to be executed; it stays queued`, id)
    } finally {
      unsubscribe()
    }
  }

  /** @internal Replay persisted events after `after`, then follow live ones. */
  async *_events(sessionId: string, opts: EventsOptions = {}): AsyncGenerator<RuntimeEvent> {
    const { store, bus, options } = this.internals
    const includeDeltas = opts.includeDeltas ?? true
    const follow = opts.follow ?? true
    let cursor = opts.after ?? 0
    const notifier = new Notifier()
    const live: RuntimeEvent[] = []
    const completed = new Set<string>()
    const unsubscribers = [bus.subscribe(topics.events(sessionId), () => notifier.notify())]
    if (includeDeltas && follow) {
      unsubscribers.push(
        bus.subscribe(topics.ephemeral(sessionId), (payload) => {
          try {
            live.push(JSON.parse(payload) as RuntimeEvent)
            notifier.notify()
          } catch {
            /* ignore malformed payloads */
          }
        }),
      )
    }
    const onAbort = () => notifier.notify()
    opts.signal?.addEventListener('abort', onAbort)
    try {
      while (!opts.signal?.aborted) {
        let terminated = false
        for (;;) {
          const batch: PersistedEvent[] = await store.readEvents(sessionId, cursor, 500)
          for (const ev of batch) {
            cursor = ev.seq
            if (ev.type === 'agent.message.completed') completed.add(ev.data.messageId)
            if (ev.type === 'session.status' && ev.data.status === 'terminated') terminated = true
            yield ev
          }
          if (batch.length < 500) break
        }
        if (!follow || terminated) return
        while (live.length) {
          const ev = live.shift() as RuntimeEvent
          // Deltas that arrive after their message completed are stale.
          if ('messageId' in (ev.data as object) && completed.has((ev.data as { messageId: string }).messageId)) continue
          yield ev
        }
        await notifier.wait(options.pollIntervalMs)
      }
    } finally {
      for (const u of unsubscribers) u()
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Start a local worker if we own (or can take) the session. */
  private async ensureWorker(sessionId: string): Promise<boolean> {
    const existing = this.workers.get(sessionId)
    if (existing && !existing.isStopping) {
      existing.kick()
      return true
    }
    // A worker that is shutting down (idle release) won't drain new commands; wait it out.
    if (existing) await existing.done
    if (this.closed) return false
    const { store, instanceId, options } = this.internals
    if (!(await store.tryAcquireLease(sessionId, instanceId, options.lease.ttlMs))) return false
    if (this.workers.has(sessionId)) return true
    const worker = new SessionWorker(this.internals, sessionId)
    this.workers.set(sessionId, worker)
    worker.done.finally(() => {
      if (this.workers.get(sessionId) === worker) this.workers.delete(sessionId)
    })
    worker.start()
    return true
  }

  private async scanOrphans() {
    if (this.closed) return
    try {
      const ids = await this.internals.store.findOrphans(50)
      for (const id of ids) if (!this.workers.has(id)) await this.ensureWorker(id)
    } catch (err) {
      this.internals.logger.warn('orphan scan failed', { error: errorMessage(err) })
    }
  }
}

export type SendInput = string | ContentBlock[] | { content: ContentBlock[] }

export interface SendOptions {
  /**
   * System-level context appended to the conversation for this and all later turns. It does not
   * replace the agent's system prompt. Text only. See `capabilities().systemMessages`.
   */
  system?: string | ContentBlock[]
}

/** Handle to a session; cheap to create, usable from any instance. */
export class Session {
  constructor(
    private readonly runtime: Runtime,
    readonly id: string,
  ) {}

  async info(): Promise<SessionRecord> {
    const record = await this.runtime._internals.store.getSession(this.id)
    if (!record) throw new Error(`Session ${this.id} not found`)
    return record
  }

  /** Send a user message. Resolves once the owning instance handed it to the provider. */
  async send(input: SendInput, opts: SendOptions = {}): Promise<void> {
    const content = typeof input === 'string' ? [{ type: 'text', text: input }] : Array.isArray(input) ? input : input.content
    const system = typeof opts.system === 'string' ? [{ type: 'text', text: opts.system }] : opts.system
    if (system?.some((b) => b.type !== 'text')) throw new TypeError('send(): `system` must contain only text blocks')
    return this.runtime._dispatch(this.id, 'send', system?.length ? { content, system } : { content })
  }

  interrupt(): Promise<void> {
    return this.runtime._dispatch(this.id, 'interrupt', {})
  }

  /** What this session's provider supports beyond the common behaviour (see `ProviderCapabilities`). */
  async capabilities(): Promise<ProviderCapabilities> {
    return this.runtime.capabilities((await this.info()).provider)
  }

  /**
   * Answer an approval. `updatedInput` (approve with modified tool input) throws `CapabilityError`
   * unless `capabilities().approvalUpdatedInput` is true.
   */
  async resolveApproval(approvalId: string, decision: 'allow' | 'deny' | ApprovalDecision, message?: string): Promise<void> {
    const d: ApprovalDecision = typeof decision === 'string' ? { behavior: decision, ...(message ? { message } : {}) } : decision
    if (d.updatedInput && !(await this.capabilities()).approvalUpdatedInput) {
      throw new CapabilityError("This session's provider does not support changing tool input on approval", 'approvalUpdatedInput')
    }
    return this.runtime._dispatch(this.id, 'resolve_approval', { approvalId, decision: d })
  }

  terminate(): Promise<void> {
    return this.runtime._dispatch(this.id, 'terminate', {})
  }

  pendingApprovals(): Promise<ActionRecord[]> {
    return this.runtime._internals.store.listActions(this.id, { kind: 'approval', status: 'pending' })
  }

  /**
   * Replays persisted events after `after`, then follows live events (including token deltas)
   * regardless of which instance owns the provider stream. Break out of the loop to stop.
   */
  events(opts: EventsOptions = {}): AsyncGenerator<RuntimeEvent> {
    return this.runtime._events(this.id, opts)
  }
}

/** Construct a runtime and `start()` it. */
export const createRuntime = (options: RuntimeOptions): Runtime => new Runtime(options).start()
