import type { ContentBlock, ProviderOutput, StopReason } from '@agent-runtime/core'
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from '@anthropic-ai/sdk/resources/beta/sessions/events'

export type MAEvent = BetaManagedAgentsSessionEvent | BetaManagedAgentsStreamSessionEvents

export interface MappingState {
  /** Delta stream kind per event id, from `event_start`. */
  deltaKinds: Map<string, 'text' | 'thinking'>
  /** Thinking text accumulated from deltas (agent.thinking events carry no content). */
  thinking: Map<string, string>
}

export const newMappingState = (): MappingState => ({ deltaKinds: new Map(), thinking: new Map() })

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end_turn',
  requires_action: 'requires_action',
  retries_exhausted: 'error',
  budget_reached: 'budget',
  refusal: 'refusal',
}

/** Map one Managed Agents event to runtime outputs. Pure apart from `state`. */
export function mapEvent(ev: MAEvent, state: MappingState, opts: { includeRaw: boolean }): ProviderOutput[] {
  const raw = opts.includeRaw ? ev : undefined
  const sourceId = 'id' in ev ? (ev.id as string) : undefined
  const event = (e: Record<string, unknown>): ProviderOutput =>
    ({ kind: 'event', event: { ...e, ...(raw !== undefined ? { raw } : {}), ...(sourceId ? { sourceId } : {}) } }) as ProviderOutput

  switch (ev.type) {
    case 'event_start': {
      const kind = ev.event.type === 'agent.thinking' ? 'thinking' : 'text'
      state.deltaKinds.set(ev.event.id, kind)
      return [{ kind: 'event', event: { type: 'message.start', data: { messageId: ev.event.id, kind } } }]
    }
    case 'event_delta': {
      const text = ev.delta.content?.text ?? ''
      if (state.deltaKinds.get(ev.event_id) === 'thinking') {
        state.thinking.set(ev.event_id, (state.thinking.get(ev.event_id) ?? '') + text)
        return [{ kind: 'event', event: { type: 'thinking.delta', data: { messageId: ev.event_id, text } } }]
      }
      return [
        {
          kind: 'event',
          event: { type: 'text.delta', data: { messageId: ev.event_id, text, ...(ev.delta.index !== undefined ? { index: ev.delta.index } : {}) } },
        },
      ]
    }
    case 'agent.message':
      state.deltaKinds.delete(ev.id)
      return [event({ type: 'message.completed', data: { messageId: ev.id, content: ev.content as ContentBlock[] } })]
    case 'agent.thinking': {
      const thinking = state.thinking.get(ev.id)
      state.thinking.delete(ev.id)
      state.deltaKinds.delete(ev.id)
      return [event({ type: 'message.completed', data: { messageId: ev.id, content: thinking ? [{ type: 'thinking', thinking }] : [] } })]
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
      if (ev.evaluated_permission === 'ask') {
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
      const stopReason = STOP_REASONS[ev.stop_reason.type] ?? ev.stop_reason.type
      return [
        event({ type: 'session.status', data: { status: 'idle', reason: ev.stop_reason.type } }),
        { kind: 'event', event: { type: 'turn.completed', data: { stopReason }, ...(sourceId ? { sourceId: `${sourceId}:turn` } : {}) } },
      ]
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
        event({
          type: 'usage',
          data: {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadInputTokens: u.cache_read_input_tokens,
            cacheCreationInputTokens: u.cache_creation_input_tokens,
          },
        }),
      ]
    }
    // Our own commands are recorded by the runtime; skip their echoes.
    case 'user.message':
    case 'user.interrupt':
    case 'user.custom_tool_result':
    case 'user.tool_confirmation':
    case 'user.tool_result':
      return []
    default:
      return [event({ type: 'provider.custom', data: { name: ev.type, payload: ev } })]
  }
}

/** Convert runtime content blocks to Managed Agents user message content. */
export const toMAContent = (content: ContentBlock[]) => content as Array<{ type: 'text'; text: string }>
