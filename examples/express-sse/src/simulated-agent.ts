import type { FakeProvider } from '@agent-runtime/core/testing'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Makes a FakeProvider behave like a slow agent: it streams a reply word by word, calls the
 * `get_time` custom tool, and asks permission before a pretend `Bash` call.
 */
export function simulateAgent(fake: FakeProvider, opts: { wordDelayMs?: number } = {}) {
  const delay = opts.wordDelayMs ?? 150
  let turn = 0
  const pendingTools = new Map<string, (text: string) => void>()

  fake.onToolResult = (_sid, requestId, result) => pendingTools.get(requestId)?.(JSON.stringify(result.content))
  fake.onApproval = (_sid, requestId, decision) => pendingTools.get(requestId)?.(decision.behavior)

  const ask = (sid: string, kind: 'tool_request' | 'approval_request', name: string, input: unknown) =>
    new Promise<string>((resolve) => {
      const requestId = `${kind}-${++turn}`
      pendingTools.set(requestId, resolve)
      fake.emit(sid, { kind: 'event', event: { type: 'tool.call', data: { toolUseId: requestId, name, input, kind: kind === 'tool_request' ? 'custom' : 'builtin' } } })
      fake.emit(sid, { kind, requestId, toolUseId: requestId, name, input })
    })

  fake.onSend = (sid, content) => {
    void (async () => {
      const prompt = content.map((c) => ('text' in c ? c.text : '')).join(' ')
      const messageId = `msg-${++turn}`
      fake.emit(sid, { kind: 'event', event: { type: 'session.status', data: { status: 'running' } } })
      const now = await ask(sid, 'tool_request', 'get_time', {})
      const words = `You said "${prompt}". The time is ${now}.`.split(' ')
      fake.emit(sid, { kind: 'event', event: { type: 'agent.message.start', data: { messageId, kind: 'text' } } })
      for (const word of words) {
        await sleep(delay)
        fake.emit(sid, { kind: 'event', event: { type: 'agent.text.delta', data: { messageId, text: `${word} ` } } })
      }
      fake.emit(sid, { kind: 'event', event: { type: 'agent.message.completed', data: { messageId, content: [{ type: 'text', text: words.join(' ') }] } } })
      if (/run|bash|shell/i.test(prompt)) {
        fake.emit(sid, { kind: 'event', event: { type: 'session.status', data: { status: 'requires_action' } } })
        const decision = await ask(sid, 'approval_request', 'Bash', { command: 'ls -la' })
        fake.emit(sid, { kind: 'event', event: { type: 'session.status', data: { status: 'running' } } })
        const text = decision === 'allow' ? 'Ran `ls -la`.' : 'Okay, I will not run it.'
        fake.emit(sid, { kind: 'event', event: { type: 'agent.message.completed', data: { messageId: `${messageId}-b`, content: [{ type: 'text', text }] } } })
      }
      fake.emit(sid, { kind: 'event', event: { type: 'session.status', data: { status: 'idle' } } })
      fake.emit(sid, { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } })
    })()
  }
}
