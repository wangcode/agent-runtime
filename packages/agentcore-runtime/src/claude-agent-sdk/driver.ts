import { createHash } from 'node:crypto'
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  Options,
  Query,
  SDKUserMessage,
  SessionStore,
  createSdkMcpServer as CreateSdkMcpServer,
  query as QueryFn,
  tool as ToolFn,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { AsyncQueue, type ContentBlock, type ToolResult, errorMessage, newId } from '@agent-runtime/core'
import type { AgentDriver, DriverHandle, DriverSession } from '../driver.js'
import { type SdkMessageLike, SdkEventMapper } from './mapper.js'

export interface ClaudeAgentSdkModule {
  query: typeof QueryFn
  tool: typeof ToolFn
  createSdkMcpServer: typeof CreateSdkMcpServer
}

/** Per-session config sent by the caller in `hello.config`. */
export interface ClaudeAgentSdkSessionConfig {
  /** Shallow-merged over the driver's base options (model, systemPrompt, maxTurns, ...). */
  options?: Partial<Options>
}

export interface ClaudeAgentSdkDriverOptions {
  /** Base SDK options. For Bedrock, set `env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION }`. */
  options?: Options | ((session: DriverSession) => Options | Promise<Options>)
  /** Name of the in-process MCP server exposing caller-side tools. Default `runtime`. */
  mcpServerName?: string
  /** Persist the SDK transcript in the caller's Store so a fresh microVM can resume. Default true. */
  persistTranscript?: boolean
  /** Also forward SDK messages the coverage table marks `ignored` (hooks, progress ticks, …) as `provider.custom`. Default false. */
  forwardAllMessages?: boolean
  /** Inject the SDK (tests). Defaults to a dynamic import of `@anthropic-ai/claude-agent-sdk`. */
  sdk?: ClaudeAgentSdkModule
}

/** The SDK requires UUID session ids; derive a stable one from the runtime session id. */
export function sdkSessionIdFor(sessionId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return sessionId.toLowerCase()
  const h = createHash('sha256').update(sessionId).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`
}

/** Zod raw shape from a JSON Schema object (the SDK's `tool()` takes zod shapes). */
export function jsonSchemaToShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  try {
    const type = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
    if (type instanceof z.ZodObject) return type.shape as Record<string, z.ZodType>
  } catch {
    /* fall through to a permissive shape */
  }
  const props = (schema.properties ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.keys(props).map((k) => [k, z.any()]))
}

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

const toMcpContent = (block: ContentBlock): McpContent => {
  if (block.type === 'text') return { type: 'text', text: (block as { text: string }).text }
  const source = (block as { source?: { type?: string; data?: string; media_type?: string } }).source
  if (block.type === 'image' && source?.type === 'base64' && source.data) return { type: 'image', data: source.data, mimeType: source.media_type ?? 'image/png' }
  return { type: 'text', text: JSON.stringify(block) }
}

/**
 * Runs the Claude Agent SDK in streaming-input mode for one session:
 * - caller-side custom tools are exposed through an in-process MCP server whose handlers round-trip
 *   to the caller (`requestTool`); PreToolUse hooks capture their tool_use ids;
 * - every other permission prompt goes to the caller (`requestApproval`) via `canUseTool`;
 * - the transcript is mirrored to the caller's Store through `sessionStore`, and a session that
 *   already has a transcript is resumed (e.g. after the microVM was recycled).
 */
export class ClaudeAgentSdkDriver implements AgentDriver {
  constructor(private readonly opts: ClaudeAgentSdkDriverOptions = {}) {}

  async start(session: DriverSession): Promise<DriverHandle> {
    const sdk = this.opts.sdk ?? ((await import('@anthropic-ai/claude-agent-sdk')) as unknown as ClaudeAgentSdkModule)
    const serverName = this.opts.mcpServerName ?? 'runtime'
    const prefix = `mcp__${serverName}__`
    const base = typeof this.opts.options === 'function' ? await this.opts.options(session) : (this.opts.options ?? {})
    const sessionConfig = (session.config ?? {}) as ClaudeAgentSdkSessionConfig
    const persist = this.opts.persistTranscript ?? true

    const mapper = new SdkEventMapper((e) => session.emit(e), { customToolPrefix: prefix, forwardAll: this.opts.forwardAllMessages ?? false }, (busy) =>
      session.setBusy(busy),
    )

    // tool_use ids captured by PreToolUse, consumed by the matching MCP handler call.
    const pendingToolUseIds = new Map<string, string[]>()
    const preToolUse: HookCallbackMatcher = {
      matcher: `${prefix}.*`,
      hooks: [
        async (input) => {
          if (input.hook_event_name === 'PreToolUse' && input.tool_name.startsWith(prefix)) {
            const list = pendingToolUseIds.get(input.tool_name) ?? []
            list.push(input.tool_use_id)
            pendingToolUseIds.set(input.tool_name, list)
          }
          return {}
        },
      ],
    }

    const mcpTools = session.tools.map((t) =>
      sdk.tool(t.name, t.description, jsonSchemaToShape(t.inputSchema), async (args) => {
        const toolUseId = pendingToolUseIds.get(prefix + t.name)?.shift() ?? newId()
        mapper.customToolUseIds.add(toolUseId)
        let result: ToolResult
        try {
          result = await session.requestTool({ toolUseId, name: t.name, input: args })
        } catch (err) {
          result = { content: [{ type: 'text', text: errorMessage(err) }], isError: true }
        }
        return { content: result.content.map(toMcpContent), ...(result.isError ? { isError: true } : {}) }
      }),
    )

    const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
      if (toolName.startsWith(prefix)) return { behavior: 'allow', updatedInput: input }
      mapper.setStatus('requires_action')
      try {
        const decision = await session.requestApproval({ toolUseId: toolUseID, name: toolName, input })
        return decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: (session.features.approvalUpdatedInput && decision.updatedInput) || input }
          : { behavior: 'deny', message: decision.message ?? 'Denied by policy' }
      } catch (err) {
        return { behavior: 'deny', message: errorMessage(err) }
      } finally {
        mapper.setStatus('running')
      }
    }

    const sessionStore: SessionStore = {
      append: (key, entries) => session.sessionStore.append(key, entries),
      load: (key) => session.sessionStore.load(key) as ReturnType<SessionStore['load']>,
      listSubkeys: (key) => session.sessionStore.listSubkeys(key),
      delete: (key) => session.sessionStore.delete(key),
    }

    const sdkSessionId = sdkSessionIdFor(session.sessionId)
    const resume = persist ? await session.sessionStore.has(sdkSessionId) : false
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...base.hooks, ...sessionConfig.options?.hooks }
    hooks.PreToolUse = [...(hooks.PreToolUse ?? []), preToolUse]

    const options: Options = {
      ...base,
      ...sessionConfig.options,
      includePartialMessages: true,
      canUseTool,
      hooks,
      mcpServers: {
        ...base.mcpServers,
        ...sessionConfig.options?.mcpServers,
        ...(mcpTools.length ? { [serverName]: sdk.createSdkMcpServer({ name: serverName, version: '1.0.0', tools: mcpTools }) } : {}),
      },
      allowedTools: [...(base.allowedTools ?? []), ...(sessionConfig.options?.allowedTools ?? []), ...session.tools.map((t) => prefix + t.name)],
      ...(persist ? { sessionStore } : {}),
      ...(resume ? { resume: sdkSessionId } : { sessionId: sdkSessionId }),
    }

    const input = new AsyncQueue<SDKUserMessage>()
    const q: Query = sdk.query({ prompt: input, options })
    let closed = false

    void (async () => {
      try {
        for await (const msg of q) mapper.handle(msg as unknown as SdkMessageLike)
      } catch (err) {
        if (!closed) session.emit({ type: 'session.error', data: { message: errorMessage(err), code: 'sdk_error' } })
      } finally {
        mapper.setStatus(closed ? 'terminated' : 'idle')
        session.setBusy(false)
      }
    })()

    return {
      async sendMessage(content, opts) {
        if (closed) throw new Error('session closed')
        mapper.setStatus('running')
        // The SDK has no mid-conversation system role; carry the context as a reminder block, the way
        // Claude Code does. It stays in the transcript, so it applies to later turns too.
        const system = opts?.system?.map((b) => (b.type === 'text' ? String(b.text) : '')).join('\n')
        const blocks = system ? [...content, { type: 'text', text: `<system-reminder>\n${system}\n</system-reminder>` }] : content
        input.push({ type: 'user', message: { role: 'user', content: blocks as never }, parent_tool_use_id: null })
      },
      async interrupt() {
        mapper.interrupted = true
        await q.interrupt()
      },
      async close() {
        closed = true
        input.close()
        await q.interrupt().catch(() => {})
      },
    }
  }
}

export const claudeAgentSdkDriver = (options?: ClaudeAgentSdkDriverOptions): ClaudeAgentSdkDriver => new ClaudeAgentSdkDriver(options)
