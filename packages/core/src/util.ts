import { randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Exponential backoff with full jitter. */
export const backoff = (attempt: number, baseMs = 500, maxMs = 30_000): number =>
  Math.round(Math.random() * Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16)))

/** A wake-up signal: `wait()` resolves on the next `notify()` or after `timeoutMs`. */
export class Notifier {
  private waiters: Array<() => void> = []
  private pending = false

  notify(): void {
    const waiters = this.waiters
    this.waiters = []
    if (waiters.length === 0) this.pending = true
    for (const w of waiters) w()
  }

  wait(timeoutMs: number): Promise<void> {
    if (this.pending) {
      this.pending = false
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        resolve()
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
  settled: boolean
}

export function deferred<T = void>(): Deferred<T> {
  const d = { settled: false } as Deferred<T>
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = (v) => {
      d.settled = true
      resolve(v)
    }
    d.reject = (e) => {
      d.settled = true
      reject(e)
    }
  })
  return d
}

/**
 * Unbounded async queue usable as an AsyncIterable. `push` after `close` is ignored; `fail`
 * makes the iterator throw once buffered items are drained.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private notifier = new Notifier()
  private closed = false
  private error: unknown

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.notifier.notify()
  }

  close(): void {
    this.closed = true
    this.notifier.notify()
  }

  fail(err: unknown): void {
    this.error = err ?? new Error('queue failed')
    this.close()
  }

  get isClosed(): boolean {
    return this.closed
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.items.length) yield this.items.shift() as T
      if (this.closed) {
        if (this.error) throw this.error
        return
      }
      await this.notifier.wait(60_000)
    }
  }
}

/**
 * Iterate `source` until `signal` aborts, even if the source itself ignores the signal. On abort
 * the source's `return()` is called without awaiting it.
 */
export async function* abortable<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next === 'aborted' || next.done) return
      yield next.value
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

export const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
