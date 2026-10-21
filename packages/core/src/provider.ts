import type { ContentBlock, ProviderEvent } from './events.js'

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
 */
export type ProviderOutput =
  | { kind: 'event'; event: ProviderEvent }
  | { kind: 'cursor'; cursor: unknown }
  | { kind: 'ready' }
  | { kind: 'tool_request'; requestId: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'approval_request'; requestId: string; toolUseId: string; name: string; input: unknown }
  | { kind: 'actions_reset'; reason: string }

export interface CreatedProviderSession {
  providerSessionId: string
  cursor?: unknown
}

export interface ProviderAdapter<Config = unknown> {
  readonly name: string
  createSession(input: { sessionId: string; config: Config; metadata: Record<string, unknown>; tools: ToolDefinition[] }): Promise<CreatedProviderSession>
  /**
   * Long-lived stream of outputs. Adapters reconnect internally and fill gaps from `cursor`;
   * the iterable ends only when `signal` aborts or the provider session is gone. Throwing makes
   * the runtime retry `connect()` with backoff.
   */
  connect(ctx: ConnectContext<Config>): AsyncIterable<ProviderOutput>
  sendMessage(ctx: ProviderContext<Config>, content: ContentBlock[]): Promise<void>
  interrupt(ctx: ProviderContext<Config>): Promise<void>
  submitToolResult(ctx: ProviderContext<Config>, requestId: string, result: ToolResult): Promise<void>
  submitApproval(ctx: ProviderContext<Config>, requestId: string, decision: ApprovalDecision): Promise<void>
  terminate?(ctx: ProviderContext<Config>): Promise<void>
}
