import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { Button, Spinner } from '../../components/ui'

const EVENT_LABELS = {
  'ticket.created':      'Ticket Created',
  'ticket.updated':      'Ticket Status Updated',
  'ticket.assigned':     'Ticket Assigned to Technician',
  'ticket.closed':       'Ticket Closed / Completed',
  'payment.received':    'Payment Received',
  'warranty.approved':   'Warranty Approved',
  'replacement.approved':'Replacement Approved',
  'delivery.scheduled':  'Delivery Scheduled',
}

const DEFAULT_SETTINGS = {
  whatsapp_enabled: false,
  email_enabled: true,
  sms_enabled: false,
  whatsapp_config: { phone_number_id: '', business_account_id: '', default_language: 'en', api_version: 'v20.0' },
  notification_events: {
    'ticket.created': true, 'ticket.updated': true, 'ticket.closed': true,
    'ticket.assigned': true, 'payment.received': true, 'warranty.approved': true,
    'replacement.approved': false, 'delivery.scheduled': false,
  },
  retry_config: { max_retries: 3, retry_delay_seconds: 300, backoff_multiplier: 2 },
  rate_limit: { messages_per_minute: 60, messages_per_day: 1000 },
}

function mergeWithDefaults(overrides) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) // deep clone
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = { ...out[k], ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

export default function WASettings({ currentUserEmail }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(DEFAULT_SETTINGS)
  const [initialized, setInitialized] = useState(false)

  const { data: raw, isLoading } = useQuery({
    queryKey: ['notification-settings'],
    queryFn: async () => {
      const result = await db.notificationSettings.getAll()
      return result?.data ?? {}
    },
  })

  // Initialise form from DB data exactly once
  useEffect(() => {
    if (raw && !initialized) {
      setForm(mergeWithDefaults(raw))
      setInitialized(true)
    }
  }, [raw, initialized])

  const settings = form

  function set(path, value) {
    setForm((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) // deep clone to avoid mutation
      const parts = path.split('.')
      let cur = next
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
        cur = cur[parts[i]]
      }
      cur[parts[parts.length - 1]] = value
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await db.notificationSettings.setMultiple({
        whatsapp_enabled:    settings.whatsapp_enabled,
        email_enabled:       settings.email_enabled,
        sms_enabled:         settings.sms_enabled,
        whatsapp_config:     settings.whatsapp_config,
        notification_events: settings.notification_events,
        retry_config:        settings.retry_config,
        rate_limit:          settings.rate_limit,
      }, currentUserEmail)
      setInitialized(false) // allow useEffect to re-sync from fresh query data
      qc.invalidateQueries({ queryKey: ['notification-settings'] })
      toast.success(t('cp.waSettings.saved'))
    } catch (err) {
      toast.error(t('cp.waSettings.saveFailed', { error: err.message }))
    } finally {
      setSaving(false)
    }
  }

  if (isLoading && !initialized) return <div className="flex justify-center py-12"><Spinner /></div>

  return (
    <div className="max-w-3xl space-y-6">
      {/* Provider toggles */}
      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-6">
        <h2 className="text-sm font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-4">
          {t('cp.waSettings.messagingProviders')}
        </h2>
        <div className="space-y-3">
          {[
            { key: 'whatsapp_enabled', label: t('cp.waSettings.whatsappLabel'), icon: '💬', desc: t('cp.waSettings.whatsappDesc') },
            { key: 'email_enabled',    label: t('cp.waSettings.emailLabel'),    icon: '✉️',  desc: t('cp.waSettings.emailDesc') },
            { key: 'sms_enabled',      label: t('cp.waSettings.smsLabel'),      icon: '📱',  desc: t('cp.waSettings.smsDesc') },
          ].map(({ key, label, icon, desc }) => (
            <div key={key} className="flex items-center justify-between p-3.5 rounded-xl border border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <div className="flex items-center gap-3">
                <span className="text-xl">{icon}</span>
                <div>
                  <p className="text-sm font-semibold text-gray-800 dark:text-[#e8ebf0]">{label}</p>
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{desc}</p>
                </div>
              </div>
              <Toggle
                value={!!settings[key]}
                onChange={(v) => set(key, v)}
              />
            </div>
          ))}
        </div>
      </section>

      {/* WhatsApp config */}
      {settings.whatsapp_enabled && (
        <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-6 space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">💬</span>
            <h2 className="text-sm font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
              {t('cp.waSettings.whatsappApi')}
            </h2>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-300">
            <strong>Secrets are stored server-side.</strong> Set <code>WHATSAPP_ACCESS_TOKEN</code> and{' '}
            <code>WHATSAPP_PHONE_NUMBER_ID</code> in your Supabase project → Edge Functions → Secrets.
            {' '}{t('cp.waSettings.tokenWarning')}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t('cp.waSettings.phoneNumberId')} value={settings.whatsapp_config.phone_number_id}
              onChange={(v) => set('whatsapp_config.phone_number_id', v)}
              placeholder="e.g. 1234567890" />
            <Field label={t('cp.waSettings.businessAccountId')} value={settings.whatsapp_config.business_account_id}
              onChange={(v) => set('whatsapp_config.business_account_id', v)}
              placeholder="e.g. 9876543210" />
            <div>
              <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
                {t('cp.waSettings.defaultLanguage')}
              </label>
              <select
                value={settings.whatsapp_config.default_language}
                onChange={(e) => set('whatsapp_config.default_language', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca]"
              >
                <option value="en">{t('cp.waSettings.langEn')}</option>
                <option value="ar">{t('cp.waSettings.langAr')}</option>
                <option value="fr">{t('cp.waSettings.langFr')}</option>
                <option value="es">{t('cp.waSettings.langEs')}</option>
                <option value="de">{t('cp.waSettings.langDe')}</option>
              </select>
            </div>
            <Field label={t('cp.waSettings.apiVersion')} value={settings.whatsapp_config.api_version}
              onChange={(v) => set('whatsapp_config.api_version', v)}
              placeholder="v20.0" />
          </div>
        </section>
      )}

      {/* Per-event toggles */}
      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-6">
        <h2 className="text-sm font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-4">
          {t('cp.waSettings.notificationTriggers')}
        </h2>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-4">
          {t('cp.waSettings.notificationTriggersDesc')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {Object.entries(EVENT_LABELS).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between p-3 rounded-lg border border-[#e6e9ef] dark:border-[#212a38]">
              <span className="text-sm text-gray-700 dark:text-[#e8ebf0]">{label}</span>
              <Toggle
                value={!!settings.notification_events?.[key]}
                onChange={(v) => set(`notification_events.${key}`, v)}
                size="sm"
              />
            </div>
          ))}
        </div>
      </section>

      {/* Retry config */}
      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1">
          {t('cp.waSettings.retryRateLimit')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label={t('cp.waSettings.maxRetries')} type="number" value={settings.retry_config.max_retries}
            onChange={(v) => set('retry_config.max_retries', parseInt(v) || 3)} min={0} max={10} />
          <Field label={t('cp.waSettings.retryDelay')} type="number" value={settings.retry_config.retry_delay_seconds}
            onChange={(v) => set('retry_config.retry_delay_seconds', parseInt(v) || 300)} min={30} />
          <Field label={t('cp.waSettings.backoffMultiplier')} type="number" value={settings.retry_config.backoff_multiplier}
            onChange={(v) => set('retry_config.backoff_multiplier', parseFloat(v) || 2)} min={1} max={5} step={0.5} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label={t('cp.waSettings.messagesPerMinute')} type="number" value={settings.rate_limit.messages_per_minute}
            onChange={(v) => set('rate_limit.messages_per_minute', parseInt(v) || 60)} min={1} max={1000} />
          <Field label={t('cp.waSettings.messagesPerDay')} type="number" value={settings.rate_limit.messages_per_day}
            onChange={(v) => set('rate_limit.messages_per_day', parseInt(v) || 1000)} min={1} />
        </div>
      </section>

      <div className="flex justify-end">
        <Button variant="primary" onClick={handleSave} disabled={saving} className="min-w-[140px]">
          {saving ? <Spinner size="sm" color="white" /> : t('cp.waSettings.saveSettings')}
        </Button>
      </div>
    </div>
  )
}

function Toggle({ value, onChange, size = 'md' }) {
  const w = size === 'sm' ? 'w-9 h-5' : 'w-11 h-6'
  const dot = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'
  const tx = size === 'sm' ? 'translate-x-4' : 'translate-x-5'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex items-center ${w} rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#4338ca] ${value ? 'bg-[#4338ca] dark:bg-[#a5b4fc]' : 'bg-gray-300 dark:bg-[#212a38]'}`}
    >
      <span className={`inline-block ${dot} rounded-full bg-white shadow transform transition-transform ${value ? tx : 'translate-x-1'}`} />
    </button>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder = '', min, max, step }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className="w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
      />
    </div>
  )
}
