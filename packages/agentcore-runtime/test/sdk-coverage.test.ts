import { describe, expect, it } from 'vitest'
import type { ProviderEvent } from '@agent-runtime/core'
import {
  type Handling,
  SDK_CONTENT_BLOCKS,
  SDK_DELTAS,
  SDK_MESSAGE_COVERAGE,
  type SdkMessageKey,
  SdkEventMapper,
} from '@agent-runtime/agentcore-runtime/claude-agent-sdk'

type MappedKey = { [K in SdkMessageKey]: (typeof SDK_MESSAGE_COVERAGE)[K] extends 'mapped' ? K : never }[SdkMessageKey]

/** One minimal message per `mapped` key; the type forces a fixture for every newly mapped key. */
const MAPPED_FIXTURES: Record<MappedKey, Record<string, unknown>> = {
  user: { type: 'user', uuid: 'u', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
  assistant: { type: 'assistant', uuid: 'a', message: { id: 'msg', content: [{ type: 'text', text: 'hi' }] } },
  stream_event: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'h' } } },
  'result/success': { type: 'result', subtype: 'success', uuid: 'r', is_error: false },
  'result/error_during_execution': { type: 'result', subtype: 'error_during_execution', uuid: 'r', is_error: true, errors: ['boom'] },
  'result/error_max_turns': { type: 'result', subtype: 'error_max_turns', uuid: 'r', is_error: true },
  'result/error_max_budget_usd': { type: 'result', subtype: 'error_max_budget_usd', uuid: 'r', is_error: true },
  'result/error_max_structured_output_retries': { type: 'result', subtype: 'error_max_structured_output_retries', uuid: 'r', is_error: true },
}

function run(msg: Record<string, unknown>, opts: { forwardAll?: boolean } = {}) {
  const events: ProviderEvent[] = []
  new SdkEventMapper((e) => events.push(e), { customToolPrefix: 'mcp__runtime__', ...opts }).handle(msg as never)
  // Status changes are bookkeeping; look at the content events.
  return events.filter((e) => e.type !== 'session.status')
}

/** Build a message for a coverage key like `system/init` or `tool_progress`. */
const messageFor = (key: string) => {
  const [type, subtype] = key.split('/')
  return { type, ...(subtype ? { subtype } : {}), uuid: `uuid-${key}` }
}

describe('Claude Agent SDK coverage table', () => {
  const entries = Object.entries(SDK_MESSAGE_COVERAGE) as Array<[SdkMessageKey, Handling]>

  it.each(entries.filter(([, h]) => h === 'mapped'))('%s is mapped to unified events', (key) => {
    const types = run(MAPPED_FIXTURES[key as MappedKey]).map((e) => e.type)
    expect(types.length).toBeGreaterThan(0)
    expect(types).not.toContain('provider.custom')
  })

  it.each(entries.filter(([, h]) => h === 'custom'))('%s is forwarded as provider.custom', (key) => {
    expect(run(messageFor(key))).toEqual([{ type: 'provider.custom', data: { name: key, payload: messageFor(key) }, sourceId: `uuid-${key}` }])
  })

  it.each(entries.filter(([, h]) => h === 'ignored'))('%s is ignored unless forwardAll is set', (key) => {
    expect(run(messageFor(key))).toEqual([])
    expect(run(messageFor(key), { forwardAll: true }).map((e) => e.type)).toEqual(['provider.custom'])
  })

  it.each(Object.entries(SDK_CONTENT_BLOCKS))('assistant block %s is kept as %s', (blockType, handling) => {
    const block = { type: blockType, id: 'toolu_1', name: 'Bash', input: {} }
    const events = run({ type: 'assistant', uuid: 'a', message: { id: 'msg', content: [block] } })
    expect(events.map((e) => e.type)).toEqual([handling === 'tool_call' ? 'tool.call' : 'agent.message.completed'])
    if (handling === 'message') expect(events[0]).toMatchObject({ data: { content: [block] } })
  })

  it.each(Object.entries(SDK_DELTAS))('delta %s -> %s', (deltaType, kind) => {
    const events = run({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: deltaType, text: 'x', thinking: 'x' } } })
    expect(events.map((e) => e.type)).toEqual(kind === 'ignored' ? [] : [`agent.${kind}.delta`])
  })

  it('keeps what a newer SDK might send', () => {
    // unknown message type and unknown system subtype -> provider.custom
    expect(run({ type: 'brand_new', uuid: 'x' }).map((e) => e.type)).toEqual(['provider.custom'])
    expect(run({ type: 'system', subtype: 'brand_new', uuid: 'x' })).toMatchObject([{ type: 'provider.custom', data: { name: 'system/brand_new' } }])
    // unknown content block -> passed through
    expect(run({ type: 'assistant', uuid: 'a', message: { id: 'm', content: [{ type: 'hologram', data: 1 }] } })).toMatchObject([
      { type: 'agent.message.completed', data: { content: [{ type: 'hologram', data: 1 }] } },
    ])
    // unknown result subtype still ends the turn
    expect(run({ type: 'result', subtype: 'error_brand_new', uuid: 'r', is_error: true, errors: ['x'] }).map((e) => e.type)).toEqual([
      'session.error',
      'runtime.turn.completed',
    ])
  })

  it('attributes subagent messages to their thread', () => {
    const events = run({ type: 'assistant', uuid: 'a', parent_tool_use_id: 'toolu_task', message: { id: 'm', content: [{ type: 'text', text: 'sub' }] } })
    expect(events).toMatchObject([{ type: 'agent.message.completed', threadId: 'toolu_task' }])
    expect(run({ type: 'assistant', uuid: 'b', parent_tool_use_id: null, message: { id: 'n', content: [{ type: 'text', text: 'main' }] } })[0]?.threadId).toBeUndefined()
  })
})
