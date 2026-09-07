/**
 * RMA Configuration — ticket defaults. (Audit finding BUG-027.)
 *
 * ── What this screen used to be ─────────────────────────────────────────────
 *
 * Three sections, saving three keys: `sla_rules`, `auto_assignment_rules` and
 * `default_settings`. Nothing anywhere read any of them — this file was the
 * only reference to all three in the entire repository. An administrator could
 * set a "Critical tickets, assign to X" rule, save it, see the success toast,
 * and have every Critical ticket afterwards go unassigned.
 *
 * Worse than dead: the first two duplicated features that DO work.
 *
 *   SLA targets            -> SLA Policies (`sla_config`, read by
 *                             slaConfig.computeDueDate when raising a ticket)
 *   Assignment by condition -> Automation Rules (`assign_technician` action,
 *                             executed by applyActions in api/db/system.ts)
 *
 * So the app had two SLA editors and two assignment-rule editors, one working
 * and one silently discarded, with no way for an admin to tell which was which.
 * Both dead copies are removed here. No capability is lost; the working screens
 * are named on the page so the path is obvious to someone who used to look for
 * them here.
 *
 * ── The third section was worth keeping, so it was made real ────────────────
 *
 * Default priority, default status and the auto due-date window are genuinely
 * useful and cheap to honour, so rather than being deleted they are now read by
 * the ticket form through `useTicketDefaults`. This is the only section left.
 *
 * ── Nothing was lost in the removal ─────────────────────────────────────────
 *
 * Checked against production before deleting: `rma_config` held no `sla_rules`
 * row, no `auto_assignment_rules` row and no `default_settings` row. Nobody has
 * ever pressed Save on this screen in this installation's history, so there are
 * no stored settings to migrate or strand.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'
import { MigrationNotice } from './Announcements'
import { captureException } from '../../lib/sentry'
import { TICKET_STATUS_LIST, PRIORITY_LIST } from '../../lib/constants'
import { TICKET_DEFAULTS, TICKET_DEFAULTS_KEY, normaliseTicketDefaults } from '../../lib/ticketDefaults'

export default function RMAConfig({ currentUserEmail }) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState(TICKET_DEFAULTS)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const cfgResult = await db.rmaConfig.getAll()
      if (cfgResult.missing) {
        setMissing(true)
        setLoading(false)
        return
      }
      const row = cfgResult.data.find((r) => r.config_key === TICKET_DEFAULTS_KEY)
      if (row) setSettings(normaliseTicketDefaults(row.config_value))
    } catch (err) {
      captureException(err)
      toast.error(i18next.t('cp.rmaConfig.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    setSaving(true)
    try {
      await db.rmaConfig.set(TICKET_DEFAULTS_KEY, settings, currentUserEmail)
      toast.success(t('cp.rmaConfig.saved'))
      db.auditLog
        .log(currentUserEmail, 'rma_config_updated', 'Updated default ticket settings')
        .catch(() => {})
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const inp =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'
  const sel =
    'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )
  if (missing) return <MigrationNotice feature="RMA Configuration" sql={RMA_CONFIG_SQL} />

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('cp.rmaConfig.header')}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('cp.rmaConfig.subtitle')}
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
        >
          {saving ? t('cp.saving') : t('cp.rmaConfig.saveAll')}
        </button>
      </div>

      {/* Default Settings */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-1">{t('cp.rmaConfig.defaultSettings')}</h3>
        <p className="text-sm text-gray-500 mb-4">{t('cp.rmaConfig.defaultSettingsDesc')}</p>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="cfg-default-priority">
              {t('cp.rmaConfig.defaultPriority')}
            </label>
            <select
              id="cfg-default-priority"
              value={settings.default_priority}
              onChange={(e) => setSettings({ ...settings, default_priority: e.target.value })}
              className={sel}
            >
              {PRIORITY_LIST.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="cfg-default-status">
              {t('cp.rmaConfig.defaultStatus')}
            </label>
            <select
              id="cfg-default-status"
              value={settings.default_status}
              onChange={(e) => setSettings({ ...settings, default_status: e.target.value })}
              className={sel}
            >
              {TICKET_STATUS_LIST.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="cfg-auto-due-days">
              {t('cp.rmaConfig.autoDueDays')}
            </label>
            <input
              id="cfg-auto-due-days"
              type="number"
              min={1}
              max={365}
              value={settings.auto_due_days}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  auto_due_days: parseInt(e.target.value) || TICKET_DEFAULTS.auto_due_days,
                })
              }
              className={inp}
            />
          </div>
        </div>
      </div>

      {/* Where the two removed sections went. Named rather than silently
          dropped: an admin who used to look for them here needs to know the
          working equivalents exist. */}
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">{t('cp.rmaConfig.movedTitle')}</h3>
        <p className="text-sm text-gray-500">{t('cp.rmaConfig.movedBody')}</p>
      </div>
    </div>
  )
}

const RMA_CONFIG_SQL = `CREATE TABLE IF NOT EXISTS rma_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key TEXT UNIQUE NOT NULL,
  config_value JSONB NOT NULL,
  updated_by TEXT,
  updated_date TIMESTAMPTZ DEFAULT NOW()
);`
