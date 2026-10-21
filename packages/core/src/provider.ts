import type { ContentBlock, ProviderEvent, Usage } from './events.js'
import type { TranscriptStore } from './store.js'

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>
}

export interface ToolResult {
  content: ContentBlock[]
  isError?: boolean
}

export interface ApprovalDecision {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
}

export interface ProviderContext<Config = unknown> {
  sessionId: string
  providerSessionId: string
  config: Config
  metadata: Record<string, unknown>
  /** Custom tools registered on the runtime (handlers stay on the caller side). */
  tools: ToolDefinition[]
}

export interface ConnectContext<Config = unknown> extends ProviderContext<Config> {
  /** Provider-specific resume point last persisted for this session, if any. */
  cursor: unknown
  signal: AbortSignal
  /** Durable transcript storage, for providers that keep agent state on the caller side. */
  transcripts: TranscriptStore
}

/**
 * Everything an adapter can yield from `connect()`.
 *
 * - `event`: a normalized event (persisted unless its type is ephemeral).
 * - `cursor`: a new resume point; persisted after all preceding outputs were handled.
 * - `ready`: the provider stream is established; commands (send/interrupt) may now flow.
 * - `tool_request`: the agent called a custom tool whose handler lives on the caller side.
 * - `approval_request`: the agent wants to run a tool that needs a permission decision.
 * - `actions_reset`: the provider lost in-flight requests (e.g. a fresh AgentCore microVM);
 *   outstanding tool/approval requests can never be answered and are cancelled.
 * - `usage`: token/cost usage of one model request; the runtime sums it per turn into
 *   `turn.completed.usage` (unless the adapter's `turn.completed` already carries the turn total).
 */
export type ProviderOutput =
  | { kind: 'event'; event: ProviderEvent }
  | { kind: 'cursor'; cursor: unknown }
  | { kind: 'ready' }
  | { kind: 'tool_request'; requestId: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'approval_request'; requestId: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'actions_reset'; reason: string }
  | { kind: 'usage'; usage: Usage }

export interface CreatedProviderSession {
  providerSessionId: string
  cursor?: unknown
}

/**
 * What a provider can do beyond the behaviour every provider guarantees (see docs/behavior-spec.md).
 * Callers can read these via `session.capabilities()`; using an unsupported feature throws
 * `CapabilityError` instead of being silently ignored.
 */
export interface ProviderCapabilities {
  /** Approvals may change the tool input (`updatedInput`). Off unless the provider supports it and the caller enabled it. */
  approvalUpdatedInput: boolean
  /** `full`: thinking text always complete. `best_effort`: assembled from live deltas, may be partial after a reconnect. */
  thinkingContent: 'full' | 'best_effort'
  /** `turn.completed.usage.costUsd` is provided. */
  turnCost: boolean
  /**
   * How `send(…, { system })` is delivered. `native`: a real system-role message the provider keeps
   * for this and later turns. `emulated`: added to the user message as a `<system-reminder>` block.
   */
  systemMessages: 'native' | 'emulated'
}

export interface SendMessageOptions {
  /** System-level context to append for this and later turns; text blocks only. */
  system?: ContentBlock[]
}

export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly capability: keyof ProviderCapabilities,
  ) {
    super(message)
    this.name = 'CapabilityError'
  }
}

export interface ProviderAdapter<Config = unknown> {
  readonly name: string
  readonly capabilities: ProviderCapabilities
  createSession(input: { sessionId: string; config: Config; metadata: Record<string, unknown>; tools: ToolDefinition[] }): Promise<CreatedProviderSession>
  /**
   * Long-lived stream of outputs. Adapters reconnect internally and fill gaps from `cursor`;
   * the iterable ends only when `signal` aborts or the provider session is gone. Throwing makes
   * the runtime retry `connect()` with backoff.
   */
  connect(ctx: ConnectContext<Config>): AsyncIterable<ProviderOutput>
  sendMessage(ctx: ProviderContext<Config>, content: ContentBlock[], opts?: SendMessageOptions): Promise<void>
  interrupt(ctx: ProviderContext<Config>): Promise<void>
  submitToolResult(ctx: ProviderContext<Config>, requestId: string, result: ToolResult): Promise<void>
  submitApproval(ctx: ProviderContext<Config>, requestId: string, decision: ApprovalDecision): Promise<void>
  terminate?(ctx: ProviderContext<Config>): Promise<void>
}
