import type { StopReason } from '@agent-runtime/core'
import type {
  BetaManagedAgentsAgentEvaluatedPermission,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsStreamSessionEvents,
} from '@anthropic-ai/sdk/resources/beta/sessions/events'
import type { BetaManagedAgentsDeltaType } from '@anthropic-ai/sdk/resources/beta/sessions/sessions'

/**
 * Coverage tables: one entry per value the Anthropic SDK declares. They are checked with
 * `satisfies Record<…>`, so upgrading `@anthropic-ai/sdk` to a version that adds (or removes) an
 * event type, stop reason, permission value or delta type fails `pnpm typecheck` until someone
 * decides how to handle it here. Values the SDK does not know yet (an API newer than the SDK) are
 * handled at runtime as `custom`, never dropped.
 */

export type MAEvent = BetaManagedAgentsSessionEvent | BetaManagedAgentsStreamSessionEvents
export type MAEventType = MAEvent['type']

/**
 * - `mapped`: converted into unified events by `mapEvent`.
 * - `custom`: persisted as `provider.custom` with the full payload.
 * - `ignored`: dropped (only for echoes of what the runtime itself sent and records on its own).
 */
export type Handling = 'mapped' | 'custom' | 'ignored'

export const MA_EVENT_COVERAGE = {
  // Stream-only previews (never persisted by Managed Agents either).
  event_start: 'mapped', // -> agent.message.start
  event_delta: 'mapped', // -> agent.text.delta / agent.thinking.delta

  // User events: echoes of runtime commands, which the runtime records itself.
  'user.message': 'ignored', // runtime writes user.message
  'user.interrupt': 'ignored',
  'user.custom_tool_result': 'ignored', // runtime writes tool.result
  'user.tool_confirmation': 'ignored', // runtime writes approval.resolved
  'user.tool_result': 'ignored', // self-hosted environments only
  'user.define_outcome': 'custom', // not sent by the runtime
  'system.message': 'ignored', // echo of send(…, { system }); recorded on user.message

  // Agent events.
  'agent.message': 'mapped', // -> agent.message.completed
  'agent.thinking': 'mapped', // -> agent.message.completed (thinking block from deltas)
  'agent.tool_use': 'mapped', // -> tool.call (+ approval request when evaluated_permission = ask)
  'agent.mcp_tool_use': 'mapped', // -> tool.call kind=mcp (+ approval request)
  'agent.custom_tool_use': 'mapped', // -> tool.call kind=custom + tool request
  'agent.tool_result': 'mapped', // -> tool.result
  'agent.mcp_tool_result': 'mapped', // -> tool.result
  'agent.thread_context_compacted': 'custom',
  'agent.thread_message_received': 'custom',
  'agent.thread_message_sent': 'custom',

  // Session status and lifecycle.
  'session.status_running': 'mapped', // -> session.status running
  'session.status_idle': 'mapped', // -> session.status (+ turn.completed)
  'session.status_terminated': 'mapped', // -> session.status terminated
  'session.deleted': 'mapped', // -> session.status terminated
  'session.status_rescheduled': 'custom',
  'session.error': 'mapped', // -> session.error
  'session.updated': 'custom',
  'session.usage': 'mapped', // cumulative cost -> per-turn costUsd

  // Multi-agent threads.
  'session.thread_created': 'custom',
  'session.thread_status_running': 'custom',
  'session.thread_status_idle': 'custom',
  'session.thread_status_rescheduled': 'custom',
  'session.thread_status_terminated': 'custom',

  // Spans.
  'span.model_request_start': 'custom',
  'span.model_request_end': 'mapped', // -> per-turn usage on turn.completed
  'span.outcome_evaluation_start': 'custom',
  'span.outcome_evaluation_ongoing': 'custom',
  'span.outcome_evaluation_end': 'custom',

  // Dynamic workflows.
  'workflow_run.created': 'custom',
  'workflow_run.status_running': 'custom',
  'workflow_run.status_idle': 'custom',
  'workflow_run.status_ended': 'custom',
  'workflow_run.error': 'custom',
  'workflow_run.phase_started': 'custom',
  'workflow_run.phase_ended': 'custom',
} as const satisfies Record<MAEventType, Handling>

export type MAIdleStopReason = BetaManagedAgentsSessionStatusIdleEvent['stop_reason']['type']

/** `session.status_idle` stop reasons. `requires_action` keeps the turn open; everything else ends it. */
export const MA_STOP_REASONS = {
  end_turn: 'end_turn',
  requires_action: 'requires_action',
  retries_exhausted: 'error',
  budget_reached: 'budget',
  refusal: 'refusal',
} as const satisfies Record<MAIdleStopReason, StopReason>

/** `evaluated_permission` on tool use events: only `ask` waits for a decision from us. */
export const MA_PERMISSIONS = {
  allow: 'none',
  deny: 'none',
  ask: 'approval_request',
} as const satisfies Record<BetaManagedAgentsAgentEvaluatedPermission, 'none' | 'approval_request'>

/** Which delta stream each previewed event type feeds. */
export const MA_DELTA_TYPES = {
  'agent.message': 'text',
  'agent.thinking': 'thinking',
} as const satisfies Record<BetaManagedAgentsDeltaType, 'text' | 'thinking'>

export type MAMessageBlockType = BetaManagedAgentsAgentMessageEvent['content'][number]['type']

/** `agent.message` content blocks; all are passed through into `agent.message.completed`. */
export const MA_MESSAGE_BLOCKS = {
  text: 'content',
  redacted: 'content',
} as const satisfies Record<MAMessageBlockType, 'content'>

export const maEventHandling = (type: string): Handling => (MA_EVENT_COVERAGE as Record<string, Handling>)[type] ?? 'custom'
