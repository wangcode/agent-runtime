import type { ContentBlock } from './events.js'
import type { ToolDefinition, ToolResult } from './provider.js'

export interface ToolContext {
  sessionId: string
  toolUseId: string
  name: string
  metadata: Record<string, unknown>
  /** Aborted when this instance loses ownership of the session; another instance will retry. */
  signal: AbortSignal
}

/**
 * Server-side handler for a custom tool. Runs on whichever instance owns the session, without
 * any frontend involvement. Handlers may run more than once after a crash, so keep them idempotent.
 */
export interface ToolRegistration<Input = any> {
  description: string
  inputSchema: Record<string, unknown>
  handler: (input: Input, ctx: ToolContext) => Promise<ToolHandlerOutput> | ToolHandlerOutput
}

export type ToolHandlerOutput = string | ToolResult | ContentBlock[] | Record<string, unknown> | null | undefined

export function normalizeToolOutput(out: ToolHandlerOutput): ToolResult {
  if (out === null || out === undefined) return { content: [] }
  if (typeof out === 'string') return { content: [{ type: 'text', text: out }] }
  if (Array.isArray(out)) return { content: out }
  if (Array.isArray((out as ToolResult).content)) {
    const r = out as ToolResult
    return r.isError ? { content: r.content, isError: true } : { content: r.content }
  }
  return { content: [{ type: 'text', text: JSON.stringify(out) }] }
}

export const toolDefinitions = (tools: Record<string, ToolRegistration>): ToolDefinition[] =>
  Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }))

export interface ApprovalRequestInfo {
  sessionId: string
  provider: string
  toolUseId: string
  name: string
  input: unknown
  metadata: Record<string, unknown>
}

export type ApprovalPolicyResult =
  | 'allow'
  | 'deny'
  | 'ask'
  | { decision: 'allow'; message?: string; updatedInput?: Record<string, unknown> }
  | { decision: 'deny'; message?: string }
  | { decision: 'ask'; timeoutMs?: number }

/** Decides tool permissions without a human. Return `'ask'` to wait for `resolveApproval()`. */
export type ApprovalPolicy = (req: ApprovalRequestInfo) => ApprovalPolicyResult | Promise<ApprovalPolicyResult>
