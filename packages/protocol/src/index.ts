import type { ApprovalDecision, ContentBlock, ProviderEvent, ToolDefinition, ToolResult, TranscriptKey } from '@agent-runtime/core'

/**
 * WebSocket protocol between the caller-side `provider-agentcore` adapter ("client") and the
 * container-side `agentcore-runtime` ("container"). JSON text frames; messages larger than
 * `MAX_FRAME_BYTES` are split into `chunk` frames.
 */
export const PROTOCOL_VERSION = 1

/** AgentCore documents 32KB-64KB frame limits; stay under the lower one. */
export const MAX_FRAME_BYTES = 30 * 1024

export type StoreOp =
  | { op: 'append'; key: TranscriptKey; entries: unknown[] }
  | { op: 'load'; key: TranscriptKey }
  | { op: 'listSubkeys'; key: { projectKey: string; sessionId: string } }
  | { op: 'delete'; key: TranscriptKey }
  | { op: 'has'; sessionId: string }

// ---------------------------------------------------------------- client -> container

export interface HelloMessage {
  type: 'hello'
  protocol: number
  sessionId: string
  /** Boot id from the last `welcome`; replay is only valid within the same boot. */
  bootId?: string
  /** Replay persisted container events with seq greater than this. */
  afterSeq?: number
  /** Driver configuration (model, system prompt, allowed tools, ...). */
  config: unknown
  tools: ToolDefinition[]
  /** Features the caller enabled; the container must not use anything not listed here. */
  features?: { approvalUpdatedInput?: boolean }
}

export type ClientCommand =
  | { type: 'user_message'; id: string; content: ContentBlock[]; system?: ContentBlock[] }
  | { type: 'interrupt'; id: string }
  | { type: 'tool_result'; id: string; requestId: string; result: ToolResult }
  | { type: 'approval_decision'; id: string; requestId: string; decision: ApprovalDecision }
  | { type: 'terminate'; id: string }

export interface StoreResponse {
  type: 'store_response'
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

export type ClientMessage = HelloMessage | ClientCommand | StoreResponse

// ---------------------------------------------------------------- container -> client

export interface WelcomeMessage {
  type: 'welcome'
  protocol: number
  bootId: string
  lastSeq: number
  /** True when this connection created the session in this container (fresh microVM or first use). */
  created: boolean
}

export type ContainerMessage =
  | WelcomeMessage
  /** `seq` is present for replayable events and absent for live-only deltas. */
  | { type: 'event'; seq?: number; event: ProviderEvent }
  | { type: 'tool_request'; requestId: string; toolUseId: string; name: string; input: unknown }
  | { type: 'approval_request'; requestId: string; toolUseId: string; name: string; input: unknown }
  | ({ type: 'store_request'; requestId: string } & StoreOp)
  | { type: 'ack'; id: string; ok: boolean; error?: string }
  | { type: 'error'; message: string }

export interface ChunkFrame {
  type: 'chunk'
  cid: string
  index: number
  total: number
  data: string
}

let chunkCounter = 0

/** Serialize a message into one or more text frames that each fit in `maxBytes`. */
export function encodeFrames(message: ClientMessage | ContainerMessage, maxBytes = MAX_FRAME_BYTES): string[] {
  const json = JSON.stringify(message)
  if (Buffer.byteLength(json) <= maxBytes) return [json]
  // Leave room for the chunk envelope and JSON escaping of the slice.
  const sliceChars = Math.max(256, Math.floor((maxBytes - 200) / 6))
  const parts: string[] = []
  for (let i = 0; i < json.length; i += sliceChars) parts.push(json.slice(i, i + sliceChars))
  const cid = `${process.pid}-${Date.now()}-${chunkCounter++}`
  return parts.map((data, index) => JSON.stringify({ type: 'chunk', cid, index, total: parts.length, data } satisfies ChunkFrame))
}

/** Reassembles chunked frames; returns the decoded message or null while incomplete. */
export class FrameDecoder<T> {
  private partial = new Map<string, { parts: string[]; received: number; at: number }>()

  decode(frame: string): T | null {
    const msg = JSON.parse(frame) as T | ChunkFrame
    if ((msg as ChunkFrame).type !== 'chunk') return msg as T
    const chunk = msg as ChunkFrame
    let entry = this.partial.get(chunk.cid)
    if (!entry) {
      this.gc()
      entry = { parts: new Array(chunk.total), received: 0, at: Date.now() }
      this.partial.set(chunk.cid, entry)
    }
    if (entry.parts[chunk.index] === undefined) entry.received += 1
    entry.parts[chunk.index] = chunk.data
    if (entry.received < chunk.total) return null
    this.partial.delete(chunk.cid)
    return JSON.parse(entry.parts.join('')) as T
  }

  /** Drop partial messages older than a minute (e.g. a sender died mid-message). */
  private gc() {
    const cutoff = Date.now() - 60_000
    for (const [cid, entry] of this.partial) if (entry.at < cutoff) this.partial.delete(cid)
  }
}

/** AgentCore runtime session ids must be 33-256 chars. Derive a stable one from the runtime session id. */
export function runtimeSessionIdFor(sessionId: string): string {
  const id = `agent-runtime-${sessionId}`
  return id.length >= 33 ? id.slice(0, 256) : id.padEnd(33, '0')
}
