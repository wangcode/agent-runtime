/**
 * Provider-neutral conversation scripts. Each harness plays these steps in its provider's native
 * format; the runtime must turn every provider's traffic into the same unified events.
 */

export type AgentStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  /** The agent calls a runtime custom tool (`lookup`) and waits for its result. */
  | { kind: 'custom_tool'; input: { q: string } }
  /** The agent calls a built-in tool that needs a permission decision; on allow the tool returns `ok`. */
  | { kind: 'approval_tool'; name: string; input: Record<string, unknown> }
  /** The agent keeps working until the user interrupts. */
  | { kind: 'wait_for_interrupt' }
  /** The provider connection drops; the steps after it happen while the runtime reconnects. */
  | { kind: 'drop_connection' }
  /** The turn ends normally with this usage. */
  | { kind: 'end'; usage: { inputTokens: number; outputTokens: number; costUsd: number } }

export interface Turn {
  user: string
  /** Sent as `send(user, { system })`. */
  system?: string
  agent: AgentStep[]
}

export interface Scenario {
  name: string
  turns: Turn[]
  /** How the test answers approval requests. */
  approval?: { decision: 'allow' } | { decision: 'deny'; message: string }
  /** Interrupt once a agent.message.completed with this text is seen. */
  interruptAfterText?: string
}

const usage = { inputTokens: 10, outputTokens: 5, costUsd: 0.02 }

export const SCENARIOS: Scenario[] = [
  {
    name: 'plain reply with thinking and two text blocks',
    turns: [
      {
        user: 'hello',
        agent: [
          { kind: 'thinking', text: 'The user greets me.' },
          { kind: 'text', text: 'Hello!' },
          { kind: 'text', text: 'How can I help?' },
          { kind: 'end', usage },
        ],
      },
    ],
  },
  {
    name: 'custom tool round-trip',
    turns: [{ user: 'find x', agent: [{ kind: 'custom_tool', input: { q: 'x' } }, { kind: 'text', text: 'Found it.' }, { kind: 'end', usage }] }],
  },
  {
    name: 'approval allowed',
    approval: { decision: 'allow' },
    turns: [{ user: 'list files', agent: [{ kind: 'approval_tool', name: 'Bash', input: { command: 'ls' } }, { kind: 'text', text: 'Done.' }, { kind: 'end', usage }] }],
  },
  {
    name: 'approval denied',
    approval: { decision: 'deny', message: 'Not allowed here.' },
    turns: [
      { user: 'delete files', agent: [{ kind: 'approval_tool', name: 'Bash', input: { command: 'rm -rf /' } }, { kind: 'text', text: 'Okay, I will not.' }, { kind: 'end', usage }] },
    ],
  },
  {
    name: 'interrupt mid-turn',
    interruptAfterText: 'Working on it...',
    turns: [{ user: 'long task', agent: [{ kind: 'text', text: 'Working on it...' }, { kind: 'wait_for_interrupt' }] }],
  },
  {
    name: 'provider connection drops mid-turn',
    turns: [
      {
        user: 'hi',
        agent: [{ kind: 'text', text: 'Before the drop.' }, { kind: 'drop_connection' }, { kind: 'text', text: 'After the drop.' }, { kind: 'end', usage }],
      },
    ],
  },
  {
    name: 'multi-turn conversation',
    turns: [
      { user: 'one', agent: [{ kind: 'text', text: 'First answer.' }, { kind: 'end', usage }] },
      { user: 'two', agent: [{ kind: 'text', text: 'Second answer.' }, { kind: 'end', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.03 } }] },
    ],
  },
  {
    name: 'send with system context',
    turns: [{ user: 'hi', system: 'Answer in French.', agent: [{ kind: 'text', text: 'Bonjour !' }, { kind: 'end', usage }] }],
  },
]

/** The custom tool every harness registers. */
export const lookupResult = (q: string) => `result:${q}`

export interface NormalizedEvent {
  type: string
  data?: unknown
  threadId?: string
}

/** The unified, persisted event sequence the spec requires for a scenario (ids as placeholders). */
export function expectedEvents(scenario: Scenario): NormalizedEvent[] {
  const out: NormalizedEvent[] = [{ type: 'session.created' }]
  let m = 0
  let t = 0
  let a = 0
  for (const turn of scenario.turns) {
    const content = [{ type: 'text', text: turn.user }]
    out.push(
      { type: 'user.message', data: turn.system ? { content, system: [{ type: 'text', text: turn.system }] } : { content } },
      { type: 'session.status', data: { status: 'running' } },
    )
    let interrupted = false
    for (const step of turn.agent) {
      switch (step.kind) {
        case 'thinking':
          out.push({ type: 'agent.message.completed', data: { messageId: `m${++m}`, content: [{ type: 'thinking', thinking: step.text }] } })
          break
        case 'text':
          out.push({ type: 'agent.message.completed', data: { messageId: `m${++m}`, content: [{ type: 'text', text: step.text }] } })
          break
        case 'custom_tool': {
          const id = `t${++t}`
          out.push(
            { type: 'tool.call', data: { toolUseId: id, name: 'lookup', input: step.input, kind: 'custom' } },
            { type: 'tool.result', data: { toolUseId: id, content: [{ type: 'text', text: lookupResult(step.input.q) }] } },
          )
          break
        }
        case 'approval_tool': {
          const id = `t${++t}`
          const approvalId = `a${++a}`
          const decision = scenario.approval ?? { decision: 'allow' }
          out.push(
            { type: 'tool.call', data: { toolUseId: id, name: step.name, input: step.input, kind: 'builtin' } },
            { type: 'approval.requested', data: { approvalId, toolUseId: id, name: step.name, input: step.input } },
          )
          if (decision.decision === 'allow') {
            out.push(
              { type: 'approval.resolved', data: { approvalId, toolUseId: id, decision: 'allow', by: 'user' } },
              { type: 'tool.result', data: { toolUseId: id, content: [{ type: 'text', text: 'ok' }] } },
            )
          } else {
            out.push(
              { type: 'approval.resolved', data: { approvalId, toolUseId: id, decision: 'deny', by: 'user', message: decision.message } },
              { type: 'tool.result', data: { toolUseId: id, content: [{ type: 'text', text: decision.message }], isError: true } },
            )
          }
          break
        }
        case 'wait_for_interrupt':
          interrupted = true
          break
        case 'drop_connection':
          break
        case 'end':
          out.push({ type: 'session.status', data: { status: 'idle' } }, { type: 'turn.completed', data: { stopReason: 'end_turn', usage: step.usage } })
          break
      }
    }
    if (interrupted) out.push({ type: 'session.status', data: { status: 'idle' } }, { type: 'turn.completed', data: { stopReason: 'interrupted' } })
  }
  return out
}
