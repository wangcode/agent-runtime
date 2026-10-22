import type { FakeProvider } from '@agent-runtime/core/testing'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Makes a FakeProvider behave like an agent: it streams a reply word by word, and asks
 * permission before a pretend `Bash` call when the message mentions "run".
 */
export function simulateAgent(fake: FakeProvider, opts: { wordDelayMs?: number } = {}) {
  const delay = opts.wordDelayMs ?? 100
  let n = 0
  const approvals = new Map<string, (behavior: string) => void>()
  fake.onApproval = (_sid, requestId, decision) => approvals.get(requestId)?.(decision.behavior)

  fake.onSend = (sid, content) => {
    void (async () => {
      const prompt = content.map((c) => ('text' in c ? c.text : '')).join(' ')
      const messageId = `msg-${++n}`
      const words = `You said "${prompt}".`.split(' ')
      fake.emit(sid, { kind: 'event', event: { type: 'agent.message.start', data: { messageId, kind: 'text' } } })
      for (const word of words) {
        await sleep(delay)
        fake.emit(sid, { kind: 'event', event: { type: 'agent.text.delta', data: { messageId, text: `${word} ` } } })
      }
      fake.emit(sid, { kind: 'event', event: { type: 'agent.message.completed', data: { messageId, content: [{ type: 'text', text: words.join(' ') }] } } })
      if (/\brun\b/i.test(prompt)) {
        const toolUseId = `tool-${n}`
        const decision = new Promise<string>((resolve) => approvals.set(toolUseId, resolve))
        fake.emit(sid, { kind: 'event', event: { type: 'tool.call', data: { toolUseId, name: 'Bash', input: { command: 'ls' }, kind: 'builtin' } } })
        fake.emit(sid, { kind: 'event', event: { type: 'session.status', data: { status: 'requires_action' } } })
        fake.emit(sid, { kind: 'approval_request', requestId: toolUseId, toolUseId, name: 'Bash', input: { command: 'ls' } })
        const behavior = await decision
        fake.emit(sid, { kind: 'event', event: { type: 'session.status', data: { status: 'running' } } })
        if (behavior === 'allow') fake.emit(sid, { kind: 'event', event: { type: 'tool.result', data: { toolUseId, content: [{ type: 'text', text: 'README.md' }] } } })
      }
      fake.emit(sid, { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } })
    })()
  }
}
