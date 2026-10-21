import type { ContentBlock, ProviderEvent, SessionStatus, StopReason, ToolKind } from '@agent-runtime/core'
import { SDK_CONTENT_BLOCKS, SDK_DELTAS, SDK_RESULT_STOP_REASONS, SDK_STREAM_EVENTS, sdkMessageHandling, sdkMessageKey } from './coverage.js'

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

export interface MapperOptions {
  /** Prefix of the in-process MCP server exposing caller-side tools, e.g. `mcp__runtime__`. */
  customToolPrefix: string
  /** Also forward messages the coverage table marks `ignored` as `provider.custom`. Default false. */
  forwardAll?: boolean
}

/**
 * Turns Claude Agent SDK messages into unified events, following the coverage tables in
 * coverage.ts. Unknown message types become `provider.custom`; unknown content blocks are passed
 * through in `message.completed`. Each non-tool content block becomes
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
    const key = sdkMessageKey(msg)
    let handling = sdkMessageHandling(key)
    // A result subtype only a newer SDK knows still ends the turn.
    if (msg.type === 'result') handling = 'mapped'
    if (handling === 'ignored' && !this.opts.forwardAll) return
    if (handling === 'mapped') {
      switch (msg.type) {
        case 'stream_event':
          return this.onStreamEvent(msg)
        case 'assistant':
          return this.onAssistant(msg)
        case 'user':
          return this.onUser(msg)
        case 'result':
          return this.onResult(msg)
      }
    }
    this.emit({ type: 'provider.custom', data: { name: key, payload: msg }, ...(msg.uuid ? { sourceId: msg.uuid } : {}) })
  }

  private ensureRunning() {
    if (this.status === 'idle') this.setStatus('running')
  }

  private onStreamEvent(msg: SdkMessageLike) {
    const ev = msg.event
    if (!ev || (SDK_STREAM_EVENTS as Record<string, string>)[ev.type] !== 'mapped') return
    this.ensureRunning()
    if (ev.type === 'message_start') {
      this.currentMessageId = ev.message?.id
      return
    }
    const messageId = `${this.currentMessageId ?? 'msg'}:${ev.index ?? 0}`
    if (ev.type === 'content_block_start') {
      const kind = ev.content_block?.type
      if (kind === 'text' || kind === 'thinking') this.emit({ type: 'message.start', data: { messageId, kind } })
    } else if (ev.type === 'content_block_delta' && ev.delta) {
      const deltaKind = (SDK_DELTAS as Record<string, string>)[ev.delta.type] ?? 'ignored'
      if (deltaKind === 'text' && ev.delta.text) {
        this.emit({ type: 'text.delta', data: { messageId, text: ev.delta.text, index: ev.index ?? 0 } })
      } else if (deltaKind === 'thinking' && ev.delta.thinking) {
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
      const handling = (SDK_CONTENT_BLOCKS as Record<string, 'message' | 'tool_call'>)[block.type as string] ?? 'message'
      if (handling === 'tool_call') {
        const fullName = block.name as string
        const custom = fullName.startsWith(this.opts.customToolPrefix)
        const kind: ToolKind = custom ? 'custom' : fullName.startsWith('mcp__') || block.type === 'mcp_tool_use' ? 'mcp' : 'builtin'
        const mcpServer = kind === 'mcp' ? ((block.server_name as string | undefined) ?? fullName.split('__')[1]) : undefined
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
      } else {
        // text, thinking, server tool results, redacted thinking, … and block types we don't know yet.
        this.emit({ type: 'message.completed', data: { messageId: `${apiId}:${index}`, content: [block as ContentBlock] }, raw: msg, sourceId })
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
    const stopReason: StopReason = this.interrupted
      ? 'interrupted'
      : ((SDK_RESULT_STOP_REASONS as Record<string, StopReason>)[msg.subtype ?? ''] ?? msg.subtype ?? 'end_turn')
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
