import { describe, expect, it } from 'vitest'
import type { Store } from '@agent-runtime/core'
import { newId } from '@agent-runtime/core'

/** Behaviour every Store implementation must share. */
export function storeContract(name: string, makeStore: () => Store | Promise<Store>) {
  const newSession = async (store: Store) => {
    const id = newId()
    await store.createSession({ id, provider: 'fake', providerSessionId: `p_${id}`, config: { a: 1 }, metadata: { user: 'u' }, status: 'idle', providerCursor: null })
    return id
  }

  describe(`${name} store contract`, () => {
    it('creates and updates sessions', async () => {
      const store = await makeStore()
      const id = await newSession(store)
      await store.updateSession(id, { status: 'running', providerCursor: { last: 'e1' } })
      const s = await store.getSession(id)
      expect(s).toMatchObject({ id, provider: 'fake', config: { a: 1 }, metadata: { user: 'u' }, status: 'running', providerCursor: { last: 'e1' }, lastSeq: 0 })
      expect(await store.getSession('missing')).toBeNull()
    })

    it('allocates sequential seqs and dedupes by sourceId', async () => {
      const store = await makeStore()
      const id = await newSession(store)
      const a = await store.appendEvent(id, { type: 'user.message', data: { content: [] }, sourceId: 's1' })
      const dup = await store.appendEvent(id, { type: 'user.message', data: { content: [] }, sourceId: 's1' })
      const b = await store.appendEvent(id, { type: 'provider.custom', data: { name: 'x', payload: {} }, raw: { x: 1 } })
      const c = await store.appendEvent(id, { type: 'provider.custom', data: { name: 'x', payload: {} } })
      expect([a?.seq, dup, b?.seq, c?.seq]).toEqual([1, null, 2, 3])
      const threaded = await store.appendEvent(id, { type: 'agent.message.completed', data: { messageId: 'm', content: [] }, threadId: 'thread_1' })
      expect(threaded?.threadId).toBe('thread_1')
      expect((await store.readEvents(id, 3, 10))[0]?.threadId).toBe('thread_1')
      expect((await store.readEvents(id, 0, 1))[0]?.threadId).toBeUndefined()
      expect(b?.raw).toEqual({ x: 1 })
      expect((await store.readEvents(id, 1, 10)).map((e) => e.seq)).toEqual([2, 3, 4])
      expect((await store.readEvents(id, 0, 2)).map((e) => e.seq)).toEqual([1, 2])
      expect((await store.getSession(id))?.lastSeq).toBe(4)
    })

    it('keeps seqs unique under concurrent appends', async () => {
      const store = await makeStore()
      const id = await newSession(store)
      await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendEvent(id, { type: 'provider.custom', data: { name: 'x', payload: { i } } })))
      const seqs = (await store.readEvents(id, 0, 100)).map((e) => e.seq)
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    })

    it('implements leases', async () => {
      const store = await makeStore()
      const id = await newSession(store)
      expect(await store.tryAcquireLease(id, 'a', 10_000)).toBe(true)
      expect(await store.tryAcquireLease(id, 'b', 10_000)).toBe(false)
      expect(await store.tryAcquireLease(id, 'a', 10_000)).toBe(true)
      expect(await store.renewLease(id, 'b', 10_000)).toBe(false)
      expect(await store.renewLease(id, 'a', 1)).toBe(true)
      await new Promise((r) => setTimeout(r, 20))
      expect(await store.tryAcquireLease(id, 'b', 10_000)).toBe(true)
      expect(await store.renewLease(id, 'a', 10_000)).toBe(false)
      await store.releaseLease(id, 'a')
      expect((await store.getSession(id))?.ownerInstance).toBe('b')
      await store.releaseLease(id, 'b')
      expect((await store.getSession(id))?.ownerInstance).toBeNull()
    })

    it('finds orphaned sessions that need an owner', async () => {
      const store = await makeStore()
      const idle = await newSession(store)
      const busy = await newSession(store)
      const owned = await newSession(store)
      const withCmd = await newSession(store)
      await store.updateSession(busy, { status: 'running' })
      await store.updateSession(owned, { status: 'running' })
      await store.tryAcquireLease(owned, 'x', 60_000)
      await store.enqueueCommand({ id: newId(), sessionId: withCmd, kind: 'send', payload: {} })
      const orphans = await store.findOrphans(1000)
      expect(orphans).toContain(busy)
      expect(orphans).toContain(withCmd)
      expect(orphans).not.toContain(idle)
      expect(orphans).not.toContain(owned)
    })

    it('queues commands in order', async () => {
      const store = await makeStore()
      const id = await newSession(store)
      const c1 = newId()
      const c2 = newId()
      await store.enqueueCommand({ id: c1, sessionId: id, kind: 'send', payload: { n: 1 } })
      await store.enqueueCommand({ id: c2, sessionId: id, kind: 'interrupt', payload: {} })
      await store.enqueueCommand({ id: c1, sessionId: id, kind: 'send', payload: { n: 1 } })
      expect((await store.pendingCommands(id)).map((c) => c.id)).toEqual([c1, c2])
      await store.finishCommand(c1, { status: 'failed', error: 'nope' })
      expect(await store.getCommand(c1)).toMatchObject({ status: 'failed', error: 'nope', payload: { n: 1 } })
      expect((await store.pendingCommands(id)).map((c) => c.id)).toEqual([c2])
    })

    it('upserts actions and resolves them with compare-and-set', async () => {
      const store = await makeStore()
      const id = await newSession(store)
      const base = { sessionId: id, kind: 'approval' as const, requestId: 'r1', toolUseId: 't1', name: 'bash', input: { cmd: 'ls' }, expiresAt: new Date(Date.now() + 1000) }
      const first = await store.upsertAction({ id: newId(), ...base })
      const again = await store.upsertAction({ id: newId(), ...base })
      expect(first.created).toBe(true)
      expect(again.created).toBe(false)
      expect(again.action.id).toBe(first.action.id)
      expect(await store.resolveAction(first.action.id, { status: 'resolved', result: { behavior: 'allow' }, resolvedBy: 'user' })).toBe(true)
      expect(await store.resolveAction(first.action.id, { status: 'resolved', result: { behavior: 'deny' }, resolvedBy: 'timeout' })).toBe(false)
      expect(await store.getAction(first.action.id)).toMatchObject({ status: 'resolved', result: { behavior: 'allow' }, resolvedBy: 'user', delivered: false })
      await store.markActionDelivered(first.action.id)
      expect((await store.getAction(first.action.id))?.delivered).toBe(true)
      expect(await store.listActions(id, { status: 'pending' })).toHaveLength(0)
      expect(await store.listActions(id, { kind: 'approval' })).toHaveLength(1)
    })

    it('stores transcripts', async () => {
      const store = await makeStore()
      const key = { projectKey: 'p', sessionId: newId() }
      expect(await store.loadTranscript(key)).toBeNull()
      await store.appendTranscript(key, [{ type: 'user', n: 1 }, { type: 'assistant', n: 2 }])
      await store.appendTranscript(key, [{ type: 'user', n: 3 }])
      await store.appendTranscript({ ...key, subpath: 'subagents/a' }, [{ type: 'x' }])
      expect(await store.loadTranscript(key)).toEqual([{ type: 'user', n: 1 }, { type: 'assistant', n: 2 }, { type: 'user', n: 3 }])
      expect(await store.listTranscriptSubkeys(key)).toEqual(['subagents/a'])
      expect(await store.hasTranscript(key.sessionId)).toBe(true)
      expect(await store.hasTranscript('other')).toBe(false)
      await store.deleteTranscript({ ...key, subpath: 'subagents/a' })
      expect(await store.listTranscriptSubkeys(key)).toEqual([])
      expect(await store.loadTranscript(key)).not.toBeNull()
      await store.deleteTranscript(key)
      expect(await store.loadTranscript(key)).toBeNull()
      expect(await store.hasTranscript(key.sessionId)).toBe(false)
    })
  })
}
