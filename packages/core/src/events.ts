/**
 * Unified event model shared by every provider.
 *
 * Persisted events carry a per-session monotonically increasing `seq`, which doubles as the
 * SSE `id` so clients can resume with `Last-Event-ID`. Ephemeral events (token deltas) are
 * only fanned out live: they have no `seq` and are never replayed.
 */

export type SessionStatus = 'idle' | 'running' | 'requires_action' | 'terminated'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; source: unknown }
  | { type: 'document'; source: unknown }
  | { type: string; [key: string]: unknown }

export type ToolKind = 'builtin' | 'mcp' | 'custom'

export type StopReason = 'end_turn' | 'requires_action' | 'interrupted' | 'error' | 'budget' | 'refusal' | (string & {})

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUsd?: number
}

export interface EventPayloads {
  'session.created': { provider: string; providerSessionId: string; metadata: Record<string, unknown> }
  'session.status': { status: SessionStatus; reason?: string }
  'session.error': { message: string; code?: string; retryable?: boolean }
  'user.message': {
    content: ContentBlock[]
    /** System-level context sent with this message (`send(…, { system })`); text blocks only. */
    system?: ContentBlock[]
  }
  'agent.message.start': { messageId: string; kind: 'text' | 'thinking' }
  'agent.text.delta': { messageId: string; text: string; index?: number }
  'agent.thinking.delta': { messageId: string; text: string }
  'agent.message.completed': { messageId: string; content: ContentBlock[] }
  'tool.call': { toolUseId: string; name: string; input: unknown; kind: ToolKind; mcpServer?: string }
  'tool.result': { toolUseId: string; content: ContentBlock[]; isError?: boolean }
  'approval.requested': { approvalId: string; toolUseId: string; name: string; input: unknown; expiresAt?: string }
  'approval.resolved': {
    approvalId: string
    toolUseId: string
    decision: 'allow' | 'deny'
    by: 'user' | 'policy' | 'timeout' | 'system'
    message?: string
  }
  /** Always immediately preceded by `session.status: idle`. `usage` is the total for this turn. */
  'runtime.turn.completed': { stopReason: StopReason; usage?: Usage }
  'provider.custom': { name: string; payload: unknown }
}

export type EventType = keyof EventPayloads

/** Event types that are only delivered live and never persisted. */
export const EPHEMERAL_EVENT_TYPES: ReadonlySet<EventType> = new Set(['agent.message.start', 'agent.text.delta', 'agent.thinking.delta'])

export const isEphemeralType = (type: EventType): boolean => EPHEMERAL_EVENT_TYPES.has(type)

/** What a provider adapter emits: an event without session bookkeeping. */
export type ProviderEvent<T extends EventType = EventType> = {
  [K in T]: {
    type: K
    data: EventPayloads[K]
    /** Original provider payload, kept for debugging and provider-specific consumers. */
    raw?: unknown
    /** Sub-agent / thread that produced the event; absent for the main agent. */
    threadId?: string
    /**
     * Stable provider-side identity. Events whose `sourceId` was already persisted for the
     * session are dropped, which makes replays after reconnect/takeover exactly-once.
     */
    sourceId?: string
  }
}[T]

export type RuntimeEvent<T extends EventType = EventType> = {
  [K in T]: {
    /** `String(seq)` for persisted events, a random id for ephemeral ones. */
    id: string
    sessionId: string
    /** Present on persisted events only. */
    seq?: number
    ephemeral?: boolean
    ts: string
    type: K
    data: EventPayloads[K]
    provider?: string
    /** Sub-agent / thread that produced the event; absent for the main agent. */
    threadId?: string
    raw?: unknown
  }
}[T]

export type PersistedEvent<T extends EventType = EventType> = RuntimeEvent<T> & { seq: number }

export const textContent = (text: string): ContentBlock[] => [{ type: 'text', text }]

/** Serialize an event as an SSE frame. Only persisted events get an `id:` line. */
export function toSSE(event: RuntimeEvent, opts: { includeRaw?: boolean } = {}): string {
  const { raw, ...rest } = event
  const body = JSON.stringify(opts.includeRaw ? event : rest)
  const lines = event.seq !== undefined ? [`id: ${event.seq}`] : []
  lines.push(`event: ${event.type}`)
  for (const line of body.split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}
