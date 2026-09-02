import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { Spinner } from '../../components/ui'

const WEBHOOK_EVENTS = [
  'ticket_created',
  'ticket_updated',
  'ticket_status_changed',
  'ticket_assigned',
  'ticket_overdue',
  'customer_created',
  'customer_deleted',
  'invoice_created',
  'invoice_paid',
]

const EMPTY_HOOK = () => ({
  id: Date.now(),
  name: '',
  url: '',
  secret: '',
  enabled: true,
  events: [],
})

export default function WebhooksConfig({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: fetchedHooks } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => db.webhooks.list(),
  })
  const [hooks, setHooks] = useState(null)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(null)

  React.useEffect(() => {
    if (fetchedHooks && !hooks) setHooks(fetchedHooks || [])
  }, [fetchedHooks, hooks])

  const saveAll = async (newHooks) => {
    setSaving(true)
    try {
      await db.webhooks.save(newHooks, currentUserEmail)
      setHooks(newHooks)
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      toast.success(t('cp.webhooks.saved'))
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'saveWebhooks' })
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = () => {
    if (!editing.name.trim() || !editing.url.trim()) {
      toast.error(t('cp.webhooks.nameRequired'))
      return
    }
    try {
      new URL(editing.url)
    } catch {
      toast.error(t('cp.webhooks.invalidUrl'))
      return
    }
    const exists = hooks.find((h) => h.id === editing.id)
    const updated = exists
      ? hooks.map((h) => (h.id === editing.id ? editing : h))
      : [...hooks, editing]
    saveAll(updated).then(() => setEditing(null))
  }

  const testHook = async (hook) => {
    setTesting(hook.id)
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(hook.secret ? { 'X-myRMA-Secret': hook.secret } : {}),
        },
        body: JSON.stringify({
          event: 'test',
          timestamp: new Date().toISOString(),
          data: { message: 'Test from myCRM' },
        }),
      })
      res.ok
        ? toast.success(t('cp.webhooks.responded', { status: res.status }))
        : toast.error(t('cp.webhooks.returned', { status: res.status }))
    } catch (err) {
      captureException(err, { page: 'ControlPanel', context: 'testWebhook' })
      toast.error(t('cp.webhooks.failed'))
    } finally {
      setTesting(null)
    }
  }

  if (!hooks)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )

  if (editing)
    return (
      <div className="max-w-lg space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <button
            onClick={() => setEditing(null)}
            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            {t('cp.back')}
          </button>
          <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {editing.name || t('cp.webhooks.addWebhook')}
          </span>
        </div>
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-5 space-y-4">
          {[
            { label: 'Name', key: 'name', placeholder: 'e.g. Notify Slack', type: 'text' },
            {
              label: 'Endpoint URL',
              key: 'url',
              placeholder: 'https://hooks.slack.com/...',
              type: 'url',
            },
            {
              label: 'Secret Header (optional)',
              key: 'secret',
              placeholder: 'Sent as X-myRMA-Secret',
              type: 'text',
            },
          ].map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
                {f.label}
              </label>
              <input
                type={f.type}
                value={editing[f.key]}
                onChange={(e) => setEditing((h) => ({ ...h, [f.key]: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                placeholder={f.placeholder}
              />
            </div>
          ))}

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-2">
              {t('cp.webhooks.eventsLabel')}
            </label>
            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((ev) => (
                <button
                  key={ev}
                  onClick={() =>
                    setEditing((h) => ({
                      ...h,
                      events: h.events.includes(ev)
                        ? h.events.filter((e) => e !== ev)
                        : [...h.events, ev],
                    }))
                  }
                  className={`px-2.5 py-1 text-xs rounded-full font-medium border transition-colors ${editing.events.includes(ev) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-[#121823] text-gray-600 dark:text-[#9aa4b2] border-gray-300 dark:border-[#212a38] hover:border-indigo-400'}`}
                >
                  {ev}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2 border-t border-gray-100 dark:border-[#212a38]">
            <button
              onClick={saveEdit}
              disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {saving ? <Spinner size="sm" color="white" /> : null} {t('cp.webhooks.saveWebhook')}
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-5 py-2 bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0] text-sm font-medium rounded-lg hover:bg-gray-200"
            >
              {t('cp.cancel')}
            </button>
          </div>
        </div>
      </div>
    )

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {t('cp.webhooks.count', { count: hooks.length })}
        </p>
        <button
          onClick={() => setEditing(EMPTY_HOOK())}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('cp.webhooks.addWebhook')}
        </button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">
        Webhooks send a POST request with JSON payload{' '}
        <code className="bg-blue-100 px-1 rounded">{'{ event, timestamp, data }'}</code> to your URL
        on selected events.
      </div>

      {hooks.length === 0 ? (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-dashed border-gray-300 dark:border-[#212a38] p-10 text-center">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('cp.webhooks.noWebhooks')}</p>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
            {t('cp.webhooks.subtitle')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {hooks.map((h) => (
            <div key={h.id} className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-gray-900 dark:text-[#e8ebf0]">{h.name}</span>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${h.enabled ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
                    >
                      {h.enabled ? t('cp.active') : t('cp.disabled')}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-[#9aa4b2] font-mono mt-0.5 truncate">{h.url}</div>
                  {h.events.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {h.events.map((e) => (
                        <span
                          key={e}
                          className="px-1.5 py-0.5 bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] text-xs rounded"
                        >
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => testHook(h)}
                    disabled={testing === h.id}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                  >
                    {testing === h.id ? '…' : t('cp.test')}
                  </button>
                  <button
                    onClick={() => setEditing({ ...h })}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-gray-50 dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-100 dark:bg-[#1a2230]"
                  >
                    {t('cp.edit')}
                  </button>
                  <button
                    onClick={() => saveAll(hooks.filter((wh) => wh.id !== h.id))}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-red-50 text-red-600 hover:bg-red-100"
                  >
                    {t('cp.delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
