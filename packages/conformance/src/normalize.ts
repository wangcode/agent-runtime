import type { RuntimeEvent } from '@agent-runtime/core'
import type { NormalizedEvent } from './scenarios.js'

/**
 * Known, accepted divergences between providers, removed before comparing. Each one must be
 * listed in docs/behavior-spec.md under "Open questions".
 *
 * - `session.status: requires_action`: Managed Agents also reports it while a custom tool runs;
 *   the Agent SDK only while a human approval is pending. Its semantics are still open.
 */
const DIVERGENT_STATUSES = new Set(['requires_action'])

/**
 * Make persisted events comparable across providers: keep type/data/threadId, drop transport
 * fields, replace provider ids with placeholders in order of appearance, and drop zero usage
 * counters (providers differ in which zero fields they report).
 */
export function normalize(events: RuntimeEvent[]): NormalizedEvent[] {
  const ids = { messageId: new Map<string, string>(), toolUseId: new Map<string, string>(), approvalId: new Map<string, string>() }
  const prefix = { messageId: 'm', toolUseId: 't', approvalId: 'a' } as const
  const placeholder = (kind: keyof typeof ids, id: string) => {
    const map = ids[kind]
    if (!map.has(id)) map.set(id, `${prefix[kind]}${map.size + 1}`)
    return map.get(id) as string
  }

  const out: NormalizedEvent[] = []
  let lastStatus: string | undefined
  for (const e of events) {
    if (e.ephemeral) continue
    if (e.type === 'session.created') {
      out.push({ type: e.type })
      continue
    }
    if (e.type === 'session.status') {
      if (DIVERGENT_STATUSES.has(e.data.status) || e.data.status === lastStatus) continue
      lastStatus = e.data.status
    }
    const data = structuredClone(e.data) as Record<string, unknown>
    for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
      if (typeof data[key] === 'string') data[key] = placeholder(key, data[key] as string)
    }
    delete data.expiresAt
    if (e.type === 'runtime.turn.completed' && data.usage) {
      const usage = Object.fromEntries(Object.entries(data.usage as Record<string, number>).filter(([, v]) => v !== 0))
      if (Object.keys(usage).length) data.usage = usage
      else delete data.usage
    }
    out.push({ type: e.type, data, ...(e.threadId ? { threadId: e.threadId } : {}) })
  }
  return out
}

/**
 * Live-delta rules that hold regardless of timing: every delta follows a `agent.message.start` with the
 * same messageId, and (when nothing was lost) belongs to a block that later completed.
 */
export function deltaViolations(events: RuntimeEvent[], opts: { requireCompletion: boolean }): string[] {
  const started = new Set<string>()
  const completed = new Set(events.filter((e) => e.type === 'agent.message.completed').map((e) => (e.data as { messageId: string }).messageId))
  const problems: string[] = []
  for (const e of events) {
    if (e.type === 'agent.message.start') started.add(e.data.messageId)
    if (e.type === 'agent.text.delta' || e.type === 'agent.thinking.delta') {
      if (!started.has(e.data.messageId)) problems.push(`${e.type} for ${e.data.messageId} before agent.message.start`)
      if (opts.requireCompletion && !completed.has(e.data.messageId)) problems.push(`${e.type} for ${e.data.messageId} never completed`)
    }
  }
  return problems
}
