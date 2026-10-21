import type { ApprovalDecision, ContentBlock, ProviderEvent, ToolDefinition, ToolResult, TranscriptKey } from '@agent-runtime/core'

/** Transcript storage bridged to the caller's Store over the WebSocket. */
export interface RemoteSessionStore {
  append(key: TranscriptKey, entries: unknown[]): Promise<void>
  load(key: TranscriptKey): Promise<unknown[] | null>
  listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]>
  delete(key: TranscriptKey): Promise<void>
  has(sessionId: string): Promise<boolean>
}

/** What the container gives a driver for one session. */
export interface DriverSession {
  readonly sessionId: string
  readonly config: unknown
  /** Custom tools whose handlers live on the caller side. */
  readonly tools: ToolDefinition[]
  /** Optional behaviour the caller enabled (e.g. approvals that change tool input). */
  readonly features: { approvalUpdatedInput: boolean }
  /** Emit a unified event. Delta types are sent live only; everything else is logged for replay. */
  emit(event: ProviderEvent): void
  /** Ask the caller to run a custom tool. Waits across client reconnects. */
  requestTool(req: { toolUseId: string; name: string; input: unknown }): Promise<ToolResult>
  /** Ask the caller for a permission decision (policy or human). Waits across client reconnects. */
  requestApproval(req: { toolUseId: string; name: string; input: unknown }): Promise<ApprovalDecision>
  readonly sessionStore: RemoteSessionStore
  /** Report whether the agent is working; drives the `/ping` HealthyBusy status. */
  setBusy(busy: boolean): void
}

export interface DriverHandle {
  /** `system`: context to add for this and later turns; the driver decides how its framework carries it. */
  sendMessage(content: ContentBlock[], opts?: { system?: ContentBlock[] }): Promise<void>
  interrupt(): Promise<void>
  close(): Promise<void>
}

/** Pluggable agent implementation hosted by the container (Claude Agent SDK, Mastra, ...). */
export interface AgentDriver {
  start(session: DriverSession): DriverHandle | Promise<DriverHandle>
}
