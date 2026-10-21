import { describe, expect, it } from 'vitest'
import { type Handling, MA_EVENT_COVERAGE, type MAEventType, mapEvent, newMappingState } from '@agent-runtime/provider-managed-agents'

type MappedType = { [K in MAEventType]: (typeof MA_EVENT_COVERAGE)[K] extends 'mapped' ? K : never }[MAEventType]

const base = { id: 'sevt_1', processed_at: '2026-01-01T00:00:00Z' }

/** One minimal event per `mapped` type; the type forces a fixture for every newly mapped type. */
const MAPPED_FIXTURES: Record<MappedType, Record<string, unknown>> = {
  event_start: { type: 'event_start', event: { id: 'm', type: 'agent.message' } },
  event_delta: { type: 'event_delta', event_id: 'm', delta: { type: 'content_delta', content: { type: 'text', text: 'x' } } },
  'agent.message': { ...base, type: 'agent.message', content: [{ type: 'text', text: 'x' }, { type: 'redacted' }] },
  'agent.thinking': { ...base, type: 'agent.thinking' },
  'agent.tool_use': { ...base, type: 'agent.tool_use', name: 'bash', input: {}, evaluated_permission: 'allow' },
  'agent.mcp_tool_use': { ...base, type: 'agent.mcp_tool_use', name: 'f', mcp_server_name: 's', input: {}, evaluated_permission: 'deny' },
  'agent.custom_tool_use': { ...base, type: 'agent.custom_tool_use', name: 'lookup', input: {} },
  'agent.tool_result': { ...base, type: 'agent.tool_result', tool_use_id: 'tu' },
  'agent.mcp_tool_result': { ...base, type: 'agent.mcp_tool_result', mcp_tool_use_id: 'tu' },
  'session.status_running': { ...base, type: 'session.status_running' },
  'session.status_idle': { ...base, type: 'session.status_idle', stop_reason: { type: 'end_turn' }, stop_details: null },
  'session.status_terminated': { ...base, type: 'session.status_terminated' },
  'session.deleted': { ...base, type: 'session.deleted' },
  'session.error': { ...base, type: 'session.error', error: { type: 'unknown_error', message: 'x' } },
  'span.model_request_end': {
    ...base,
    type: 'span.model_request_end',
    is_error: false,
    model_request_start_id: 's',
    model_usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
}

const run = (ev: Record<string, unknown>) => mapEvent(ev as never, newMappingState(), { includeRaw: false })
const eventTypes = (ev: Record<string, unknown>) => run(ev).flatMap((o) => (o.kind === 'event' ? [o.event.type] : []))

describe('Managed Agents coverage table', () => {
  const entries = Object.entries(MA_EVENT_COVERAGE) as Array<[MAEventType, Handling]>

  it.each(entries.filter(([, h]) => h === 'mapped'))('%s is mapped to unified events', (type) => {
    const types = eventTypes(MAPPED_FIXTURES[type as MappedType])
    expect(types.length).toBeGreaterThan(0)
    expect(types).not.toContain('provider.custom')
  })

  it.each(entries.filter(([, h]) => h === 'custom'))('%s is kept as provider.custom', (type) => {
    expect(run({ ...base, type })).toEqual([{ kind: 'event', event: { type: 'provider.custom', data: { name: type, payload: { ...base, type } }, sourceId: base.id } }])
  })

  it.each(entries.filter(([, h]) => h === 'ignored'))('%s is ignored', (type) => {
    expect(run({ ...base, type })).toEqual([])
  })

  it('keeps event types the SDK does not know yet', () => {
    expect(eventTypes({ ...base, type: 'agent.something_new' })).toEqual(['provider.custom'])
  })

  it('passes unknown stop reasons through instead of dropping them', () => {
    const out = run({ ...base, type: 'session.status_idle', stop_reason: { type: 'brand_new_reason' }, stop_details: null })
    expect(out.at(-1)).toMatchObject({ event: { type: 'turn.completed', data: { stopReason: 'brand_new_reason' } } })
  })

  it('only asks for approval when the permission evaluation is ask', () => {
    for (const [permission, expected] of [['allow', 0], ['deny', 0], ['ask', 1]] as const) {
      const out = run({ ...base, type: 'agent.tool_use', name: 'bash', input: {}, evaluated_permission: permission })
      expect(out.filter((o) => o.kind === 'approval_request')).toHaveLength(expected)
    }
  })
})
