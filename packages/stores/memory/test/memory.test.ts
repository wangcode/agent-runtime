import { describe, expect, it } from 'vitest'
import { storeContract } from '@agent-runtime/core/testing'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'

storeContract('memory', () => new MemoryStore(), { describe, it, expect })

describe('MemoryBus', () => {
  it('delivers to subscribers of a topic until they unsubscribe', async () => {
    const bus = new MemoryBus()
    const got: string[] = []
    const off = bus.subscribe('t', (m) => got.push(m))
    bus.subscribe('other', () => got.push('wrong topic'))
    await bus.publish('t', 'a')
    off()
    await bus.publish('t', 'b')
    expect(got).toEqual(['a'])
  })
})
