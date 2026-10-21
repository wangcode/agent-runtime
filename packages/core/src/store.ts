import type { EventType, PersistedEvent, SessionStatus } from './events.js'
import type { ApprovalDecision, ToolResult } from './provider.js'

export interface SessionRecord {
  id: string
  provider: string
  providerSessionId: string
  config: unknown
  metadata: Record<string, unknown>
  status: SessionStatus
  providerCursor: unknown
  ownerInstance: string | null
  leaseExpiresAt: Date | null
  lastSeq: number
  createdAt: Date
  updatedAt: Date
}

export interface NewEvent {
  type: EventType
  data: unknown
  raw?: unknown
  sourceId?: string
  provider?: string
}

export type CommandKind = 'send' | 'interrupt' | 'resolve_approval' | 'terminate'

export interface CommandRecord {
  id: string
  sessionId: string
  kind: CommandKind
  payload: unknown
  status: 'pending' | 'done' | 'failed'
  error?: string
  createdAt: Date
}

export type ActionKind = 'tool' | 'approval'
export type ActionStatus = 'pending' | 'resolved' | 'cancelled'

/** A tool call or approval the provider is waiting on. */
export interface ActionRecord {
  id: string
  sessionId: string
  kind: ActionKind
  /** Provider-side id used to answer the request. */
  requestId: string
  toolUseId: string
  name: string
  input: unknown
  status: ActionStatus
  /** ToolResult for tools, ApprovalDecision for approvals. */
  result?: ToolResult | ApprovalDecision
  resolvedBy?: 'user' | 'policy' | 'timeout' | 'system' | 'handler'
  /** Whether the result reached the provider. Undelivered results are re-sent on takeover. */
  delivered: boolean
  expiresAt: Date | null
  createdAt: Date
}

export interface TranscriptKey {
  projectKey: string
  sessionId: string
  subpath?: string
}

export interface Store {
  createSession(input: Omit<SessionRecord, 'ownerInstance' | 'leaseExpiresAt' | 'lastSeq' | 'createdAt' | 'updatedAt'>): Promise<SessionRecord>
  getSession(id: string): Promise<SessionRecord | null>
  updateSession(id: string, patch: Partial<Pick<SessionRecord, 'status' | 'providerCursor' | 'providerSessionId'>>): Promise<void>

  /** Take or extend the lease if it is free, expired, or already ours. */
  tryAcquireLease(id: string, instanceId: string, ttlMs: number): Promise<boolean>
  /** Extend a lease we hold. Returns false if it was lost. */
  renewLease(id: string, instanceId: string, ttlMs: number): Promise<boolean>
  releaseLease(id: string, instanceId: string): Promise<void>
  /** Sessions that need an owner (busy, pending commands/actions) whose lease is free or expired. */
  findOrphans(limit: number): Promise<string[]>

  /** Append with the next seq. Returns null when `sourceId` was already persisted for the session. */
  appendEvent(sessionId: string, event: NewEvent): Promise<PersistedEvent | null>
  readEvents(sessionId: string, afterSeq: number, limit: number): Promise<PersistedEvent[]>

  enqueueCommand(input: { id: string; sessionId: string; kind: CommandKind; payload: unknown }): Promise<CommandRecord>
  pendingCommands(sessionId: string): Promise<CommandRecord[]>
  getCommand(id: string): Promise<CommandRecord | null>
  finishCommand(id: string, outcome: { status: 'done' | 'failed'; error?: string }): Promise<void>

  /** Insert an action; returns the existing one if (sessionId, kind, requestId) is already known. */
  upsertAction(input: Omit<ActionRecord, 'status' | 'delivered' | 'createdAt' | 'result' | 'resolvedBy'>): Promise<{ action: ActionRecord; created: boolean }>
  getAction(id: string): Promise<ActionRecord | null>
  listActions(sessionId: string, filter?: { status?: ActionStatus; kind?: ActionKind }): Promise<ActionRecord[]>
  /** Compare-and-set pending -> resolved/cancelled. Returns false if it was no longer pending. */
  resolveAction(id: string, outcome: { status: 'resolved' | 'cancelled'; result?: ActionRecord['result']; resolvedBy: NonNullable<ActionRecord['resolvedBy']> }): Promise<boolean>
  markActionDelivered(id: string): Promise<void>

  /** Agent SDK transcript persistence (AgentCore sessionStore bridge). */
  appendTranscript(key: TranscriptKey, entries: unknown[]): Promise<void>
  loadTranscript(key: TranscriptKey): Promise<unknown[] | null>
  listTranscriptSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]>
  deleteTranscript(key: TranscriptKey): Promise<void>
  /** Whether any transcript entries exist for this agent session id (under any project key). */
  hasTranscript(sessionId: string): Promise<boolean>
}

export type TranscriptStore = Pick<Store, 'appendTranscript' | 'loadTranscript' | 'listTranscriptSubkeys' | 'deleteTranscript' | 'hasTranscript'>

/** Cross-instance notifications. Topics are plain strings; payloads must stay under ~7KB. */
export interface Bus {
  publish(topic: string, payload: string): Promise<void>
  subscribe(topic: string, handler: (payload: string) => void): () => void
}

export const topics = {
  events: (sessionId: string) => `ev:${sessionId}`,
  ephemeral: (sessionId: string) => `eph:${sessionId}`,
  commands: (sessionId: string) => `cmd:${sessionId}`,
  commandDone: (sessionId: string) => `cmd_done:${sessionId}`,
}
