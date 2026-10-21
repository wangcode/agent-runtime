import { Observable } from 'rxjs'

/**
 * Wrap an AsyncIterable (e.g. `session.events()`) as a cold Observable. Unsubscribing calls the
 * iterator's `return()`, which releases the underlying subscription.
 */
export function toObservable<T>(source: AsyncIterable<T> | (() => AsyncIterable<T>)): Observable<T> {
  return new Observable<T>((subscriber) => {
    const iterable = typeof source === 'function' ? source() : source
    const iterator = iterable[Symbol.asyncIterator]()
    let active = true
    void (async () => {
      try {
        while (active) {
          const { value, done } = await iterator.next()
          if (done || !active) break
          subscriber.next(value)
        }
        if (active) subscriber.complete()
      } catch (err) {
        if (active) subscriber.error(err)
      }
    })()
    return () => {
      active = false
      void iterator.return?.()
    }
  })
}
