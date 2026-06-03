// Ticket lifecycle → notification queue.
// Handlers are registered once at app start (see App.jsx).
// They read settings from the DB, resolve the right template, find the
// customer's phone, then INSERT a row into notification_queue.
// The notification-worker Edge Function drains the queue and calls WhatsApp.

import { notificationEventBus } from './NotificationEventBus.js'
import type { NotificationEvent, EventType } from '../messaging/types.js'
import { TemplateEngine } from '../messaging/TemplateEngine.js'

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

/** One-time setup — call from App.jsx on mount. */
export function registerTicketEventHandlers(): void {
  for (const eventType of TICKET_EVENTS) {
    notificationEventBus.on(eventType, async (event: NotificationEvent) => {
      try {
        // Dynamic import avoids loading supabase during SSR / test environments
        const { supabase } = await import('../../api/client.js')

        // ── 1. Check global WhatsApp toggle ──────────────────────────────
        const { data: enabledRow } = await supabase
          .from('notification_settings')
          .select('setting_value')
          .eq('setting_key', 'whatsapp_enabled')
          .single()

        const isEnabled =
          enabledRow?.setting_value === true ||
          enabledRow?.setting_value === 'true'
        if (!isEnabled) return

        // ── 2. Check per-event toggle ─────────────────────────────────────
        const { data: eventsRow } = await supabase
          .from('notification_settings')
          .select('setting_value')
          .eq('setting_key', 'notification_events')
          .single()

        const eventFlags = (eventsRow?.setting_value ?? {}) as Record<string, boolean>
        if (eventFlags[event.type] === false) return

        // ── 3. Load active template for this event ────────────────────────
        const { data: templates } = await supabase
          .from('whatsapp_templates')
          .select('*')
          .eq('event_type', event.type)
          .eq('provider', 'whatsapp')
          .eq('status', 'active')
          .limit(1)

        const template = templates?.[0]
        if (!template) return

        // ── 4. Resolve customer phone ─────────────────────────────────────
        const ticket = event.ticket ?? {}
        let phone: string | null = null

        // Priority: ticket.customer_phone > customers table lookup
        if (ticket.customer_phone) {
          phone = normalizePhone(String(ticket.customer_phone))
        } else if (ticket.customer_id) {
          const { data: cust } = await supabase
            .from('customers')
            .select('mobile')
            .eq('id', String(ticket.customer_id))
            .single()
          if (cust?.mobile) phone = normalizePhone(cust.mobile)
        }

        if (!phone) return // no phone on file — skip silently

        // ── 5. Resolve template variables ─────────────────────────────────
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
        const params = templateVars.map((def) => variables[def.key] ?? '')

        // ── 6. Queue the notification ─────────────────────────────────────
        const { error: queueError } = await supabase
          .from('notification_queue')
          .insert({
            job_type: 'whatsapp',
            event_type: event.type,
            payload: {
              to: phone,
              recipientName: variables.customer_name ?? ticket.customer_name ?? '',
              templateId: template.id,
              templateName: template.template_name,
              variables,
              params,
              attachmentUrl: (event.metadata?.pdfUrl as string) ?? null,
              ticketId: event.ticketId ?? null,
              language: template.language ?? 'en',
            },
            status: 'pending',
            priority: getPriority(event.type),
            max_retries: 3,
            scheduled_at: new Date().toISOString(),
            created_by: event.triggeredBy ?? 'system',
          })

        if (queueError) {
          console.error('[ticketEventHandlers] Queue insert failed:', queueError.message)
          return
        }

        // ── 7. Trigger worker immediately (best-effort) ───────────────────
        // If this fails, the queued job will be retried from the Test Center
        // or a scheduled pg_cron job.
        void supabase.functions
          .invoke('notification-worker', {
            headers: { 'x-trigger-source': 'event-handler' },
          })
          .catch(() => {/* worker unavailable — queue still persists */})

      } catch (err) {
        console.error(`[ticketEventHandlers] Error handling ${event.type}:`, err)
      }
    })
  }
}
