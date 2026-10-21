import type { ContentBlock, ProviderOutput, StopReason } from '@agent-runtime/core'
import { MA_DELTA_TYPES, MA_PERMISSIONS, MA_STOP_REASONS, type MAEvent, maEventHandling } from './coverage.js'

export type { MAEvent }

export interface MappingState {
  /** Delta stream kind per previewed event id, from `event_start`. */
  deltaKinds: Map<string, 'text' | 'thinking'>
  /** Block message ids (`<eventId>:<index>`) whose `message.start` was already emitted. */
  startedBlocks: Set<string>
  /** Thinking text accumulated from deltas (agent.thinking events carry no content). */
  thinking: Map<string, string>
  /** Last cumulative `session.usage` list cost seen, in USD cents; turned into per-request cost deltas. */
  lastCostCents: number
}

export const newMappingState = (init: { lastCostCents?: number } = {}): MappingState => ({
  deltaKinds: new Map(),
  startedBlocks: new Set(),
  thinking: new Map(),
  lastCostCents: init.lastCostCents ?? 0,
})

export interface MapOptions {
  includeRaw: boolean
  /** Emit `message.start` / `text.delta` / `thinking.delta`. Thinking text is assembled either way. Default true. */
  forwardDeltas?: boolean
}

/** Message id of one content block; deltas and the final `message.completed` share it (docs/behavior-spec.md). */
export const blockMessageId = (eventId: string, index: number): string => `${eventId}:${index}`

/**
 * Map one Managed Agents event to runtime outputs. Pure apart from `state`.
 *
 * What happens to each event type is declared in `MA_EVENT_COVERAGE` (coverage.ts); this function
 * only implements the `mapped` ones. Unknown types become `provider.custom`, never dropped.
 */
export function mapEvent(ev: MAEvent, state: MappingState, opts: MapOptions): ProviderOutput[] {
  const raw = opts.includeRaw ? ev : undefined
  const id = 'id' in ev ? (ev.id as string) : undefined
  const threadId = 'session_thread_id' in ev && ev.session_thread_id ? ev.session_thread_id : undefined
  const event = (e: Record<string, unknown>, sourceId = id): ProviderOutput =>
    ({
      kind: 'event',
      event: { ...e, ...(raw !== undefined ? { raw } : {}), ...(sourceId ? { sourceId } : {}), ...(threadId ? { threadId } : {}) },
    }) as ProviderOutput

  const custom = () => [event({ type: 'provider.custom', data: { name: ev.type, payload: ev } })]
  const handling = maEventHandling(ev.type)
  if (handling === 'ignored') return []
  if (handling === 'custom') return custom()

  switch (ev.type) {
    case 'event_start': {
      // Only remember the kind; message.start is emitted per block on its first delta.
      state.deltaKinds.set(ev.event.id, (MA_DELTA_TYPES as Record<string, 'text' | 'thinking'>)[ev.event.type] ?? 'text')
      return []
    }
    case 'event_delta': {
      const text = ev.delta.content?.text ?? ''
      const kind = state.deltaKinds.get(ev.event_id) ?? 'text'
      const index = ev.delta.index ?? 0
      const messageId = blockMessageId(ev.event_id, index)
      if (kind === 'thinking') state.thinking.set(ev.event_id, (state.thinking.get(ev.event_id) ?? '') + text)
      if (opts.forwardDeltas === false) return []
      const out: ProviderOutput[] = []
      if (!state.startedBlocks.has(messageId)) {
        state.startedBlocks.add(messageId)
        out.push({ kind: 'event', event: { type: 'message.start', data: { messageId, kind } } })
      }
      out.push(
        kind === 'thinking'
          ? { kind: 'event', event: { type: 'thinking.delta', data: { messageId, text } } }
          : { kind: 'event', event: { type: 'text.delta', data: { messageId, text, index } } },
      )
      return out
    }
    case 'agent.message': {
      forgetBlocks(state, ev.id)
      // One message.completed per content block, like every provider (docs/behavior-spec.md).
      return ev.content.map((block, index) =>
        event({ type: 'message.completed', data: { messageId: blockMessageId(ev.id, index), content: [block as ContentBlock] } }, blockMessageId(ev.id, index)),
      )
    }
    case 'agent.thinking': {
      const thinking = state.thinking.get(ev.id) ?? ''
      forgetBlocks(state, ev.id)
      return [
        event(
          { type: 'message.completed', data: { messageId: blockMessageId(ev.id, 0), content: [{ type: 'thinking', thinking }] } },
          blockMessageId(ev.id, 0),
        ),
      ]
    }
    case 'agent.tool_use':
    case 'agent.mcp_tool_use': {
      const isMcp = ev.type === 'agent.mcp_tool_use'
      const out: ProviderOutput[] = [
        event({
          type: 'tool.call',
          data: {
            toolUseId: ev.id,
            name: ev.name,
            input: ev.input,
            kind: isMcp ? 'mcp' : 'builtin',
            ...(isMcp ? { mcpServer: ev.mcp_server_name } : {}),
          },
        }),
      ]
      if (ev.evaluated_permission && (MA_PERMISSIONS as Record<string, string>)[ev.evaluated_permission] === 'approval_request') {
        out.push({ kind: 'approval_request', requestId: ev.id, toolUseId: ev.id, name: ev.name, input: ev.input })
      }
      return out
    }
    case 'agent.custom_tool_use':
      return [
        event({ type: 'tool.call', data: { toolUseId: ev.id, name: ev.name, input: ev.input, kind: 'custom' } }),
        { kind: 'tool_request', requestId: ev.id, toolUseId: ev.id, name: ev.name, input: ev.input },
      ]
    case 'agent.tool_result':
    case 'agent.mcp_tool_result':
      return [
        event({
          type: 'tool.result',
          data: {
            toolUseId: ev.type === 'agent.tool_result' ? ev.tool_use_id : ev.mcp_tool_use_id,
            content: (ev.content ?? []) as ContentBlock[],
            ...(ev.is_error ? { isError: true } : {}),
          },
        }),
      ]
    case 'session.status_running':
      return [event({ type: 'session.status', data: { status: 'running' } })]
    case 'session.status_idle': {
      if (ev.stop_reason.type === 'requires_action') return [event({ type: 'session.status', data: { status: 'requires_action' } })]
      const stopReason: StopReason = (MA_STOP_REASONS as Record<string, StopReason>)[ev.stop_reason.type] ?? ev.stop_reason.type
      // The runtime puts `session.status: idle` in front of turn.completed itself.
      return [{ kind: 'event', event: { type: 'turn.completed', data: { stopReason }, ...(id ? { sourceId: id } : {}), ...(raw !== undefined ? { raw } : {}) } }]
    }
    case 'session.status_terminated':
    case 'session.deleted':
      return [event({ type: 'session.status', data: { status: 'terminated', reason: ev.type } })]
    case 'session.error': {
      const err = ev.error as { type?: string; message?: string; retry_status?: { type?: string } }
      return [
        event({
          type: 'session.error',
          data: { message: err.message ?? 'Unknown error', ...(err.type ? { code: err.type } : {}), retryable: err.retry_status?.type === 'retrying' },
        }),
      ]
    }
    case 'span.model_request_end': {
      const u = ev.model_usage
      return [
        {
          kind: 'usage',
          usage: {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadInputTokens: u.cache_read_input_tokens,
            cacheCreationInputTokens: u.cache_creation_input_tokens,
          },
        },
      ]
    }
    case 'session.usage': {
      // Cumulative list cost in minor units; report the increase since the last snapshot.
      const cost = ev.usage.list_cost
      if (!cost || cost.currency !== 'USD') return []
      const cents = Number(cost.amount)
      if (!Number.isFinite(cents) || cents <= state.lastCostCents) return []
      const delta = cents - state.lastCostCents
      state.lastCostCents = cents
      return [{ kind: 'usage', usage: { costUsd: delta / 100 } }]
    }
    default:
      // Declared `mapped` but not implemented above: keep it rather than lose it (the coverage test catches this).
      return custom()
  }
}

function forgetBlocks(state: MappingState, eventId: string) {
  state.deltaKinds.delete(eventId)
  state.thinking.delete(eventId)
  for (const key of state.startedBlocks) if (key.startsWith(`${eventId}:`)) state.startedBlocks.delete(key)
}

/** Convert runtime content blocks to Managed Agents user message content. */
export const toMAContent = (content: ContentBlock[]) => content as Array<{ type: 'text'; text: string }>
