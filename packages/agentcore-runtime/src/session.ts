import type WebSocket from 'ws'
import {
  type ApprovalDecision,
  type ProviderEvent,
  type ToolDefinition,
  type ToolResult,
  errorMessage,
  isEphemeralType,
  newId,
} from '@agent-runtime/core'
import { type ClientCommand, type ContainerMessage, type HelloMessage, PROTOCOL_VERSION, type StoreOp, type StoreResponse, encodeFrames } from '@agent-runtime/protocol'
import type { AgentDriver, DriverHandle, DriverSession, RemoteSessionStore } from './driver.js'

interface Outstanding {
  message: ContainerMessage
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

export interface ContainerSessionOptions {
  bootId: string
  maxLogEvents: number
  onHealthChange: () => void
}

/**
 * One agent session inside the container. Keeps a replay log of events, the set of requests the
 * driver is waiting on, and the currently attached client socket (at most one; a reconnect
 * replaces it). Everything survives client disconnects for as long as the microVM lives.
 */
export class ContainerSession {
  private seq = 0
  private log: Array<{ seq: number; event: ProviderEvent }> = []
  private socket: WebSocket | undefined
  private outstanding = new Map<string, Outstanding>()
  private processed = new Map<string, { ok: boolean; error?: string }>()
  private handle: DriverHandle | undefined
  private starting: Promise<void> | undefined
  private busy = false
  private taps = new Set<(message: ContainerMessage) => void>()
  ended = false

  constructor(
    readonly sessionId: string,
    readonly config: unknown,
    readonly tools: ToolDefinition[],
    private readonly driver: AgentDriver,
    private readonly opts: ContainerSessionOptions,
  ) {}

  get isBusy(): boolean {
    return !this.ended && (this.busy || [...this.outstanding.values()].some((o) => o.message.type !== 'store_request'))
  }

  get attached(): boolean {
    return this.socket !== undefined
  }

  start(): Promise<void> {
    this.starting ??= (async () => {
      this.handle = await this.driver.start(this.driverSession())
    })()
    return this.starting
  }

  /** Attach a client: welcome, replay what it missed, then re-send everything still pending. */
  attach(socket: WebSocket, hello: HelloMessage, created: boolean) {
    if (this.socket && this.socket !== socket) this.socket.close(4000, 'replaced by a newer connection')
    this.socket = socket
    this.send({ type: 'welcome', protocol: PROTOCOL_VERSION, bootId: this.opts.bootId, lastSeq: this.seq, created })
    const after = hello.bootId === this.opts.bootId ? (hello.afterSeq ?? 0) : 0
    const oldest = this.log[0]?.seq ?? this.seq + 1
    if (after + 1 < oldest && this.seq > 0) {
      this.send({
        type: 'event',
        event: { type: 'provider.custom', data: { name: 'agentcore.log_truncated', payload: { requestedAfter: after, oldestAvailable: oldest } } },
      })
    }
    for (const entry of this.log) if (entry.seq > after) this.send({ type: 'event', seq: entry.seq, event: entry.event })
    for (const o of this.outstanding.values()) this.send(o.message)
  }

  detach(socket: WebSocket) {
    if (this.socket === socket) this.socket = undefined
  }

  /** Observe everything sent to the client (used by the HTTP fallback). */
  tap(listener: (message: ContainerMessage) => void): () => void {
    this.taps.add(listener)
    return () => this.taps.delete(listener)
  }

  async onCommand(cmd: ClientCommand) {
    const previous = this.processed.get(cmd.id)
    if (previous) return this.send({ type: 'ack', id: cmd.id, ...previous })
    let outcome: { ok: boolean; error?: string } = { ok: true }
    try {
      switch (cmd.type) {
        case 'user_message':
          await this.start()
          await this.handle?.sendMessage(cmd.content)
          break
        case 'interrupt':
          await this.handle?.interrupt()
          break
        case 'tool_result':
          this.settle(cmd.requestId, cmd.result)
          break
        case 'approval_decision':
          this.settle(cmd.requestId, cmd.decision)
          break
        case 'terminate':
          await this.close()
          break
        default: {
          // Compile-time: every client command must be handled. Runtime: reject commands from a newer client.
          const unhandled: never = cmd
          throw new Error(`Unsupported command ${(unhandled as { type?: string }).type}`)
        }
      }
    } catch (err) {
      outcome = { ok: false, error: errorMessage(err) }
    }
    this.processed.set(cmd.id, outcome)
    if (this.processed.size > 1000) this.processed.delete(this.processed.keys().next().value as string)
    this.send({ type: 'ack', id: cmd.id, ...outcome })
  }

  onStoreResponse(res: StoreResponse) {
    const o = this.outstanding.get(res.requestId)
    if (!o) return
    this.outstanding.delete(res.requestId)
    if (res.ok) o.resolve(res.data)
    else o.reject(new Error(res.error ?? 'store request failed'))
  }

  async close() {
    if (this.ended) return
    this.ended = true
    for (const o of this.outstanding.values()) o.reject(new Error('session terminated'))
    this.outstanding.clear()
    await this.handle?.close()
    this.busy = false
    this.opts.onHealthChange()
  }

  private send(message: ContainerMessage) {
    for (const tap of this.taps) tap(message)
    const socket = this.socket
    if (!socket || socket.readyState !== socket.OPEN) return
    for (const frame of encodeFrames(message)) socket.send(frame)
  }

  private emit(event: ProviderEvent) {
    if (isEphemeralType(event.type)) return this.send({ type: 'event', event })
    this.seq += 1
    this.log.push({ seq: this.seq, event })
    if (this.log.length > this.opts.maxLogEvents) this.log.splice(0, this.log.length - this.opts.maxLogEvents)
    this.send({ type: 'event', seq: this.seq, event })
  }

  private request<T>(message: ContainerMessage & { requestId: string }): Promise<T> {
    if (this.ended) return Promise.reject(new Error('session terminated'))
    return new Promise<T>((resolve, reject) => {
      this.outstanding.set(message.requestId, { message, resolve: resolve as (v: unknown) => void, reject })
      this.opts.onHealthChange()
      this.send(message)
    }).finally(() => this.opts.onHealthChange())
  }

  private settle(requestId: string, value: unknown) {
    const o = this.outstanding.get(requestId)
    if (!o) return
    this.outstanding.delete(requestId)
    o.resolve(value)
  }

  private storeCall<T>(op: StoreOp): Promise<T> {
    return this.request<T>({ type: 'store_request', requestId: newId(), ...op } as ContainerMessage & { requestId: string })
  }

  private driverSession(): DriverSession {
    const store: RemoteSessionStore = {
      append: (key, entries) => this.storeCall({ op: 'append', key, entries }),
      load: (key) => this.storeCall({ op: 'load', key }),
      listSubkeys: (key) => this.storeCall({ op: 'listSubkeys', key }),
      delete: (key) => this.storeCall({ op: 'delete', key }),
      has: (sessionId) => this.storeCall({ op: 'has', sessionId }),
    }
    return {
      sessionId: this.sessionId,
      config: this.config,
      tools: this.tools,
      emit: (event) => this.emit(event),
      requestTool: (req) => this.request<ToolResult>({ type: 'tool_request', requestId: newId(), ...req }),
      requestApproval: (req) => this.request<ApprovalDecision>({ type: 'approval_request', requestId: newId(), ...req }),
      sessionStore: store,
      setBusy: (busy) => {
        this.busy = busy
        this.opts.onHealthChange()
      },
    }
  }
}
