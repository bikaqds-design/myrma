import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { Spinner } from '../../components/ui'
import { TICKET_STATUS, TICKET_STATUS_LIST, PRIORITY_LIST } from '../../lib/constants'

const TRIGGER_OPTIONS = [
  { value: 'ticket_created', label: 'Ticket Created' },
  { value: 'ticket_updated', label: 'Ticket Updated' },
  { value: 'ticket_status_changed', label: 'Status Changed' },
  { value: 'ticket_assigned', label: 'Ticket Assigned' },
  { value: 'ticket_overdue', label: 'Ticket Overdue' },
]
const FIELD_OPTIONS = [
  { value: 'ticket_status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assigned_technician', label: 'Technician' },
  { value: 'customer_name', label: 'Customer Name' },
]
const OP_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
]
const ACTION_TYPES = [
  { value: 'change_status', label: 'Change Status' },
  { value: 'change_priority', label: 'Change Priority' },
  { value: 'assign_technician', label: 'Assign Technician' },
  { value: 'create_notification', label: 'Send Notification' },
]
// Read from the shared constants rather than a local copy. The local status
// list offered 'New' — which is not a status this app has — and omitted 'Open',
// 'Pending' and 'Closed', which it does. That is not cosmetic here: applyActions
// in api/db/system.ts writes `ticket_status: a.value` straight to the row with
// no validation, so a rule built from this dropdown could set tickets to a
// status nothing downstream can filter, transition or (before BUG #25 was
// fixed) even display on the board.
const STATUS_OPTIONS = TICKET_STATUS_LIST
const PRIORITY_OPTIONS = PRIORITY_LIST

const EMPTY_RULE = () => ({
  id: Date.now(),
  name: 'New Rule',
  enabled: true,
  trigger: 'ticket_created',
  conditions: [],
  actions: [{ type: 'change_status', value: TICKET_STATUS.IN_PROGRESS }],
})

export default function AutomationRules({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: fetchedRules } = useQuery({
    queryKey: ['automation-rules'],
    queryFn: () => db.automationRules.list(),
  })
  const [rules, setRules] = useState(null)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)

  React.useEffect(() => {
    if (fetchedRules && !rules) setRules(fetchedRules || [])
  }, [fetchedRules, rules])

  const saveAll = async (newRules) => {
    setSaving(true)
    try {
      await db.automationRules.save(newRules, currentUserEmail)
      setRules(newRules)
      queryClient.invalidateQueries({ queryKey: ['automation-rules'] })
      toast.success(t('cp.automationRules.saved'))
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'saveAutomationRules' })
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = (id) => saveAll(rules.filter((r) => r.id !== id))
  const toggleRule = (id) =>
    saveAll(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)))
  const saveEdit = () => {
    if (!editing.name.trim()) {
      toast.error(t('cp.automationRules.ruleRequired'))
      return
    }
    const exists = rules.find((r) => r.id === editing.id)
    const updated = exists
      ? rules.map((r) => (r.id === editing.id ? editing : r))
      : [...rules, editing]
    saveAll(updated).then(() => setEditing(null))
  }

  if (!rules)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )

  if (editing) {
    return (
      <div className="max-w-2xl space-y-4">
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
          <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{editing.name || t('cp.automationRules.newRule')}</span>
        </div>

        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-5 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
              {t('cp.automationRules.ruleName')}
            </label>
            <input
              value={editing.name}
              onChange={(e) => setEditing((r) => ({ ...r, name: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
              placeholder="e.g. Auto-escalate critical tickets"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
              {t('cp.automationRules.triggerEvent')}
            </label>
            <select
              value={editing.trigger}
              onChange={(e) => setEditing((r) => ({ ...r, trigger: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 bg-white dark:bg-[#121823]"
            >
              {TRIGGER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                {t('cp.automationRules.conditions')}
              </label>
              <button
                onClick={() =>
                  setEditing((r) => ({
                    ...r,
                    conditions: [
                      ...r.conditions,
                      { field: 'priority', op: 'equals', value: 'Critical' },
                    ],
                  }))
                }
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                {t('cp.automationRules.addCondition')}
              </button>
            </div>
            {editing.conditions.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">
                {t('cp.automationRules.noConditions')}
              </p>
            )}
            {editing.conditions.map((c, i) => (
              <div key={i} className="flex gap-2 items-center mb-2">
                <select
                  value={c.field}
                  onChange={(e) =>
                    setEditing((r) => {
                      const conds = [...r.conditions]
                      conds[i] = { ...conds[i], field: e.target.value }
                      return { ...r, conditions: conds }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                >
                  {FIELD_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  value={c.op}
                  onChange={(e) =>
                    setEditing((r) => {
                      const conds = [...r.conditions]
                      conds[i] = { ...conds[i], op: e.target.value }
                      return { ...r, conditions: conds }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                >
                  {OP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  value={c.value}
                  onChange={(e) =>
                    setEditing((r) => {
                      const conds = [...r.conditions]
                      conds[i] = { ...conds[i], value: e.target.value }
                      return { ...r, conditions: conds }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm"
                  placeholder={t('cp.automationRules.valuePlaceholder')}
                />
                <button
                  onClick={() =>
                    setEditing((r) => ({
                      ...r,
                      conditions: r.conditions.filter((_, j) => j !== i),
                    }))
                  }
                  className="text-red-400 hover:text-red-600"
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

          {/* Actions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                {t('cp.automationRules.actions')}
              </label>
              <button
                onClick={() =>
                  setEditing((r) => ({
                    ...r,
                    actions: [
                      ...r.actions,
                      { type: 'create_notification', title: 'Alert', value: '' },
                    ],
                  }))
                }
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                {t('cp.automationRules.addAction')}
              </button>
            </div>
            {editing.actions.map((a, i) => (
              <div key={i} className="flex gap-2 items-center mb-2">
                <select
                  value={a.type}
                  onChange={(e) =>
                    setEditing((r) => {
                      const acts = [...r.actions]
                      acts[i] = { ...acts[i], type: e.target.value }
                      return { ...r, actions: acts }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                >
                  {ACTION_TYPES.map((at) => (
                    <option key={at.value} value={at.value}>
                      {at.label}
                    </option>
                  ))}
                </select>
                {a.type === 'change_status' && (
                  <select
                    value={a.value}
                    onChange={(e) =>
                      setEditing((r) => {
                        const acts = [...r.actions]
                        acts[i] = { ...acts[i], value: e.target.value }
                        return { ...r, actions: acts }
                      })
                    }
                    className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                )}
                {a.type === 'change_priority' && (
                  <select
                    value={a.value}
                    onChange={(e) =>
                      setEditing((r) => {
                        const acts = [...r.actions]
                        acts[i] = { ...acts[i], value: e.target.value }
                        return { ...r, actions: acts }
                      })
                    }
                    className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                  >
                    {PRIORITY_OPTIONS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                )}
                {(a.type === 'assign_technician' || a.type === 'create_notification') && (
                  <input
                    value={a.value}
                    onChange={(e) =>
                      setEditing((r) => {
                        const acts = [...r.actions]
                        acts[i] = { ...acts[i], value: e.target.value }
                        return { ...r, actions: acts }
                      })
                    }
                    className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm"
                    placeholder={
                      a.type === 'assign_technician' ? 'email@example.com' : 'Notification message'
                    }
                  />
                )}
                <button
                  onClick={() =>
                    setEditing((r) => ({ ...r, actions: r.actions.filter((_, j) => j !== i) }))
                  }
                  className="text-red-400 hover:text-red-600"
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

          <div className="flex gap-3 pt-2 border-t border-gray-100 dark:border-[#212a38]">
            <button
              onClick={saveEdit}
              disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {saving ? <Spinner size="sm" color="white" /> : null} {t('cp.automationRules.saveRule')}
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
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {t('cp.automationRules.count', { count: rules.length })}
        </p>
        <button
          onClick={() => setEditing(EMPTY_RULE())}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {t('cp.automationRules.newRule')}
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-dashed border-gray-300 dark:border-[#212a38] p-10 text-center">
          <svg
            className="w-10 h-10 text-gray-300 mx-auto mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('cp.automationRules.noRules')}</p>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
            {t('cp.automationRules.subtitle')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-gray-900 dark:text-[#e8ebf0]">{rule.name}</span>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${rule.enabled ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                    >
                      {rule.enabled ? t('cp.active') : t('cp.disabled')}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
                    {t('cp.automationRules.trigger')}{' '}
                    <span className="font-medium text-gray-700 dark:text-[#e8ebf0]">
                      {TRIGGER_OPTIONS.find((opt) => opt.value === rule.trigger)?.label}
                    </span>
                    {rule.conditions.length > 0 && (
                      <>
                        {' '}
                        · {t('cp.automationRules.conditionCount', { count: rule.conditions.length })}
                      </>
                    )}
                    · {t('cp.automationRules.actionCount', { count: rule.actions.length })}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`text-xs px-3 py-1 rounded-lg font-medium ${rule.enabled ? 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100' : 'bg-green-50 text-green-700 hover:bg-green-100'}`}
                  >
                    {rule.enabled ? t('cp.disable') : t('cp.enable')}
                  </button>
                  <button
                    onClick={() => setEditing({ ...rule })}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-gray-50 dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-100 dark:bg-[#1a2230]"
                  >
                    {t('cp.edit')}
                  </button>
                  <button
                    onClick={() => deleteRule(rule.id)}
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
