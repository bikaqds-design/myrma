import type { NotificationEvent, EventType } from '../messaging/types.js'

type EventHandler = (event: NotificationEvent) => Promise<void> | void

/**
 * Lightweight synchronous event bus for notification events.
 * Handlers are called in registration order; errors in one handler
 * do not prevent others from running.
 */
class NotificationEventBus {
  private readonly handlers = new Map<EventType | '*', EventHandler[]>()

  on(eventType: EventType | '*', handler: EventHandler): () => void {
    const existing = this.handlers.get(eventType) ?? []
    this.handlers.set(eventType, [...existing, handler])
    // Return an unsubscribe function
    return () => this.off(eventType, handler)
  }

  off(eventType: EventType | '*', handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? []
    this.handlers.set(
      eventType,
      existing.filter((h) => h !== handler)
    )
  }

  async emit(event: NotificationEvent): Promise<void> {
    const specific = this.handlers.get(event.type) ?? []
    const wildcard = this.handlers.get('*') ?? []
    const all = [...specific, ...wildcard]
    if (all.length === 0) return

    const settled = await Promise.allSettled(all.map((h) => h(event)))
    for (const result of settled) {
      if (result.status === 'rejected') {
        console.error('[NotificationEventBus] Handler error:', result.reason)
      }
    }
  }

  /** Emit without awaiting — fire and forget. */
  emitAsync(event: NotificationEvent): void {
    void this.emit(event)
  }
}

export const notificationEventBus = new NotificationEventBus()
