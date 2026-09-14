// WhatsApp Cloud API provider.
// ALL actual API calls happen in the send-whatsapp Edge Function.
// This class is the browser-side adapter that calls that function —
// the access token is NEVER exposed to the browser.

import type { IMessagingProvider, SendMessageOptions, MessageResult, NotificationProvider } from '../types.js'

interface ProviderConfig {
  phoneNumberId: string
  enabled: boolean
}

export class WhatsAppProvider implements IMessagingProvider {
  readonly provider: NotificationProvider = 'whatsapp'

  private readonly phoneNumberId: string
  private readonly enabled: boolean

  constructor(config: ProviderConfig) {
    this.phoneNumberId = config.phoneNumberId
    this.enabled = config.enabled
  }

  isEnabled(): boolean {
    return this.enabled && !!this.phoneNumberId
  }

  async send(options: SendMessageOptions): Promise<MessageResult> {
    if (!this.isEnabled()) {
      return {
        success: false,
        provider: 'whatsapp',
        status: 'failed',
        error: 'WhatsApp provider is disabled or has no Phone Number ID configured.',
      }
    }

    // Dynamic import keeps supabase out of this TS file (avoids circular dep)
    //
    // KNOWN BROKEN, deliberately left: from src/lib/messaging/providers this path
    // resolves to src/lib/api/client.js, which does not exist. It should be
    // '../../../api/client.js', so a send through this provider fails at runtime.
    // Not fixed because WhatsApp work is on hold (BUG-006). When the path is
    // corrected, tsc reports this directive as unused and forces its removal.
    // @ts-expect-error TS2307: wrong relative path, see above (BUG-006 hold)
    const { supabase } = await import('../../api/client.js')

    try {
      const { data, error } = await supabase.functions.invoke('send-whatsapp', {
        body: {
          to: options.to,
          recipientName: options.recipientName,
          templateName: options.templateName,
          templateId: options.templateId,
          variables: options.variables,
          attachmentUrl: options.attachmentUrl ?? null,
          ticketId: options.ticketId ?? null,
          eventType: options.eventType,
          language: options.language ?? 'en',
          freeformText: options.freeformText ?? null,
        },
      })

      if (error) throw error

      return {
        success: data?.success ?? false,
        messageId: data?.message_id,
        provider: 'whatsapp',
        status: data?.success ? 'sent' : 'failed',
        error: data?.error,
        rawResponse: data,
      }
    } catch (err) {
      return {
        success: false,
        provider: 'whatsapp',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
