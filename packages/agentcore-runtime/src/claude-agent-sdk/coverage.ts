import type { SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { StopReason } from '@agent-runtime/core'

/**
 * Coverage tables for the Claude Agent SDK: one entry per value the installed SDK declares. They
 * are checked with `satisfies Record<…>`, so upgrading `@anthropic-ai/claude-agent-sdk` to a
 * version that adds or removes a message type, content block type, stream event or delta type
 * fails `pnpm typecheck` until someone decides how to handle it here. Values only a newer SDK knows
 * about are handled at runtime conservatively: messages become `provider.custom` and content
 * blocks are passed through, never dropped.
 */

/** `type`, or `type/subtype` for messages that have a subtype (e.g. `system/init`, `result/success`). */
type MessageKey<M> = M extends { type: infer T extends string; subtype: infer S extends string }
  ? `${T}/${S}`
  : M extends { type: infer T extends string }
    ? T
    : never

export type SdkMessageKey = MessageKey<SDKMessage>

/**
 * - `mapped`: converted into unified events by `SdkEventMapper`.
 * - `custom`: forwarded as `provider.custom` with the full message.
 * - `ignored`: dropped as noise (internal plumbing, progress ticks, things the runtime derives
 *   itself). `forwardAllMessages: true` forwards these as `provider.custom` too.
 */
export type Handling = 'mapped' | 'custom' | 'ignored'

export const SDK_MESSAGE_COVERAGE = {
  // Conversation.
  user: 'mapped', // tool_result blocks -> tool.result (our own prompts are recorded by the runtime)
  assistant: 'mapped', // content blocks, see SDK_CONTENT_BLOCKS
  stream_event: 'mapped', // deltas, see SDK_STREAM_EVENTS / SDK_DELTAS
  'result/success': 'mapped', // -> session.status idle + turn.completed
  'result/error_during_execution': 'mapped', // + session.error
  'result/error_max_turns': 'mapped',
  'result/error_max_budget_usd': 'mapped',
  'result/error_max_structured_output_retries': 'mapped',

  // Session lifecycle and context.
  'system/init': 'custom',
  'system/status': 'custom',
  'system/compact_boundary': 'custom',
  conversation_reset: 'custom',
  'system/worker_shutting_down': 'custom',
  'system/session_state_changed': 'ignored', // runtime derives session.status itself

  // Reliability.
  'system/api_retry': 'custom',
  rate_limit_event: 'custom',
  'system/model_refusal_fallback': 'custom',
  'system/model_refusal_no_fallback': 'custom',
  'system/mirror_error': 'custom',

  // Permissions and tools.
  'system/permission_denied': 'custom',
  tool_use_summary: 'custom',
  tool_progress: 'ignored', // periodic heartbeat while a tool runs
  'system/elicitation_complete': 'custom',

  // Subagents and background tasks.
  'system/task_started': 'custom',
  'system/task_updated': 'custom',
  'system/task_progress': 'custom',
  'system/task_notification': 'custom',
  'system/background_tasks_changed': 'custom',

  // Informational.
  'system/notification': 'custom',
  'system/informational': 'custom',
  'system/memory_recall': 'custom',
  'system/files_persisted': 'custom',
  'system/local_command_output': 'custom',

  // Internal plumbing: not meaningful to a conversation UI.
  'system/hook_started': 'ignored',
  'system/hook_progress': 'ignored',
  'system/hook_response': 'ignored',
  'system/control_request_progress': 'ignored',
  'system/plugin_install': 'ignored',
  'system/commands_changed': 'ignored',
  'system/thinking_tokens': 'ignored',
  auth_status: 'ignored',
  prompt_suggestion: 'ignored',
} as const satisfies Record<SdkMessageKey, Handling>

export type SdkContentBlockType = SDKAssistantMessage['message']['content'][number]['type']

/**
 * Assistant content blocks:
 * - `message`: emitted as its own `message.completed` (content passed through unchanged).
 * - `tool_call`: emitted as `tool.call`.
 */
export const SDK_CONTENT_BLOCKS = {
  text: 'message',
  thinking: 'message',
  redacted_thinking: 'message',
  compaction: 'message',
  fallback: 'message',
  container_upload: 'message',
  tool_use: 'tool_call',
  server_tool_use: 'tool_call',
  mcp_tool_use: 'tool_call',
  mcp_tool_result: 'message',
  mcp_tool_listing: 'message',
  web_search_tool_result: 'message',
  web_fetch_tool_result: 'message',
  advisor_tool_result: 'message',
  code_execution_tool_result: 'message',
  bash_code_execution_tool_result: 'message',
  text_editor_code_execution_tool_result: 'message',
  tool_search_tool_result: 'message',
} as const satisfies Record<SdkContentBlockType, 'message' | 'tool_call'>

type StreamEvent = SDKPartialAssistantMessage['event']

/** Raw stream events inside `stream_event` messages. Only used for live deltas. */
export const SDK_STREAM_EVENTS = {
  message_start: 'mapped', // remembers the API message id for delta ids
  content_block_start: 'mapped', // -> message.start for text/thinking blocks
  content_block_delta: 'mapped', // see SDK_DELTAS
  content_block_stop: 'ignored',
  message_delta: 'ignored',
  message_stop: 'ignored',
} as const satisfies Record<StreamEvent['type'], 'mapped' | 'ignored'>

export type SdkDeltaType = Extract<StreamEvent, { type: 'content_block_delta' }>['delta']['type']

/** Live deltas. Ignored ones still arrive in full in the final assistant message. */
export const SDK_DELTAS = {
  text_delta: 'text',
  thinking_delta: 'thinking',
  input_json_delta: 'ignored', // tool input, final in tool.call
  citations_delta: 'ignored',
  signature_delta: 'ignored',
  compaction_delta: 'ignored',
} as const satisfies Record<SdkDeltaType, 'text' | 'thinking' | 'ignored'>

/** `result` subtypes -> `turn.completed.stopReason`. */
export const SDK_RESULT_STOP_REASONS = {
  success: 'end_turn',
  error_during_execution: 'error',
  error_max_turns: 'max_turns',
  error_max_budget_usd: 'budget',
  error_max_structured_output_retries: 'error',
} as const satisfies Record<SDKResultMessage['subtype'], StopReason>

/** Coverage key of a runtime message (`type/subtype` when that is a known key, else `type`). */
export function sdkMessageKey(msg: { type: string; subtype?: unknown }): string {
  if (typeof msg.subtype === 'string') {
    const withSubtype = `${msg.type}/${msg.subtype}`
    if (withSubtype in SDK_MESSAGE_COVERAGE || msg.type === 'system' || msg.type === 'result') return withSubtype
  }
  return msg.type
}

export const sdkMessageHandling = (key: string): Handling => (SDK_MESSAGE_COVERAGE as Record<string, Handling>)[key] ?? 'custom'
