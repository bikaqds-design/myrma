// CRM lifecycle → notification queue.
// Handles follow-up reminders and rep notifications for lead/deal events.
// Registered once at app start alongside registerTicketEventHandlers().

import { notificationEventBus } from './NotificationEventBus.js'
import type { NotificationEvent, EventType } from '../messaging/types.js'
import { TemplateEngine } from '../messaging/TemplateEngine.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { captureException } from '../sentry.js'

const CRM_EVENTS: EventType[] = [
  'crm.followup_due',
  'crm.lead_assigned',
  'crm.deal_won',
  'crm.deal_overdue',
]

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

let warnedNoRepPhoneStore = false

/**
 * Resolve the assigned rep's phone number.
 *
 * **There is nowhere to resolve it from.** This previously ran
 *
 *     supabase.from('user_roles').select('phone').eq('email', repEmail)
 *
 * against a table that has neither column — it is `user_email`, and no `phone`
 * exists anywhere in the schema. The query therefore always failed, `data` was
 * always undefined, and the caller's `if (!phone) return` meant every CRM
 * WhatsApp notification to a rep has silently done nothing since it was
 * written. A comment claimed reps set this in AccountSettings; no such field
 * exists.
 *
 * The doomed query is removed rather than kept — it cost a round trip per
 * event to produce a guaranteed null. What replaces it is a single warning, so
 * the gap is visible instead of silent. Deciding where a rep's phone should
 * live is a product question: a column on user_roles with a field in
 * AccountSettings, or `user_preferences.prefs`. Either needs a SECURITY
 * DEFINER lookup, because a rep may not read another rep's row under the
 * policies in 20260790.
 *
 * Ticket notifications to customers are unaffected — those read the phone from
 * the customer record and work.
 */
async function resolveRepPhone(
  _supabase: SupabaseClient,
  repEmail: string | null | undefined
): Promise<string | null> {
  if (!repEmail) return null
  if (!warnedNoRepPhoneStore) {
    warnedNoRepPhoneStore = true
    captureException(
      new Error(
        'CRM rep notifications are not deliverable: no phone number is stored for staff users. ' +
          'See Finding 8 in docs/archive/PRELAUNCH_REVIEW.md.'
      ),
      { context: 'crmEventHandlers/resolveRepPhone' }
    )
  }
  return null
}

async function queueNotification(
  supabase: SupabaseClient,
  eventType: EventType,
  template: Record<string, unknown>,
  payload: Record<string, unknown>,
  phone: string,
  triggeredBy: string | undefined
): Promise<void> {
  const templateVars = template.variables as Array<{ key: string; label: string; source: string }>
  let variables = TemplateEngine.resolveVariables(templateVars, payload)
  variables = TemplateEngine.formatDates(variables)
  const params = templateVars.map((def) => {
    const v = variables[def.key]
    return v != null && String(v).trim() !== '' ? String(v) : '—'
  })

  const { error } = await supabase.from('notification_queue').insert({
    job_type: 'whatsapp',
    event_type: eventType,
    payload: {
      to: phone,
      recipientName: variables.assigned_rep ?? variables.rep_email ?? '',
      templateId: template.id,
      templateName: template.template_name,
      variables,
      params,
      attachmentUrl: null,
      ticketId: null,
      language: (template.language as string) ?? 'en',
    },
    status: 'pending',
    priority: 4,
    max_retries: 3,
    scheduled_at: new Date().toISOString(),
    created_by: triggeredBy ?? 'system',
  })
  if (error) console.error('[crmEventHandlers] Queue insert failed:', error.message)
}

function triggerWorker(supabase: SupabaseClient): void {
  void supabase.functions
    .invoke('notification-worker', { headers: { 'x-trigger-source': 'crm-event-handler' } })
    .catch(() => {/* worker unavailable — queue still persists */})
}

/** One-time setup — call from App.jsx on mount alongside registerTicketEventHandlers(). */
export function registerCrmEventHandlers(): void {
  for (const eventType of CRM_EVENTS) {
    notificationEventBus.on(eventType, async (event: NotificationEvent) => {
      try {
        const { supabase } = await import('../../api/client.js')

        if (!await isWhatsAppEnabled(supabase)) return
        if (!await isEventEnabled(supabase, event.type)) return

        const template = await fetchActiveTemplate(supabase, event.type)
        if (!template) return

        // CRM notifications go to the assigned rep, not the customer
        const repEmail = (event.metadata?.assigned_rep as string) ?? event.triggeredBy
        const phone = await resolveRepPhone(supabase, repEmail)
        if (!phone) return

        const payload: Record<string, unknown> = {
          ...(event.ticket ?? {}),
          ...(event.customer ?? {}),
          ...(event.metadata ?? {}),
          rep_email: repEmail,
        }

        await queueNotification(supabase, event.type, template, payload, phone, event.triggeredBy)
        triggerWorker(supabase)

      } catch (err) {
        console.error(`[crmEventHandlers] Error handling ${event.type}:`, err)
      }
    })
  }
}
