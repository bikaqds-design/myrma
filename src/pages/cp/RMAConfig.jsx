import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { MigrationNotice } from './Announcements'
import { captureException } from '../../lib/sentry'
import { TICKET_STATUS, TICKET_STATUS_LIST, PRIORITY_LIST } from '../../lib/constants'

const DEFAULT_SLA = {
  Low: { response: 72, resolution: 168 },
  Medium: { response: 24, resolution: 72 },
  High: { response: 4, resolution: 24 },
  Critical: { response: 1, resolution: 4 },
}
const DEFAULT_RULES = []
// default_status was 'New', which is not one of the app's statuses and never
// has been — TICKET_STATUS_LIST has no such member, so nothing downstream could
// render, filter or transition it. The two legacy tickets carrying 'New' were
// invisible on the kanban board until BUG #25 was fixed. Defaults now come from
// the same constants every other screen reads.
const DEFAULT_SETTINGS = {
  default_priority: 'Medium',
  default_status: TICKET_STATUS.OPEN,
  auto_due_days: 7,
}
const PRIORITY_COLORS = {
  Low: 'bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#9aa4b2]',
  Medium: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  High: 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
  Critical: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
}

export default function RMAConfig({ currentUserEmail }) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sla, setSla] = useState(DEFAULT_SLA)
  const [rules, setRules] = useState(DEFAULT_RULES)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [users, setUsers] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cfgResult, usersData] = await Promise.all([
        db.rmaConfig.getAll(),
        db.userRoles.listAllRoles(),
      ])
      if (cfgResult.missing) {
        setMissing(true)
        setLoading(false)
        return
      }
      setUsers(usersData)
      const byKey = Object.fromEntries(cfgResult.data.map((r) => [r.config_key, r.config_value]))
      if (byKey.sla_rules) setSla(byKey.sla_rules)
      if (byKey.auto_assignment_rules) setRules(byKey.auto_assignment_rules)
      if (byKey.default_settings) {
        // A previously-saved default may name a status or priority this build no
        // longer has — 'New' is the live example. A <select> whose value is not
        // among its options renders blank and then silently saves whichever
        // option the user's next edit lands on, so fall back to a known-good
        // value rather than showing an empty control.
        const saved = byKey.default_settings
        setSettings({
          ...saved,
          default_status: TICKET_STATUS_LIST.includes(saved.default_status)
            ? saved.default_status
            : DEFAULT_SETTINGS.default_status,
          default_priority: PRIORITY_LIST.includes(saved.default_priority)
            ? saved.default_priority
            : DEFAULT_SETTINGS.default_priority,
        })
      }
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
      await Promise.all([
        db.rmaConfig.set('sla_rules', sla, currentUserEmail),
        db.rmaConfig.set('auto_assignment_rules', rules, currentUserEmail),
        db.rmaConfig.set('default_settings', settings, currentUserEmail),
      ])
      toast.success(t('cp.rmaConfig.saved'))
      db.auditLog
        .log(
          currentUserEmail,
          'rma_config_updated',
          'Updated RMA configuration (SLA rules, assignment rules, default settings)'
        )
        .catch(() => {})
    } catch (err) {
      captureException(err)
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const addRule = () =>
    setRules([
      ...rules,
      { condition_field: 'priority', condition_value: 'Critical', assign_to: '' },
    ])
  const removeRule = (i) => setRules(rules.filter((_, idx) => idx !== i))
  const updateRule = (i, key, val) =>
    setRules(rules.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)))

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
        <h3 className="text-base font-semibold text-gray-900 mb-4">{t('cp.rmaConfig.defaultSettings')}</h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('cp.rmaConfig.defaultPriority')}
            </label>
            <select
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
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('cp.rmaConfig.defaultStatus')}</label>
            <select
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
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              {t('cp.rmaConfig.autoDueDays')}
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={settings.auto_due_days}
              onChange={(e) =>
                setSettings({ ...settings, auto_due_days: parseInt(e.target.value) || 7 })
              }
              className={inp}
            />
          </div>
        </div>
      </div>

      {/* SLA Rules */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-1">{t('cp.rmaConfig.slaRules')}</h3>
        <p className="text-sm text-gray-500 mb-4">
          {t('cp.rmaConfig.slaDesc')}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {[
                  t('cp.rmaConfig.priorityCol'),
                  t('cp.rmaConfig.responseCol'),
                  t('cp.rmaConfig.resolutionCol'),
                ].map((h, i) => (
                  <th
                    key={i}
                    className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {Object.keys(sla).map((priority) => (
                <tr key={priority} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-semibold ${PRIORITY_COLORS[priority]}`}
                    >
                      {priority}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min={1}
                      value={sla[priority].response}
                      onChange={(e) =>
                        setSla({
                          ...sla,
                          [priority]: { ...sla[priority], response: parseInt(e.target.value) || 1 },
                        })
                      }
                      className="w-28 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min={1}
                      value={sla[priority].resolution}
                      onChange={(e) =>
                        setSla({
                          ...sla,
                          [priority]: {
                            ...sla[priority],
                            resolution: parseInt(e.target.value) || 1,
                          },
                        })
                      }
                      className="w-28 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Auto-Assignment Rules */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">{t('cp.rmaConfig.autoAssignment')}</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('cp.rmaConfig.autoAssignDesc')}
            </p>
          </div>
          <button
            onClick={addRule}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
              />
            </svg>
            {t('cp.rmaConfig.addRule')}
          </button>
        </div>
        {rules.length === 0 && (
          <div className="text-center py-8 text-gray-500 border-2 border-dashed border-gray-200 rounded-lg">
            {t('cp.rmaConfig.noRules')}
          </div>
        )}
        <div className="space-y-3">
          {rules.map((rule, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-500 whitespace-nowrap">{t('cp.rmaConfig.when')}</span>
              <select
                value={rule.condition_field}
                onChange={(e) => updateRule(i, 'condition_field', e.target.value)}
                className={`${sel} flex-1`}
              >
                <option value="priority">Priority</option>
                <option value="customer_name">Customer Name</option>
              </select>
              <span className="text-sm text-gray-500">{t('cp.rmaConfig.is')}</span>
              {rule.condition_field === 'priority' ? (
                <select
                  value={rule.condition_value}
                  onChange={(e) => updateRule(i, 'condition_value', e.target.value)}
                  className={`${sel} flex-1`}
                >
                  {['Low', 'Medium', 'High', 'Critical'].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={rule.condition_value}
                  onChange={(e) => updateRule(i, 'condition_value', e.target.value)}
                  placeholder={t('cp.rmaConfig.customerNamePlaceholder')}
                  className={`${inp} flex-1`}
                />
              )}
              <span className="text-sm text-gray-500 whitespace-nowrap">{t('cp.rmaConfig.assignTo')}</span>
              <select
                value={rule.assign_to}
                onChange={(e) => updateRule(i, 'assign_to', e.target.value)}
                className={`${sel} flex-1`}
              >
                <option value="">{t('cp.rmaConfig.selectUser')}</option>
                {users.map((u) => (
                  <option key={u.user_email} value={u.user_email}>
                    {u.user_email}
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeRule(i)}
                className="text-red-400 hover:text-red-600 flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
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
