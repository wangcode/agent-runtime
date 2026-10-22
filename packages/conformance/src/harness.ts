import { MemoryBus, MemoryStore, type ProviderAdapter, type Runtime, type RuntimeEvent, createRuntime } from '@agent-runtime/core'
import { lookupResult, type NormalizedEvent, type Scenario, type AgentStep } from './scenarios.js'
import { normalize } from './normalize.js'

/**
 * Plays scenarios against one provider. A harness drives the provider's *native* protocol (a
 * mocked API, a local container, …) so the real adapter code runs; it must not emit unified events
 * itself. A new provider is integrated once its harness passes every scenario.
 */
export interface Harness {
  name: string
  /** Called once per scenario, before the session is created. */
  setup(script: ScriptControl): Promise<{ provider: ProviderAdapter<any>; cleanup: () => Promise<void> }>
}

export interface ScriptControl {
  /** Steps the provider must play when it receives user message number `index` (0-based). */
  turn(index: number): AgentStep[]
  /** The runtime session id, once created (harnesses use it to simulate a dropped connection). */
  sessionId(): string
}

export interface ScenarioResult {
  normalized: NormalizedEvent[]
  /** Everything the subscriber saw, including live deltas. */
  all: RuntimeEvent[]
}

/** Run one scenario end to end through a real runtime and return what a client would see. */
export async function runScenario(harness: Harness, scenario: Scenario, timeoutMs = 10_000): Promise<ScenarioResult> {
  let sessionId = ''
  const { provider, cleanup } = await harness.setup({
    turn: (index) => scenario.turns[index]?.agent ?? [],
    sessionId: () => sessionId,
  })
  const runtime: Runtime = createRuntime({
    store: new MemoryStore(),
    bus: new MemoryBus(),
    providers: { p: provider },
    tools: {
      lookup: { description: 'Look something up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, handler: (i: { q: string }) => lookupResult(i.q) },
    },
    approvals: { policy: () => 'ask' },
    pollIntervalMs: 20,
    reconnect: { baseMs: 10, maxMs: 50 },
  })
  const all: RuntimeEvent[] = []
  try {
    const session = await runtime.createSession({ provider: 'p', config: {} })
    sessionId = session.id
    const abort = new AbortController()
    let completedTurns = 0
    let turnDone: () => void = () => {}
    const consumer = (async () => {
      for await (const e of session.events({ signal: abort.signal })) {
        all.push(e)
        if (e.type === 'approval.requested') {
          const d = scenario.approval ?? { decision: 'allow' as const }
          void session.resolveApproval(e.data.approvalId, d.decision, d.decision === 'deny' ? d.message : undefined)
        }
        if (e.type === 'agent.message.completed' && scenario.interruptAfterText) {
          const text = e.data.content.map((b) => ('text' in b ? b.text : '')).join('')
          if (text === scenario.interruptAfterText) void session.interrupt()
        }
        if (e.type === 'turn.completed') {
          completedTurns += 1
          turnDone()
        }
      }
    })()
    const deadline = setTimeout(() => abort.abort(), timeoutMs)
    for (const [i, turn] of scenario.turns.entries()) {
      const finished = new Promise<void>((resolve) => {
        turnDone = () => completedTurns > i && resolve()
      })
      await session.send(turn.user, turn.system ? { system: turn.system } : {})
      await Promise.race([finished, new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error(`turn ${i} timed out`))))])
    }
    clearTimeout(deadline)
    abort.abort()
    await consumer
    return { normalized: normalize(all), all }
  } finally {
    await runtime.close()
    await cleanup()
  }
}
