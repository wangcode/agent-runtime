import type { ContentBlock, ProviderEvent, SessionStatus, StopReason, ToolKind } from '@agent-runtime/core'

/** Loose view of SDKMessage: only the fields we read, so SDK minor versions don't break us. */
export interface SdkMessageLike {
  type: string
  subtype?: string
  uuid?: string
  session_id?: string
  message?: { id?: string; content?: unknown }
  event?: { type: string; index?: number; message?: { id?: string }; content_block?: { type: string }; delta?: { type: string; text?: string; thinking?: string } }
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
  total_cost_usd?: number
  is_error?: boolean
  errors?: string[]
  [key: string]: unknown
}

const STOP_REASONS: Record<string, StopReason> = {
  success: 'end_turn',
  error_max_turns: 'max_turns',
  error_max_budget_usd: 'budget',
  error_during_execution: 'error',
  error_max_structured_output_retries: 'error',
}

const FORWARDED_SYSTEM = new Set(['init', 'compact_boundary', 'api_retry'])

export interface MapperOptions {
  /** Prefix of the in-process MCP server exposing caller-side tools, e.g. `mcp__runtime__`. */
  customToolPrefix: string
  /** Forward every unmapped SDK message as `provider.custom`. Default false (only init/compaction/retries). */
  forwardAll?: boolean
}

/**
 * Turns Claude Agent SDK messages into unified events. Each text/thinking content block becomes
 * its own `message.completed` with id `<apiMessageId>:<blockIndex>`, matching the ids used by the
 * partial-message deltas, so clients can replace streamed previews with final blocks.
 */
export class SdkEventMapper {
  private currentMessageId: string | undefined
  private blockCounters = new Map<string, number>()
  private status: SessionStatus = 'idle'
  interrupted = false

  constructor(
    private readonly emit: (event: ProviderEvent) => void,
    private readonly opts: MapperOptions,
    private readonly onBusy: (busy: boolean) => void = () => {},
  ) {}

  setStatus(status: SessionStatus) {
    if (status === this.status) return
    this.status = status
    this.emit({ type: 'session.status', data: { status } })
    this.onBusy(status === 'running' || status === 'requires_action')
  }

  handle(msg: SdkMessageLike) {
    switch (msg.type) {
      case 'stream_event':
        return this.onStreamEvent(msg)
      case 'assistant':
        return this.onAssistant(msg)
      case 'user':
        return this.onUser(msg)
      case 'result':
        return this.onResult(msg)
      case 'system':
        if (this.opts.forwardAll || FORWARDED_SYSTEM.has(msg.subtype ?? '')) {
          this.emit({ type: 'provider.custom', data: { name: `system.${msg.subtype}`, payload: msg }, ...(msg.uuid ? { sourceId: msg.uuid } : {}) })
        }
        return
      default:
        if (this.opts.forwardAll) this.emit({ type: 'provider.custom', data: { name: msg.type, payload: msg }, ...(msg.uuid ? { sourceId: msg.uuid } : {}) })
    }
  }

  private ensureRunning() {
    if (this.status === 'idle') this.setStatus('running')
  }

  private onStreamEvent(msg: SdkMessageLike) {
    const ev = msg.event
    if (!ev) return
    this.ensureRunning()
    if (ev.type === 'message_start') {
      this.currentMessageId = ev.message?.id
      return
    }
    const messageId = `${this.currentMessageId ?? 'msg'}:${ev.index ?? 0}`
    if (ev.type === 'content_block_start') {
      const kind = ev.content_block?.type
      if (kind === 'text' || kind === 'thinking') this.emit({ type: 'message.start', data: { messageId, kind } })
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta' && ev.delta.text) {
        this.emit({ type: 'text.delta', data: { messageId, text: ev.delta.text, index: ev.index ?? 0 } })
      } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
        this.emit({ type: 'thinking.delta', data: { messageId, text: ev.delta.thinking } })
      }
    }
  }

  private onAssistant(msg: SdkMessageLike) {
    this.ensureRunning()
    const apiId = msg.message?.id ?? msg.uuid ?? 'msg'
    const blocks = Array.isArray(msg.message?.content) ? (msg.message.content as Array<Record<string, unknown>>) : []
    for (const block of blocks) {
      const index = this.blockCounters.get(apiId) ?? 0
      this.blockCounters.set(apiId, index + 1)
      const sourceId = `${msg.uuid ?? apiId}:${index}`
      if (block.type === 'text') {
        this.emit({ type: 'message.completed', data: { messageId: `${apiId}:${index}`, content: [{ type: 'text', text: block.text as string }] }, raw: msg, sourceId })
      } else if (block.type === 'thinking') {
        this.emit({
          type: 'message.completed',
          data: { messageId: `${apiId}:${index}`, content: [{ type: 'thinking', thinking: block.thinking as string }] },
          raw: msg,
          sourceId,
        })
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const fullName = block.name as string
        const custom = fullName.startsWith(this.opts.customToolPrefix)
        const kind: ToolKind = custom ? 'custom' : fullName.startsWith('mcp__') ? 'mcp' : 'builtin'
        const mcpServer = kind === 'mcp' ? fullName.split('__')[1] : undefined
        this.emit({
          type: 'tool.call',
          data: {
            toolUseId: block.id as string,
            name: custom ? fullName.slice(this.opts.customToolPrefix.length) : fullName,
            input: block.input,
            kind,
            ...(mcpServer ? { mcpServer } : {}),
          },
          raw: msg,
          sourceId,
        })
      }
    }
    // Free counters of older messages; the SDK emits one message's blocks contiguously.
    if (this.blockCounters.size > 100) this.blockCounters.delete(this.blockCounters.keys().next().value as string)
  }

  /** Tool results for caller-side tools are recorded by the runtime itself, so they are skipped here. */
  readonly customToolUseIds = new Set<string>()

  private onUser(msg: SdkMessageLike) {
    const content = msg.message?.content
    if (!Array.isArray(content)) return
    content.forEach((block: Record<string, unknown>, i) => {
      if (block.type !== 'tool_result') return
      const toolUseId = block.tool_use_id as string
      if (this.customToolUseIds.has(toolUseId)) {
        this.customToolUseIds.delete(toolUseId)
        return
      }
      const raw = block.content
      const blocks: ContentBlock[] = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? (raw as ContentBlock[]) : []
      this.emit({
        type: 'tool.result',
        data: { toolUseId, content: blocks, ...(block.is_error ? { isError: true } : {}) },
        sourceId: `${msg.uuid ?? toolUseId}:${i}`,
      })
    })
  }

  private onResult(msg: SdkMessageLike) {
    const id = msg.uuid ?? `${Date.now()}`
    if (msg.is_error && msg.subtype !== 'success') {
      const message = msg.errors?.join('\n') || msg.subtype || 'error'
      if (!this.interrupted) this.emit({ type: 'session.error', data: { message, code: msg.subtype }, sourceId: `${id}:error` })
    }
    const stopReason = this.interrupted ? 'interrupted' : (STOP_REASONS[msg.subtype ?? ''] ?? msg.subtype ?? 'end_turn')
    this.interrupted = false
    const u = msg.usage ?? {}
    const usage = {
      ...(u.input_tokens !== undefined ? { inputTokens: u.input_tokens } : {}),
      ...(u.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
      ...(u.cache_read_input_tokens !== undefined ? { cacheReadInputTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens !== undefined ? { cacheCreationInputTokens: u.cache_creation_input_tokens } : {}),
      ...(msg.total_cost_usd !== undefined ? { costUsd: msg.total_cost_usd } : {}),
    }
    this.setStatus('idle')
    this.emit({ type: 'turn.completed', data: { stopReason, usage }, raw: msg, sourceId: id })
  }
}
