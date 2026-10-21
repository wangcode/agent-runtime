import type { PersistedEvent } from './events.js'
import type { ActionRecord, Bus, CommandRecord, NewEvent, SessionRecord, Store, TranscriptKey } from './store.js'

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value))

const transcriptKey = (k: TranscriptKey) => `${k.projectKey}\u0000${k.sessionId}\u0000${k.subpath ?? ''}`

/**
 * Single-process Store. Useful for tests and single-instance deployments; share one instance
 * between several runtimes to simulate a cluster.
 */
export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>()
  private events = new Map<string, PersistedEvent[]>()
  private sourceIds = new Map<string, Set<string>>()
  private commands = new Map<string, CommandRecord>()
  private actions = new Map<string, ActionRecord>()
  private transcripts = new Map<string, unknown[]>()

  async createSession(input: Parameters<Store['createSession']>[0]): Promise<SessionRecord> {
    if (this.sessions.has(input.id)) throw new Error(`Session ${input.id} already exists`)
    const now = new Date()
    const record: SessionRecord = { ...clone(input), ownerInstance: null, leaseExpiresAt: null, lastSeq: 0, createdAt: now, updatedAt: now }
    this.sessions.set(input.id, record)
    return clone(record)
  }

  async getSession(id: string) {
    return clone(this.sessions.get(id) ?? null)
  }

  async updateSession(id: string, patch: Parameters<Store['updateSession']>[1]) {
    const s = this.mustGet(id)
    Object.assign(s, clone(patch), { updatedAt: new Date() })
  }

  async tryAcquireLease(id: string, instanceId: string, ttlMs: number) {
    const s = this.mustGet(id)
    const now = Date.now()
    if (s.ownerInstance && s.ownerInstance !== instanceId && s.leaseExpiresAt && s.leaseExpiresAt.getTime() > now) return false
    s.ownerInstance = instanceId
    s.leaseExpiresAt = new Date(now + ttlMs)
    return true
  }

  async renewLease(id: string, instanceId: string, ttlMs: number) {
    const s = this.sessions.get(id)
    if (!s || s.ownerInstance !== instanceId) return false
    s.leaseExpiresAt = new Date(Date.now() + ttlMs)
    return true
  }

  async releaseLease(id: string, instanceId: string) {
    const s = this.sessions.get(id)
    if (s && s.ownerInstance === instanceId) {
      s.ownerInstance = null
      s.leaseExpiresAt = null
    }
  }

  async findOrphans(limit: number) {
    const now = Date.now()
    const out: string[] = []
    for (const s of this.sessions.values()) {
      if (out.length >= limit) break
      if (s.status === 'terminated') continue
      const leaseFree = !s.ownerInstance || !s.leaseExpiresAt || s.leaseExpiresAt.getTime() <= now
      if (!leaseFree) continue
      const busy = s.status === 'running' || s.status === 'requires_action'
      const hasCommands = [...this.commands.values()].some((c) => c.sessionId === s.id && c.status === 'pending')
      const hasActions = [...this.actions.values()].some((a) => a.sessionId === s.id && (a.status === 'pending' || !a.delivered) && a.status !== 'cancelled')
      if (busy || hasCommands || hasActions) out.push(s.id)
    }
    return out
  }

  async appendEvent(sessionId: string, event: NewEvent): Promise<PersistedEvent | null> {
    const s = this.mustGet(sessionId)
    let seen = this.sourceIds.get(sessionId)
    if (!seen) this.sourceIds.set(sessionId, (seen = new Set()))
    if (event.sourceId) {
      if (seen.has(event.sourceId)) return null
      seen.add(event.sourceId)
    }
    s.lastSeq += 1
    const persisted = {
      id: String(s.lastSeq),
      sessionId,
      seq: s.lastSeq,
      ts: new Date().toISOString(),
      type: event.type,
      data: clone(event.data),
      ...(event.raw !== undefined ? { raw: clone(event.raw) } : {}),
      ...(event.provider ? { provider: event.provider } : {}),
      ...(event.threadId ? { threadId: event.threadId } : {}),
    } as PersistedEvent
    let list = this.events.get(sessionId)
    if (!list) this.events.set(sessionId, (list = []))
    list.push(persisted)
    return clone(persisted)
  }

  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    const list = this.events.get(sessionId) ?? []
    return clone(list.filter((e) => e.seq > afterSeq).slice(0, limit))
  }

  async enqueueCommand(input: Parameters<Store['enqueueCommand']>[0]) {
    const existing = this.commands.get(input.id)
    if (existing) return clone(existing)
    const record: CommandRecord = { ...clone(input), status: 'pending', createdAt: new Date() }
    this.commands.set(input.id, record)
    return clone(record)
  }

  async pendingCommands(sessionId: string) {
    return clone([...this.commands.values()].filter((c) => c.sessionId === sessionId && c.status === 'pending'))
  }

  async getCommand(id: string) {
    return clone(this.commands.get(id) ?? null)
  }

  async finishCommand(id: string, outcome: { status: 'done' | 'failed'; error?: string }) {
    const c = this.commands.get(id)
    if (c) Object.assign(c, outcome)
  }

  async upsertAction(input: Parameters<Store['upsertAction']>[0]) {
    for (const a of this.actions.values()) {
      if (a.sessionId === input.sessionId && a.kind === input.kind && a.requestId === input.requestId) return { action: clone(a), created: false }
    }
    const action: ActionRecord = { ...clone(input), status: 'pending', delivered: false, createdAt: new Date() }
    this.actions.set(action.id, action)
    return { action: clone(action), created: true }
  }

  async getAction(id: string) {
    return clone(this.actions.get(id) ?? null)
  }

  async listActions(sessionId: string, filter: { status?: ActionRecord['status']; kind?: ActionRecord['kind'] } = {}) {
    return clone(
      [...this.actions.values()].filter(
        (a) => a.sessionId === sessionId && (!filter.status || a.status === filter.status) && (!filter.kind || a.kind === filter.kind),
      ),
    )
  }

  async resolveAction(id: string, outcome: Parameters<Store['resolveAction']>[1]) {
    const a = this.actions.get(id)
    if (!a || a.status !== 'pending') return false
    a.status = outcome.status
    a.result = clone(outcome.result)
    a.resolvedBy = outcome.resolvedBy
    if (outcome.status === 'cancelled') a.delivered = true
    return true
  }

  async markActionDelivered(id: string) {
    const a = this.actions.get(id)
    if (a) a.delivered = true
  }

  async appendTranscript(key: TranscriptKey, entries: unknown[]) {
    const k = transcriptKey(key)
    this.transcripts.set(k, [...(this.transcripts.get(k) ?? []), ...clone(entries)])
  }

  async loadTranscript(key: TranscriptKey) {
    return clone(this.transcripts.get(transcriptKey(key)) ?? null)
  }

  async listTranscriptSubkeys(key: { projectKey: string; sessionId: string }) {
    const prefix = `${key.projectKey}\u0000${key.sessionId}\u0000`
    return [...this.transcripts.keys()].filter((k) => k.startsWith(prefix) && k.length > prefix.length).map((k) => k.slice(prefix.length))
  }

  async deleteTranscript(key: TranscriptKey) {
    if (key.subpath !== undefined) {
      this.transcripts.delete(transcriptKey(key))
      return
    }
    const prefix = `${key.projectKey}\u0000${key.sessionId}\u0000`
    for (const k of [...this.transcripts.keys()]) if (k.startsWith(prefix)) this.transcripts.delete(k)
  }

  async hasTranscript(sessionId: string) {
    return [...this.transcripts.keys()].some((k) => k.split('\u0000')[1] === sessionId)
  }

  private mustGet(id: string) {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`Session ${id} not found`)
    return s
  }
}

/** In-process pub/sub. Share one instance between runtimes to simulate a cluster. */
export class MemoryBus implements Bus {
  private handlers = new Map<string, Set<(payload: string) => void>>()

  async publish(topic: string, payload: string) {
    for (const h of [...(this.handlers.get(topic) ?? [])]) {
      queueMicrotask(() => h(payload))
    }
  }

  subscribe(topic: string, handler: (payload: string) => void) {
    let set = this.handlers.get(topic)
    if (!set) this.handlers.set(topic, (set = new Set()))
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(topic)
    }
  }
}
