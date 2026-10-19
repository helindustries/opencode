export type MeshEvent = { name: string; data: unknown }

export const resetEvent = "stream.reset"

const queueLimit = 1000

export class Subscription {
  private readonly queue: MeshEvent[] = []
  private waiter?: (event: MeshEvent | undefined) => void

  get size() {
    return this.queue.length
  }

  push(event: MeshEvent) {
    if (!this.waiter) return void this.queue.push(event)
    const waiter = this.waiter
    this.waiter = undefined
    waiter(event)
  }

  // Drops whatever is queued and ends the stream; the reader reconnects and resyncs with a pull.
  reset() {
    this.queue.length = 0
    this.push({ name: resetEvent, data: null })
  }

  // The next event, or undefined once timeoutMs passed without one.
  next(timeoutMs?: number) {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise<MeshEvent | undefined>((resolve) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.waiter = undefined
        resolve(undefined)
      }, timeoutMs)
      this.waiter = (event) => {
        clearTimeout(timer)
        resolve(event)
      }
    })
  }
}

export class EventBus {
  private readonly subscribers = new Set<Subscription>()

  subscribe() {
    const subscription = new Subscription()
    this.subscribers.add(subscription)
    return subscription
  }

  unsubscribe(subscription: Subscription) {
    this.subscribers.delete(subscription)
  }

  // A stalled stream is cut off rather than allowed to pin memory: its queue is replaced by a
  // reset marker, and its reader reconnects and resyncs with a full pull.
  publish(name: string, data: unknown) {
    this.subscribers.forEach((subscription) => {
      if (subscription.size < queueLimit) return subscription.push({ name, data })
      this.unsubscribe(subscription)
      subscription.reset()
    })
  }

  // Ends every open stream.
  close() {
    const subscribers = [...this.subscribers]
    this.subscribers.clear()
    subscribers.forEach((subscription) => subscription.reset())
  }
}
