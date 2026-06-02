// ── Messaging System Types ─────────────────────────────────────────────────
// Provider-agnostic interfaces. Business logic never imports from a concrete
// provider — always through MessagingService.

export type NotificationProvider = 'whatsapp' | 'email' | 'sms' | 'telegram' | 'push'

export type DeliveryStatus =
  | 'pending'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'cancelled'

export type EventType =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.assigned'
  | 'ticket.closed'
  | 'ticket.cancelled'
  | 'payment.received'
  | 'replacement.approved'
  | 'creditnote.created'
  | 'delivery.scheduled'
  | 'warranty.approved'
  | 'user.created'
  | 'custom'

// ── Template ──────────────────────────────────────────────────────────────

export interface TemplateVariable {
  key: string     // used in {{key}} placeholders
  label: string   // human-readable label for the UI
  source: string  // dot-path into the notification payload, e.g. "rma_number"
}

export interface MessageTemplate {
  id: string
  name: string
  displayName: string
  eventType: EventType
  provider: NotificationProvider
  language: string
  templateName?: string   // registered Meta template name (required for initiating WA convos)
  headerType?: 'text' | 'document' | 'image' | null
  headerContent?: string
  bodyContent: string
  footerContent?: string
  variables: TemplateVariable[]
  attachPdf: boolean
  status: 'active' | 'inactive' | 'pending_approval'
  createdAt: string
  updatedAt: string
  createdBy?: string
}

// ── Send options ──────────────────────────────────────────────────────────

export interface SendMessageOptions {
  provider: NotificationProvider
  to: string              // E.164 phone (+966501234567) or email address
  recipientName?: string
  templateId?: string
  templateName?: string   // Meta template name — required for WA template messages
  variables: Record<string, string>
  attachmentUrl?: string  // publicly reachable URL for document attachment
  ticketId?: string
  eventType: EventType
  language?: string
  freeformText?: string   // used only within the 24-hour customer-service window
}

export interface MessageResult {
  success: boolean
  messageId?: string
  provider: NotificationProvider
  status: DeliveryStatus
  error?: string
  rawResponse?: unknown
}

// ── Provider interface ────────────────────────────────────────────────────

/** Every messaging provider must implement this interface. */
export interface IMessagingProvider {
  readonly provider: NotificationProvider
  send(options: SendMessageOptions): Promise<MessageResult>
  validateConfig(): boolean
  isEnabled(): boolean
}

// ── Notification event ────────────────────────────────────────────────────

export interface NotificationEvent {
  type: EventType
  timestamp: string
  ticketId?: string
  ticket?: Record<string, unknown>
  customer?: Record<string, unknown>
  triggeredBy?: string  // user email that triggered the event
  metadata?: Record<string, unknown>
}

// ── Queue ─────────────────────────────────────────────────────────────────

export interface QueueJobPayload {
  to: string
  recipientName?: string
  templateId: string
  templateName?: string
  variables: Record<string, string>
  attachmentUrl?: string | null
  ticketId?: string | null
  language?: string
}

export interface QueueJob {
  id: string
  jobType: NotificationProvider
  eventType: EventType
  payload: QueueJobPayload
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  priority: number
  retryCount: number
  maxRetries: number
  scheduledAt: string
  startedAt?: string
  completedAt?: string
  errorMessage?: string
  result?: unknown
  createdAt: string
  createdBy?: string
}

// ── Settings ──────────────────────────────────────────────────────────────

export interface NotificationSettings {
  whatsapp_enabled: boolean
  email_enabled: boolean
  sms_enabled: boolean
  whatsapp_config: {
    phone_number_id: string
    business_account_id: string
    default_language: string
    api_version: string
  }
  notification_events: Partial<Record<EventType, boolean>>
  retry_config: {
    max_retries: number
    retry_delay_seconds: number
    backoff_multiplier: number
  }
  rate_limit: {
    messages_per_minute: number
    messages_per_day: number
  }
}
