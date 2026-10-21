import type Anthropic from '@anthropic-ai/sdk'
import { AsyncQueue, deferred } from '@agent-runtime/core'
import { ManagedAgentsProvider } from '@agent-runtime/provider-managed-agents'
import type { Harness, ScriptControl } from '../harness.js'

type Ev = Record<string, unknown>

/**
 * Plays scenarios as the Managed Agents API would: SSE stream events (with previews), an events
 * list for catch-up, and user.* events sent back by the provider.
 */
class FakeManagedAgents {
  private streams: AsyncQueue<Ev>[] = []
  private history: Ev[] = []
  private counter = 0
  private turnIndex = 0
  private costCents = 0
  private waiting = new Map<string, (ev: Ev) => void>()
  private interrupted = deferred()

  constructor(private readonly script: ScriptControl) {}

  readonly client = {
    beta: {
      sessions: {
        create: async () => ({ id: 'sesn_conformance' }),
        archive: async () => ({}),
        delete: async () => ({}),
        events: {
          stream: async () => {
            const q = new AsyncQueue<Ev>()
            this.streams.push(q)
            return q
          },
          list: () => {
            const items = [...this.history]
            return (async function* () {
              yield* items
            })()
          },
          send: async (_id: string, params: { events: Ev[] }) => {
            const sys = params.events.findIndex((e) => e.type === 'system.message')
            if (sys !== -1 && (sys !== params.events.length - 1 || params.events[sys - 1]?.type !== 'user.message')) {
              throw new Error('system.message must be the final event, right after a user.message')
            }
            for (const e of params.events) this.onUserEvent(e)
          },
        },
      },
    },
  } as unknown as Anthropic

  private id() {
    return `sevt_${++this.counter}`
  }

  private time() {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, this.counter)).toISOString()
  }

  /** A persisted event: recorded in history and sent live. */
  private emit(type: string, fields: Ev = {}): Ev {
    const ev = { id: this.id(), type, processed_at: this.time(), ...fields }
    this.history.push(ev)
    this.streams.at(-1)?.push(ev)
    return ev
  }

  /** A stream-only preview event. */
  private preview(ev: Ev) {
    this.streams.at(-1)?.push(ev)
  }

  private onUserEvent(e: Ev) {
    if (e.type === 'user.message') {
      const steps = this.script.turn(this.turnIndex++)
      setTimeout(() => void this.play(steps), 1)
    } else if (e.type === 'system.message') {
      this.emit('system.message', { content: e.content }) // Managed Agents records it in the event log
    } else if (e.type === 'user.interrupt') {
      this.interrupted.resolve()
    } else if (e.type === 'user.custom_tool_result') {
      this.waiting.get(e.custom_tool_use_id as string)?.(e)
    } else if (e.type === 'user.tool_confirmation') {
      this.waiting.get(e.tool_use_id as string)?.(e)
    }
  }

  private waitFor(id: string) {
    return new Promise<Ev>((resolve) => this.waiting.set(id, resolve))
  }

  private async play(steps: ReturnType<ScriptControl['turn']>) {
    this.interrupted = deferred()
    this.emit('session.status_running')
    // Consecutive text blocks form one agent.message, as Managed Agents does.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      switch (step.kind) {
        case 'thinking': {
          const id = this.id()
          this.preview({ type: 'event_start', event: { id, type: 'agent.thinking' } })
          this.preview({ type: 'event_delta', event_id: id, delta: { type: 'content_delta', content: { type: 'text', text: step.text } } })
          this.history.push({ id, type: 'agent.thinking', processed_at: this.time() })
          this.streams.at(-1)?.push({ id, type: 'agent.thinking', processed_at: this.time() })
          break
        }
        case 'text': {
          const texts = [step.text]
          while (steps[i + 1]?.kind === 'text') texts.push((steps[++i] as { text: string }).text)
          const id = this.id()
          this.preview({ type: 'event_start', event: { id, type: 'agent.message' } })
          texts.forEach((text, index) => this.preview({ type: 'event_delta', event_id: id, delta: { type: 'content_delta', content: { type: 'text', text }, index } }))
          const ev = { id, type: 'agent.message', processed_at: this.time(), content: texts.map((text) => ({ type: 'text', text })) }
          this.history.push(ev)
          this.streams.at(-1)?.push(ev)
          break
        }
        case 'custom_tool': {
          const call = this.emit('agent.custom_tool_use', { name: 'lookup', input: step.input })
          const result = this.waitFor(call.id as string)
          this.emit('session.status_idle', { stop_reason: { type: 'requires_action', event_ids: [call.id] }, stop_details: null })
          await result
          this.emit('session.status_running')
          break
        }
        case 'approval_tool': {
          const call = this.emit('agent.tool_use', { name: step.name, input: step.input, evaluated_permission: 'ask' })
          const confirmation = this.waitFor(call.id as string)
          this.emit('session.status_idle', { stop_reason: { type: 'requires_action', event_ids: [call.id] }, stop_details: null })
          const decision = await confirmation
          this.emit('session.status_running')
          if (decision.result === 'allow') this.emit('agent.tool_result', { tool_use_id: call.id, content: [{ type: 'text', text: 'ok' }] })
          break
        }
        case 'wait_for_interrupt':
          await this.interrupted.promise
          this.emit('session.status_idle', { stop_reason: { type: 'end_turn' }, stop_details: null })
          return
        case 'drop_connection':
          this.streams.at(-1)?.fail(new Error('connection reset'))
          break
        case 'end':
          this.emit('span.model_request_end', {
            is_error: false,
            model_request_start_id: 'span',
            model_usage: { input_tokens: step.usage.inputTokens, output_tokens: step.usage.outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          })
          this.costCents += Math.round(step.usage.costUsd * 100)
          this.emit('session.usage', { usage: { list_cost: { amount: String(this.costCents), currency: 'USD' } } })
          this.emit('session.status_idle', { stop_reason: { type: 'end_turn' }, stop_details: null })
          break
      }
    }
  }
}

export const managedAgentsHarness: Harness = {
  name: 'Claude Managed Agents',
  async setup(script) {
    const api = new FakeManagedAgents(script)
    return {
      provider: new ManagedAgentsProvider({ client: api.client, reconnect: { baseMs: 10, maxMs: 50 } }),
      cleanup: async () => {},
    }
  },
}
