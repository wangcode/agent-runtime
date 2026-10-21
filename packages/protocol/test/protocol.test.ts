import { describe, expect, it } from 'vitest'
import { type ContainerMessage, FrameDecoder, encodeFrames, runtimeSessionIdFor } from '@agent-runtime/protocol'

describe('protocol framing', () => {
  it('passes small messages through as a single frame', () => {
    const msg: ContainerMessage = { type: 'ack', id: 'a', ok: true }
    const frames = encodeFrames(msg)
    expect(frames).toHaveLength(1)
    expect(new FrameDecoder<ContainerMessage>().decode(frames[0]!)).toEqual(msg)
  })

  it('chunks large messages under the frame limit and reassembles them in any order', () => {
    const text = '日本語 "quoted" \\ '.repeat(20_000)
    const msg: ContainerMessage = { type: 'event', seq: 1, event: { type: 'message.completed', data: { messageId: 'm', content: [{ type: 'text', text }] } } }
    const frames = encodeFrames(msg, 4096)
    expect(frames.length).toBeGreaterThan(1)
    for (const f of frames) expect(Buffer.byteLength(f)).toBeLessThanOrEqual(4096)
    const decoder = new FrameDecoder<ContainerMessage>()
    const shuffled = [...frames].reverse()
    const results = shuffled.map((f) => decoder.decode(f))
    expect(results.slice(0, -1).every((r) => r === null)).toBe(true)
    expect(results.at(-1)).toEqual(msg)
  })

  it('derives valid AgentCore runtime session ids', () => {
    expect(runtimeSessionIdFor('a').length).toBeGreaterThanOrEqual(33)
    const uuid = '0b7a3a7e-8a43-4a58-9d1c-2a6b1d2a9f11'
    expect(runtimeSessionIdFor(uuid)).toBe(`agent-runtime-${uuid}`)
    expect(runtimeSessionIdFor('x'.repeat(400))).toHaveLength(256)
  })
})
