// MessagingService — provider-agnostic orchestrator.
// Register concrete providers; call send() without coupling to any one.

import type { IMessagingProvider, SendMessageOptions, MessageResult, NotificationProvider } from './types.js'

export class MessagingService {
  private readonly providers = new Map<NotificationProvider, IMessagingProvider>()

  registerProvider(provider: IMessagingProvider): void {
    this.providers.set(provider.provider, provider)
  }

  getProvider(name: NotificationProvider): IMessagingProvider | undefined {
    return this.providers.get(name)
  }

  hasProvider(name: NotificationProvider): boolean {
    return this.providers.has(name) && (this.providers.get(name)?.isEnabled() ?? false)
  }

  async send(options: SendMessageOptions): Promise<MessageResult> {
    const provider = this.providers.get(options.provider)
    if (!provider) {
      return {
        success: false,
        provider: options.provider,
        status: 'failed',
        error: `Provider "${options.provider}" is not registered.`,
      }
    }
    if (!provider.isEnabled()) {
      return {
        success: false,
        provider: options.provider,
        status: 'failed',
        error: `Provider "${options.provider}" is currently disabled.`,
      }
    }
    return provider.send(options)
  }

  /** Send to multiple recipients with bounded concurrency (default: 5). */
  async sendBatch(
    batch: SendMessageOptions[],
    concurrency = 5
  ): Promise<MessageResult[]> {
    const results: MessageResult[] = []
    for (let i = 0; i < batch.length; i += concurrency) {
      const slice = batch.slice(i, i + concurrency)
      const settled = await Promise.allSettled(slice.map((o) => this.send(o)))
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          results.push(r.value)
        } else {
          results.push({
            success: false,
            provider: slice[results.length % slice.length]?.provider ?? 'whatsapp',
            status: 'failed',
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          })
        }
      }
    }
    return results
  }
}

// Singleton — shared across the app
export const messagingService = new MessagingService()
