// Ticket lifecycle → notification queue.
// Handlers are registered once at app start (see App.jsx).
// They read settings from the DB, resolve the right template, find the
// customer's phone, then INSERT a row into notification_queue.
// The notification-worker Edge Function drains the queue and calls WhatsApp.

import { notificationEventBus } from './NotificationEventBus.js'
import type { NotificationEvent, EventType } from '../messaging/types.js'
import { TemplateEngine } from '../messaging/TemplateEngine.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// Ticket events that trigger notifications
const TICKET_EVENTS: EventType[] = [
  'ticket.created',
  'ticket.updated',
  'ticket.assigned',
  'ticket.closed',
  'ticket.cancelled',
]

// Priority map — lower number = higher priority in the queue
const EVENT_PRIORITY: Partial<Record<EventType, number>> = {
  'ticket.created':  3,
  'ticket.closed':   3,
  'ticket.assigned': 4,
  'ticket.updated':  5,
  'payment.received': 2,
}

function getPriority(eventType: EventType): number {
  return EVENT_PRIORITY[eventType] ?? 5
}

function normalizePhone(raw: string): string {
  // Keep only digits; WhatsApp Cloud API expects digits only (no +)
  return raw.replace(/[^0-9]/g, '')
}

async function isWhatsAppEnabled(supabase: SupabaseClient): Promise<boolean> {
  const { data } = await supabase
    .from('notification_settings')
    .select('setting_value')
    .eq('setting_key', 'whatsapp_enabled')
    .single()
  return data?.setting_value === true || data?.setting_value === 'true'
}

async function isEventEnabled(supabase: SupabaseClient, eventType: EventType): Promise<boolean> {
  const { data } = await supabase
    .from('notification_settings')
    .select('setting_value')
    .eq('setting_key', 'notification_events')
    .single()
  const flags = (data?.setting_value ?? {}) as Record<string, boolean>
  return flags[eventType] !== false
}

async function fetchActiveTemplate(supabase: SupabaseClient, eventType: EventType) {
  const { data } = await supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('event_type', eventType)
    .eq('provider', 'whatsapp')
    .eq('status', 'active')
    .limit(1)
  return data?.[0] ?? null
}

async function resolveCustomerPhone(
  supabase: SupabaseClient,
  ticket: Record<string, unknown>
): Promise<string | null> {
  if (ticket.customer_phone) return normalizePhone(String(ticket.customer_phone))
  if (ticket.customer_id) {
    const { data } = await supabase
      .from('customers')
      .select('mobile')
      .eq('id', String(ticket.customer_id))
      .single()
    if (data?.mobile) return normalizePhone(data.mobile)
  }
  return null
}

function buildQueuePayload(
  template: Record<string, unknown>,
  event: NotificationEvent,
  phone: string
) {
  const ticket = (event.ticket ?? {}) as Record<string, unknown>
  const payload: Record<string, unknown> = {
    ...ticket,
    ...(event.customer ?? {}),
    ...(event.metadata ?? {}),
  }

  const templateVars = template.variables as Array<{ key: string; label: string; source: string }>
  let variables = TemplateEngine.resolveVariables(templateVars, payload)
  variables = TemplateEngine.formatDates(variables)

  // Build an EXPLICITLY ORDERED param array from the template's variable
  // definition order. This is critical: the queue `payload` is a JSONB
  // column, and Postgres JSONB does NOT preserve object key order (it
  // reorders keys by length then alphabetically). Sending the `variables`
  // object alone would scramble WhatsApp's positional {{1}},{{2}} params.
  // JSONB *does* preserve array element order, so we send this array.
  // Meta rejects empty positional params with #131008 "Required parameter
  // is missing". Substitute a placeholder for any blank value so a single
  // missing field never blocks the whole notification.
  const params = templateVars.map((def) => {
    const v = variables[def.key]
    return v != null && String(v).trim() !== '' ? String(v) : '—'
  })

  return {
    to: phone,
    recipientName: variables.customer_name ?? ticket.customer_name ?? '',
    templateId: template.id,
    templateName: template.template_name,
    variables,
    params,
    attachmentUrl: (event.metadata?.pdfUrl as string) ?? null,
    ticketId: event.ticketId ?? null,
    language: (template.language as string) ?? 'en',
  }
}

async function queueNotification(
  supabase: SupabaseClient,
  eventType: EventType,
  payload: ReturnType<typeof buildQueuePayload>,
  triggeredBy: string | undefined
): Promise<void> {
  const { error } = await supabase.from('notification_queue').insert({
    job_type: 'whatsapp',
    event_type: eventType,
    payload,
    status: 'pending',
    priority: getPriority(eventType),
    max_retries: 3,
    scheduled_at: new Date().toISOString(),
    created_by: triggeredBy ?? 'system',
  })
  if (error) console.error('[ticketEventHandlers] Queue insert failed:', error.message)
}

function triggerWorker(supabase: SupabaseClient): void {
  // Best-effort: if the worker is unavailable the queued job persists for retry
  void supabase.functions
    .invoke('notification-worker', { headers: { 'x-trigger-source': 'event-handler' } })
    .catch(() => {/* worker unavailable — queue still persists */})
}

/** One-time setup — call from App.jsx on mount. */
export function registerTicketEventHandlers(): void {
  for (const eventType of TICKET_EVENTS) {
    notificationEventBus.on(eventType, async (event: NotificationEvent) => {
      try {
        // Dynamic import avoids loading supabase during SSR / test environments
        const { supabase } = await import('../../api/client.js')

        if (!await isWhatsAppEnabled(supabase)) return
        if (!await isEventEnabled(supabase, event.type)) return

        const template = await fetchActiveTemplate(supabase, event.type)
        if (!template) return

        const phone = await resolveCustomerPhone(supabase, event.ticket ?? {})
        if (!phone) return

        const payload = buildQueuePayload(template, event, phone)
        await queueNotification(supabase, event.type, payload, event.triggeredBy)
        triggerWorker(supabase)

      } catch (err) {
        console.error(`[ticketEventHandlers] Error handling ${event.type}:`, err)
      }
    })
  }
}
