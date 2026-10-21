import type { ContentBlock } from '../events.js'
import type {
  ApprovalDecision,
  ProviderCapabilities,
  ConnectContext,
  CreatedProviderSession,
  ProviderAdapter,
  ProviderContext,
  ProviderOutput,
  ToolResult,
} from '../provider.js'
import { AsyncQueue } from '../util.js'

export type FakeCall =
  | { method: 'sendMessage'; sessionId: string; content: ContentBlock[] }
  | { method: 'interrupt'; sessionId: string }
  | { method: 'submitToolResult'; sessionId: string; requestId: string; result: ToolResult }
  | { method: 'submitApproval'; sessionId: string; requestId: string; decision: ApprovalDecision }
  | { method: 'terminate'; sessionId: string }

/**
 * Scriptable in-memory provider for tests and examples. Push outputs with `emit()`; every
 * adapter call is recorded in `calls`. `onSend` lets a test script the agent's reaction.
 */
export class FakeProvider implements ProviderAdapter {
  readonly name = 'fake'
  capabilities: ProviderCapabilities = { approvalUpdatedInput: true, thinkingContent: 'full', turnCost: true }
  readonly calls: FakeCall[] = []
  readonly connections: Array<{ sessionId: string; cursor: unknown }> = []
  onSend?: (sessionId: string, content: ContentBlock[], provider: FakeProvider) => void | Promise<void>
  onToolResult?: (sessionId: string, requestId: string, result: ToolResult, provider: FakeProvider) => void
  onApproval?: (sessionId: string, requestId: string, decision: ApprovalDecision, provider: FakeProvider) => void
  private queues = new Map<string, AsyncQueue<ProviderOutput>>()
  private backlog = new Map<string, ProviderOutput[]>()

  async createSession(input: { sessionId: string }): Promise<CreatedProviderSession> {
    return { providerSessionId: `fake_${input.sessionId}`, cursor: null }
  }

  connect(ctx: ConnectContext): AsyncIterable<ProviderOutput> {
    const queue = new AsyncQueue<ProviderOutput>()
    this.queues.get(ctx.sessionId)?.close()
    this.queues.set(ctx.sessionId, queue)
    this.connections.push({ sessionId: ctx.sessionId, cursor: ctx.cursor })
    ctx.signal.addEventListener('abort', () => queue.close(), { once: true })
    queue.push({ kind: 'ready' })
    for (const out of this.backlog.get(ctx.sessionId) ?? []) queue.push(out)
    this.backlog.delete(ctx.sessionId)
    return queue
  }

  /** Emit outputs on the session's live connection (buffered until one exists). */
  emit(sessionId: string, ...outputs: ProviderOutput[]): void {
    const queue = this.queues.get(sessionId)
    if (!queue || queue.isClosed) {
      this.backlog.set(sessionId, [...(this.backlog.get(sessionId) ?? []), ...outputs])
      return
    }
    for (const out of outputs) queue.push(out)
  }

  /** Simulate a dropped provider connection (the runtime will reconnect). */
  disconnect(sessionId: string, error = new Error('connection reset')): void {
    this.queues.get(sessionId)?.fail(error)
    this.queues.delete(sessionId)
  }

  isConnected(sessionId: string): boolean {
    const q = this.queues.get(sessionId)
    return !!q && !q.isClosed
  }

  async sendMessage(ctx: ProviderContext, content: ContentBlock[]) {
    this.calls.push({ method: 'sendMessage', sessionId: ctx.sessionId, content })
    await this.onSend?.(ctx.sessionId, content, this)
  }

  async interrupt(ctx: ProviderContext) {
    this.calls.push({ method: 'interrupt', sessionId: ctx.sessionId })
  }

  async submitToolResult(ctx: ProviderContext, requestId: string, result: ToolResult) {
    this.calls.push({ method: 'submitToolResult', sessionId: ctx.sessionId, requestId, result })
    this.onToolResult?.(ctx.sessionId, requestId, result, this)
  }

  async submitApproval(ctx: ProviderContext, requestId: string, decision: ApprovalDecision) {
    this.calls.push({ method: 'submitApproval', sessionId: ctx.sessionId, requestId, decision })
    this.onApproval?.(ctx.sessionId, requestId, decision, this)
  }

  async terminate(ctx: ProviderContext) {
    this.calls.push({ method: 'terminate', sessionId: ctx.sessionId })
  }
}
