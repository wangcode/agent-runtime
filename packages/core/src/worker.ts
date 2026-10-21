import { type ProviderEvent, type RuntimeEvent, type SessionStatus, type Usage, isEphemeralType } from './events.js'
import { type ApprovalDecision, CapabilityError, type ProviderAdapter, type ProviderContext, type ProviderOutput, type ToolResult } from './provider.js'
import type { ActionRecord, CommandRecord, SessionRecord } from './store.js'
import { topics } from './store.js'
import { normalizeToolOutput } from './tools.js'
import type { RuntimeInternals } from './runtime.js'
import { abortable, backoff, deferred, errorMessage, newId, sleep } from './util.js'

/** NOTIFY payloads are capped at 8000 bytes; keep delta chunks well below that. */
const MAX_DELTA_CHARS = 1500

/** Events that must not appear before the tool.call they refer to. */
const toolScopedId = (event: ProviderEvent): string | undefined =>
  event.type === 'tool.result' || event.type === 'approval.requested' || event.type === 'approval.resolved' ? event.data.toolUseId : undefined

function addUsage(total: Usage, u: Usage): Usage {
  const out: Usage = { ...total }
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUsd'] as const) {
    if (u[key] !== undefined) out[key] = (out[key] ?? 0) + u[key]
  }
  return out
}

/**
 * Owns one session on this instance while it holds the lease: keeps the provider stream open,
 * persists and fans out events, runs custom tools, applies approval policy and timeouts, and
 * executes queued commands. Stops (and releases the lease) once the session has been idle with
 * nothing pending for `idleReleaseMs`, or immediately if the lease is lost.
 */
export class SessionWorker {
  private readonly abort = new AbortController()
  private readonly ready = deferred()
  private readonly finished = deferred()
  private record!: SessionRecord
  private adapter!: ProviderAdapter
  private ctx!: ProviderContext
  private status: SessionStatus = 'idle'
  private draining = false
  private drainAgain = false
  private runningTools = new Set<string>()
  private approvalTimers = new Map<string, NodeJS.Timeout>()
  private idleTimer: NodeJS.Timeout | undefined
  private renewTimer: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  private release = true
  private stopping = false
  /** An interrupt was sent during the current turn; its turn.completed becomes `interrupted`. */
  private interruptRequested = false
  /** Usage reported by `usage` outputs during the current turn. */
  private turnUsage: Usage | undefined
  /** tool.call ids already emitted (bounded). */
  private toolCalls = new Set<string>()
  /** Events held back until their tool.call is emitted. */
  private awaitingToolCall = new Map<string, { events: ProviderEvent[]; timer: NodeJS.Timeout }>()

  constructor(
    private readonly rt: RuntimeInternals,
    readonly sessionId: string,
  ) {}

  get done(): Promise<void> {
    return this.finished.promise
  }

  get isStopping(): boolean {
    return this.stopping
  }

  start(): void {
    this.main().then(
      () => this.finished.resolve(),
      (err) => {
        this.rt.logger.error('session worker crashed', { sessionId: this.sessionId, error: errorMessage(err) })
        this.finished.resolve()
      },
    )
  }

  async stop(opts: { release?: boolean } = {}): Promise<void> {
    if (!this.stopping) {
      this.stopping = true
      this.release = opts.release ?? true
      this.abort.abort()
    }
    await this.finished.promise
  }

  /** Nudge the worker to execute pending commands. */
  kick(): void {
    void this.drain()
  }

  private get signal() {
    return this.abort.signal
  }

  private async main() {
    const { store, bus, options, instanceId } = this.rt
    try {
      const record = await store.getSession(this.sessionId)
      if (!record || record.status === 'terminated') return
      this.record = record
      this.status = record.status
      const adapter = this.rt.providers[record.provider]
      if (!adapter) throw new Error(`Unknown provider "${record.provider}"`)
      this.adapter = adapter
      this.ctx = {
        sessionId: record.id,
        providerSessionId: record.providerSessionId,
        config: record.config,
        metadata: record.metadata,
        tools: this.rt.toolDefinitions,
      }

      this.renewTimer = setInterval(() => void this.renew(), options.lease.renewIntervalMs)
      this.unsubscribe = bus.subscribe(topics.commands(this.sessionId), () => this.kick())

      await this.recoverActions()
      const connecting = this.connectLoop()
      this.scheduleIdleCheck()
      await connecting
    } finally {
      this.stopping = true
      if (!this.abort.signal.aborted) this.abort.abort()
      clearInterval(this.renewTimer)
      clearTimeout(this.idleTimer)
      for (const t of this.approvalTimers.values()) clearTimeout(t)
      this.approvalTimers.clear()
      for (const h of this.awaitingToolCall.values()) clearTimeout(h.timer)
      this.awaitingToolCall.clear()
      this.unsubscribe?.()
      if (this.release) await store.releaseLease(this.sessionId, instanceId).catch(() => {})
    }
  }

  private async renew() {
    if (this.signal.aborted) return
    try {
      const ok = await this.rt.store.renewLease(this.sessionId, this.rt.instanceId, this.rt.options.lease.ttlMs)
      if (!ok) {
        this.rt.logger.warn('lease lost', { sessionId: this.sessionId })
        void this.stop({ release: false })
      }
    } catch (err) {
      this.rt.logger.warn('lease renew failed', { sessionId: this.sessionId, error: errorMessage(err) })
    }
  }

  private async connectLoop() {
    let attempt = 0
    while (!this.signal.aborted) {
      try {
        const fresh = await this.rt.store.getSession(this.sessionId)
        const cursor = fresh?.providerCursor ?? null
        for await (const out of abortable(this.adapter.connect({ ...this.ctx, cursor, signal: this.signal, transcripts: this.rt.store }), this.signal)) {
          attempt = 0
          if (this.signal.aborted) break
          await this.handleOutput(out)
        }
        // The adapter only ends cleanly when aborted or when the provider session is gone.
        if (!this.signal.aborted) {
          this.rt.logger.info('provider stream ended', { sessionId: this.sessionId })
          void this.stop()
        }
        return
      } catch (err) {
        if (this.signal.aborted) return
        attempt += 1
        this.rt.logger.warn('provider connection failed', { sessionId: this.sessionId, attempt, error: errorMessage(err) })
        await sleep(backoff(attempt, this.rt.options.reconnect.baseMs, this.rt.options.reconnect.maxMs), this.signal)
      }
    }
  }

  private async handleOutput(out: ProviderOutput) {
    clearTimeout(this.idleTimer)
    switch (out.kind) {
      case 'ready':
        if (!this.ready.settled) this.ready.resolve()
        await this.drain()
        break
      case 'cursor':
        await this.rt.store.updateSession(this.sessionId, { providerCursor: out.cursor })
        break
      case 'event':
        await this.emit(out.event)
        break
      case 'tool_request':
        await this.onToolRequest(out)
        break
      case 'approval_request':
        await this.onApprovalRequest(out)
        break
      case 'actions_reset':
        await this.cancelPendingActions(out.reason)
        break
      case 'usage':
        this.turnUsage = addUsage(this.turnUsage ?? {}, out.usage)
        break
    }
    this.scheduleIdleCheck()
  }

  /**
   * Persist (or fan out, for deltas) one event, enforcing the behaviour every provider must share
   * (docs/behavior-spec.md): no repeated status, `session.status: idle` right before every
   * `turn.completed`, `interrupted` stop reason after an interrupt, per-turn usage totals.
   */
  private async emit(event: ProviderEvent): Promise<void> {
    if (isEphemeralType(event.type)) return this.publishEphemeral(event)
    // Providers may report a tool's result or permission request before the call itself (the
    // Agent SDK runs tools concurrently with delivering the assistant message). Keep causal order.
    const toolUseId = toolScopedId(event)
    if (toolUseId && !this.toolCalls.has(toolUseId)) return this.holdUntilToolCall(toolUseId, event)
    if (event.type === 'session.status' && event.data.status === this.status) return
    if (event.type === 'turn.completed') {
      // Nothing of this turn may come after its end: release anything still waiting for a tool.call.
      for (const id of [...this.awaitingToolCall.keys()]) await this.releaseToolEvents(id)
      if (this.status !== 'idle' && this.status !== 'terminated') {
        await this.emit({ type: 'session.status', data: { status: 'idle' }, ...(event.sourceId ? { sourceId: `${event.sourceId}:idle` } : {}) })
      }
      const usage = event.data.usage ?? this.turnUsage
      event = {
        ...event,
        data: { ...event.data, stopReason: this.interruptRequested ? 'interrupted' : event.data.stopReason, ...(usage ? { usage } : {}) },
      }
      this.interruptRequested = false
      this.turnUsage = undefined
    }
    // One tool.result per tool call: the first one wins (e.g. ours for a denial vs. the provider's).
    if (event.type === 'tool.result') event = { ...event, sourceId: `tool.result:${event.data.toolUseId}` }
    await this.persist(event)
    if (event.type === 'tool.call') await this.releaseToolEvents(event.data.toolUseId)
  }

  private holdUntilToolCall(toolUseId: string, event: ProviderEvent) {
    const held = this.awaitingToolCall.get(toolUseId)
    if (held) {
      held.events.push(event)
      return
    }
    const timer = setTimeout(() => {
      this.rt.logger.warn('tool.call never arrived; emitting dependent events anyway', { sessionId: this.sessionId, toolUseId })
      void this.releaseToolEvents(toolUseId).catch((err) =>
        this.rt.logger.error('emitting held tool events failed', { sessionId: this.sessionId, error: errorMessage(err) }),
      )
    }, this.rt.options.toolCallWaitMs)
    this.awaitingToolCall.set(toolUseId, { events: [event], timer })
  }

  private async releaseToolEvents(toolUseId: string) {
    this.toolCalls.add(toolUseId)
    if (this.toolCalls.size > 2000) this.toolCalls.delete(this.toolCalls.values().next().value as string)
    const held = this.awaitingToolCall.get(toolUseId)
    if (!held) return
    this.awaitingToolCall.delete(toolUseId)
    clearTimeout(held.timer)
    for (const e of held.events) await this.emit(e)
  }

  private async persist(event: ProviderEvent): Promise<void> {
    const persisted = await this.rt.store.appendEvent(this.sessionId, { ...event, provider: this.record.provider })
    if (!persisted) {
      // Already stored (replay after reconnect/takeover): a duplicate tool.call still releases its dependents.
      if (event.type === 'tool.call') await this.releaseToolEvents(event.data.toolUseId)
      return
    }
    if (event.type === 'session.status') await this.setStatus((event.data as { status: SessionStatus }).status)
    await this.rt.bus.publish(topics.events(this.sessionId), String(persisted.seq))
  }

  private async publishEphemeral(event: ProviderEvent) {
    const chunks: ProviderEvent[] = []
    if ((event.type === 'text.delta' || event.type === 'thinking.delta') && event.data.text.length > MAX_DELTA_CHARS) {
      for (let i = 0; i < event.data.text.length; i += MAX_DELTA_CHARS) {
        chunks.push({ ...event, data: { ...event.data, text: event.data.text.slice(i, i + MAX_DELTA_CHARS) } } as ProviderEvent)
      }
    } else {
      chunks.push(event)
    }
    for (const chunk of chunks) {
      const live: RuntimeEvent = {
        id: newId(),
        sessionId: this.sessionId,
        ephemeral: true,
        ts: new Date().toISOString(),
        type: chunk.type,
        data: chunk.data,
        provider: this.record.provider,
        ...(chunk.threadId ? { threadId: chunk.threadId } : {}),
      } as RuntimeEvent
      await this.rt.bus.publish(topics.ephemeral(this.sessionId), JSON.stringify(live))
    }
  }

  private async setStatus(status: SessionStatus) {
    this.status = status
    await this.rt.store.updateSession(this.sessionId, { status })
    if (status === 'terminated') void this.stop()
  }

  // ---------------------------------------------------------------- commands

  private async drain(): Promise<void> {
    if (!this.ready.settled || this.signal.aborted) return
    if (this.draining) {
      this.drainAgain = true
      return
    }
    this.draining = true
    clearTimeout(this.idleTimer)
    try {
      do {
        this.drainAgain = false
        const commands = await this.rt.store.pendingCommands(this.sessionId)
        commands.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        for (const cmd of commands) {
          if (this.signal.aborted) return
          await this.execute(cmd)
        }
      } while (this.drainAgain)
    } finally {
      this.draining = false
      this.scheduleIdleCheck()
    }
  }

  private async execute(cmd: CommandRecord) {
    try {
      switch (cmd.kind) {
        case 'send': {
          const { content, system } = cmd.payload as { content: import('./events.js').ContentBlock[]; system?: import('./events.js').ContentBlock[] }
          const startsTurn = this.status === 'idle'
          await this.emit({ type: 'user.message', data: system ? { content, system } : { content }, sourceId: `cmd:${cmd.id}` })
          if (startsTurn) {
            this.interruptRequested = false
            this.turnUsage = undefined
          }
          // The runtime starts the turn itself, so the timing is the same for every provider.
          await this.emit({ type: 'session.status', data: { status: 'running' }, sourceId: `cmd:${cmd.id}:running` })
          await this.adapter.sendMessage(this.ctx, content, system ? { system } : undefined)
          break
        }
        case 'interrupt':
          if (this.status !== 'idle' && this.status !== 'terminated') this.interruptRequested = true
          await this.adapter.interrupt(this.ctx)
          break
        case 'resolve_approval': {
          const { approvalId, decision } = cmd.payload as { approvalId: string; decision: ApprovalDecision }
          const action = await this.rt.store.getAction(approvalId)
          if (!action || action.sessionId !== this.sessionId || action.kind !== 'approval') throw new Error(`Unknown approval ${approvalId}`)
          if (action.status !== 'pending') throw new Error(`Approval ${approvalId} is already ${action.status}`)
          if (decision.updatedInput && !this.adapter.capabilities.approvalUpdatedInput) {
            throw new CapabilityError(`Provider "${this.record.provider}" does not support changing tool input on approval`, 'approvalUpdatedInput')
          }
          const ok = await this.resolveApproval(action, decision, 'user')
          if (!ok) throw new Error(`Approval ${approvalId} was resolved concurrently`)
          break
        }
        case 'terminate':
          await this.adapter.terminate?.(this.ctx)
          await this.cancelPendingActions('session terminated')
          await this.emit({ type: 'session.status', data: { status: 'terminated' }, sourceId: `cmd:${cmd.id}` })
          break
      }
      await this.rt.store.finishCommand(cmd.id, { status: 'done' })
    } catch (err) {
      this.rt.logger.warn('command failed', { sessionId: this.sessionId, kind: cmd.kind, error: errorMessage(err) })
      await this.rt.store.finishCommand(cmd.id, { status: 'failed', error: errorMessage(err) })
      if (cmd.kind === 'send') {
        await this.emit({ type: 'session.error', data: { message: `Failed to deliver message: ${errorMessage(err)}` }, sourceId: `cmd:${cmd.id}:error` })
      }
    }
    await this.rt.bus.publish(topics.commandDone(this.sessionId), cmd.id)
  }

  // ---------------------------------------------------------------- tools & approvals

  private async onToolRequest(out: Extract<ProviderOutput, { kind: 'tool_request' }>) {
    const { action, created } = await this.rt.store.upsertAction({
      id: newId(),
      sessionId: this.sessionId,
      kind: 'tool',
      requestId: out.requestId,
      toolUseId: out.toolUseId,
      name: out.name,
      input: out.input,
      expiresAt: null,
    })
    if (created || (action.status === 'pending' && !this.runningTools.has(action.id))) this.startTool(action)
    else if (action.status === 'resolved' && !action.delivered) await this.deliver(action)
  }

  private startTool(action: ActionRecord) {
    if (this.runningTools.has(action.id)) return
    this.runningTools.add(action.id)
    void this.runTool(action).finally(() => {
      this.runningTools.delete(action.id)
      this.scheduleIdleCheck()
    })
  }

  private async runTool(action: ActionRecord) {
    const reg = this.rt.tools[action.name]
    let result: ToolResult
    if (!reg) {
      result = { content: [{ type: 'text', text: `No handler registered for custom tool "${action.name}"` }], isError: true }
    } else {
      try {
        const output = await reg.handler(action.input, {
          sessionId: this.sessionId,
          toolUseId: action.toolUseId,
          name: action.name,
          metadata: this.record.metadata,
          signal: this.signal,
        })
        result = normalizeToolOutput(output)
      } catch (err) {
        if (this.signal.aborted) return
        result = { content: [{ type: 'text', text: errorMessage(err) }], isError: true }
      }
    }
    if (this.signal.aborted) return
    const ok = await this.rt.store.resolveAction(action.id, { status: 'resolved', result, resolvedBy: 'handler' })
    if (!ok) return
    await this.emit({
      type: 'tool.result',
      data: { toolUseId: action.toolUseId, content: result.content, ...(result.isError ? { isError: true } : {}) },
      sourceId: `action:${action.id}:result`,
    })
    await this.deliver({ ...action, status: 'resolved', result })
  }

  private async onApprovalRequest(out: Extract<ProviderOutput, { kind: 'approval_request' }>) {
    const existing = (await this.rt.store.listActions(this.sessionId, { kind: 'approval' })).find((a) => a.requestId === out.requestId)
    if (existing) return this.recoverAction(existing)

    const { approvals } = this.rt.options
    let verdict: Awaited<ReturnType<typeof approvals.policy>>
    try {
      verdict = await approvals.policy({
        sessionId: this.sessionId,
        provider: this.record.provider,
        toolUseId: out.toolUseId,
        name: out.name,
        input: out.input,
        metadata: this.record.metadata,
      })
    } catch (err) {
      // A broken policy must not wedge the stream; fall back to asking a human.
      this.rt.logger.error('approval policy threw; asking instead', { sessionId: this.sessionId, error: errorMessage(err) })
      verdict = 'ask'
    }
    if (typeof verdict === 'string') verdict = { decision: verdict } as Exclude<typeof verdict, string>
    if (verdict.decision === 'allow' && verdict.updatedInput && !this.adapter.capabilities.approvalUpdatedInput) {
      this.rt.logger.error('approval policy returned updatedInput, which this provider does not support; asking instead', {
        sessionId: this.sessionId,
        provider: this.record.provider,
      })
      verdict = { decision: 'ask' }
    }
    const timeoutMs = verdict.decision === 'ask' && 'timeoutMs' in verdict && verdict.timeoutMs ? verdict.timeoutMs : approvals.timeoutMs

    const { action, created } = await this.rt.store.upsertAction({
      id: newId(),
      sessionId: this.sessionId,
      kind: 'approval',
      requestId: out.requestId,
      toolUseId: out.toolUseId,
      name: out.name,
      input: out.input,
      expiresAt: verdict.decision === 'ask' ? new Date(Date.now() + timeoutMs) : null,
    })
    if (!created) return this.recoverAction(action)

    if (verdict.decision === 'ask') {
      await this.emit({
        type: 'approval.requested',
        data: { approvalId: action.id, toolUseId: action.toolUseId, name: action.name, input: action.input, expiresAt: action.expiresAt?.toISOString() },
        sourceId: `action:${action.id}:requested`,
      })
      this.armApprovalTimer(action)
    } else {
      const message = 'message' in verdict ? verdict.message : undefined
      const updatedInput = 'updatedInput' in verdict ? verdict.updatedInput : undefined
      await this.resolveApproval(action, { behavior: verdict.decision, ...(message ? { message } : {}), ...(updatedInput ? { updatedInput } : {}) }, 'policy')
    }
  }

  private armApprovalTimer(action: ActionRecord) {
    if (this.approvalTimers.has(action.id) || !action.expiresAt) return
    const delay = Math.max(0, action.expiresAt.getTime() - Date.now())
    const timer = setTimeout(() => {
      this.approvalTimers.delete(action.id)
      const behavior = this.rt.options.approvals.defaultOnTimeout
      void this.resolveApproval(action, { behavior, message: 'Approval timed out' }, 'timeout').catch((err) =>
        this.rt.logger.error('approval timeout handling failed', { sessionId: this.sessionId, error: errorMessage(err) }),
      )
    }, delay)
    this.approvalTimers.set(action.id, timer)
  }

  private async resolveApproval(action: ActionRecord, decision: ApprovalDecision, by: 'user' | 'policy' | 'timeout'): Promise<boolean> {
    const ok = await this.rt.store.resolveAction(action.id, { status: 'resolved', result: decision, resolvedBy: by })
    if (!ok) return false
    clearTimeout(this.approvalTimers.get(action.id))
    this.approvalTimers.delete(action.id)
    await this.emit({
      type: 'approval.resolved',
      data: {
        approvalId: action.id,
        toolUseId: action.toolUseId,
        decision: decision.behavior,
        by,
        ...(decision.message ? { message: decision.message } : {}),
      },
      sourceId: `action:${action.id}:resolved`,
    })
    if (decision.behavior === 'deny') await this.emitDeniedResult(action.toolUseId, decision.message)
    await this.deliver({ ...action, status: 'resolved', result: decision })
    return true
  }

  /** Send a resolved action's result to the provider, retrying a few times. */
  private async deliver(action: ActionRecord) {
    for (let attempt = 0; attempt < 5 && !this.signal.aborted; attempt++) {
      try {
        if (action.kind === 'tool') await this.adapter.submitToolResult(this.ctx, action.requestId, action.result as ToolResult)
        else await this.adapter.submitApproval(this.ctx, action.requestId, action.result as ApprovalDecision)
        await this.rt.store.markActionDelivered(action.id)
        return
      } catch (err) {
        this.rt.logger.warn('delivering action result failed', { sessionId: this.sessionId, actionId: action.id, attempt, error: errorMessage(err) })
        await sleep(backoff(attempt + 1, 200, 5000), this.signal)
      }
    }
  }

  /** Resume whatever a previous owner left unfinished. */
  private async recoverActions() {
    for (const action of await this.rt.store.listActions(this.sessionId)) await this.recoverAction(action)
  }

  private async recoverAction(action: ActionRecord) {
    if (action.status === 'pending') {
      if (action.kind === 'tool') this.startTool(action)
      else this.armApprovalTimer(action)
    } else if (action.status === 'resolved' && !action.delivered) {
      // Wait for the provider connection before re-sending.
      void this.ready.promise.then(() => this.deliver(action))
    }
  }

  private async cancelPendingActions(reason: string) {
    for (const action of await this.rt.store.listActions(this.sessionId, { status: 'pending' })) {
      const ok = await this.rt.store.resolveAction(action.id, { status: 'cancelled', resolvedBy: 'system' })
      if (!ok) continue
      clearTimeout(this.approvalTimers.get(action.id))
      this.approvalTimers.delete(action.id)
      if (action.kind === 'approval') {
        await this.emit({
          type: 'approval.resolved',
          data: { approvalId: action.id, toolUseId: action.toolUseId, decision: 'deny', by: 'system', message: reason },
          sourceId: `action:${action.id}:resolved`,
        })
        await this.emitDeniedResult(action.toolUseId, reason)
      }
    }
  }

  /** Every tool call ends with exactly one tool.result; a denied call gets an error result here. */
  private emitDeniedResult(toolUseId: string, message?: string) {
    return this.emit({ type: 'tool.result', data: { toolUseId, content: [{ type: 'text', text: message ?? 'Permission denied' }], isError: true } })
  }

  // ---------------------------------------------------------------- idle release

  private scheduleIdleCheck() {
    clearTimeout(this.idleTimer)
    if (this.signal.aborted || !this.isQuiet()) return
    this.idleTimer = setTimeout(() => void this.checkIdle(), this.rt.options.idleReleaseMs)
  }

  private isQuiet() {
    return (this.status === 'idle' || this.status === 'terminated') && !this.draining && this.runningTools.size === 0 && this.approvalTimers.size === 0
  }

  private async checkIdle() {
    if (!this.isQuiet()) return
    const [commands, actions] = await Promise.all([
      this.rt.store.pendingCommands(this.sessionId),
      this.rt.store.listActions(this.sessionId, { status: 'pending' }),
    ])
    if (commands.length || actions.length || !this.isQuiet()) return this.kick()
    this.rt.logger.debug('releasing idle session', { sessionId: this.sessionId })
    void this.stop({ release: true })
  }
}
