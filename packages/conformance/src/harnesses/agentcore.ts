import WebSocket from 'ws'
import { AsyncQueue, deferred } from '@agent-runtime/core'
import { type AgentCoreServer, startAgentCoreServer } from '@agent-runtime/agentcore-runtime'
import { ClaudeAgentSdkDriver, type ClaudeAgentSdkModule } from '@agent-runtime/agentcore-runtime/claude-agent-sdk'
import { AgentCoreProvider } from '@agent-runtime/providers-agentcore'
import type { Harness, ScriptControl } from '../harness.js'

type Msg = Record<string, unknown>
// biome-ignore lint: loosely typed SDK options in the mock
type Options = Record<string, any>

/**
 * Plays scenarios as the Claude Agent SDK would, inside a real agentcore-runtime container server
 * reached over the real WebSocket protocol.
 */
function mockSdk(script: ScriptControl, server: () => AgentCoreServer): ClaudeAgentSdkModule {
  return {
    tool: ((name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler })) as never,
    createSdkMcpServer: ((o: { name: string; tools: unknown[] }) => ({ type: 'sdk', name: o.name, instance: o })) as never,
    query: (({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) => {
      const out = new AsyncQueue<Msg>()
      let interrupted = deferred()
      let counter = 0
      const signal = new AbortController().signal

      const callCustomTool = async (input: Msg) => {
        const toolUseId = `toolu_${++counter}`
        const name = 'mcp__runtime__lookup'
        out.push({ type: 'assistant', uuid: `u${++counter}`, parent_tool_use_id: null, message: { id: `msg_${counter}`, content: [{ type: 'tool_use', id: toolUseId, name, input }] } })
        for (const m of options.hooks.PreToolUse) {
          if (new RegExp(m.matcher).test(name)) for (const h of m.hooks) await h({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: toolUseId }, toolUseId, { signal })
        }
        const lookup = options.mcpServers.runtime.instance.tools.find((t: { name: string }) => t.name === 'lookup')
        const result = await lookup.handler(input, {})
        out.push({ type: 'user', uuid: `u${++counter}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result.content }] } })
      }

      const callApprovalTool = async (name: string, input: Msg) => {
        const toolUseId = `toolu_${++counter}`
        out.push({ type: 'assistant', uuid: `u${++counter}`, parent_tool_use_id: null, message: { id: `msg_${counter}`, content: [{ type: 'tool_use', id: toolUseId, name, input }] } })
        const perm = await options.canUseTool(name, input, { signal, toolUseID: toolUseId })
        out.push({
          type: 'user',
          uuid: `u${++counter}`,
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: perm.behavior === 'allow' ? 'ok' : perm.message, is_error: perm.behavior !== 'allow' }] },
        })
      }

      void (async () => {
        let turn = 0
        for await (const _prompt of prompt) {
          interrupted = deferred()
          const steps = script.turn(turn++)
          const messageId = `msg_turn${turn}`
          let block = 0
          let ended = false
          for (const step of steps) {
            if (step.kind === 'thinking' || step.kind === 'text') {
              const index = block++
              const kind = step.kind
              if (index === 0) out.push({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } })
              out.push({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: kind } } })
              out.push({
                type: 'stream_event',
                event: { type: 'content_block_delta', index, delta: kind === 'text' ? { type: 'text_delta', text: step.text } : { type: 'thinking_delta', thinking: step.text } },
              })
              out.push({
                type: 'assistant',
                uuid: `u${++counter}`,
                parent_tool_use_id: null,
                message: { id: messageId, content: [kind === 'text' ? { type: 'text', text: step.text } : { type: 'thinking', thinking: step.text }] },
              })
            } else if (step.kind === 'custom_tool') {
              await callCustomTool(step.input)
            } else if (step.kind === 'approval_tool') {
              await callApprovalTool(step.name, step.input)
            } else if (step.kind === 'wait_for_interrupt') {
              await interrupted.promise
              out.push({ type: 'result', subtype: 'error_during_execution', uuid: `u${++counter}`, is_error: true, errors: ['Interrupted'] })
              ended = true
            } else if (step.kind === 'drop_connection') {
              // Cut the container <-> caller WebSocket; the container keeps running and replays later.
              const session = server().sessions.get(script.sessionId()) as unknown as { socket?: WebSocket }
              session.socket?.terminate()
            } else if (step.kind === 'end') {
              out.push({
                type: 'result',
                subtype: 'success',
                uuid: `u${++counter}`,
                is_error: false,
                usage: { input_tokens: step.usage.inputTokens, output_tokens: step.usage.outputTokens },
                total_cost_usd: step.usage.costUsd,
              })
              ended = true
            }
          }
          if (!ended) throw new Error('scenario turn without an end')
        }
        out.close()
      })()

      const q = out[Symbol.asyncIterator]() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> }
      q.interrupt = async () => interrupted.resolve()
      return q
    }) as never,
  }
}

export const agentCoreHarness: Harness = {
  name: 'Claude Agent SDK on AgentCore',
  async setup(script) {
    let server!: AgentCoreServer
    server = await startAgentCoreServer({ driver: new ClaudeAgentSdkDriver({ sdk: mockSdk(script, () => server) }), port: 0, host: '127.0.0.1' })
    return {
      provider: new AgentCoreProvider({
        connectWebSocket: () => new WebSocket(`ws://127.0.0.1:${server.port}/ws`),
        reconnect: { baseMs: 10, maxMs: 50 },
        commandTimeoutMs: 5000,
      }),
      cleanup: () => server.close(),
    }
  },
}
