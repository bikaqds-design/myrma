import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { Spinner } from '../../components/ui'

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

export default function SLAPolicies({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: config, isLoading: slaLoading } = useQuery({
    queryKey: ['sla-config'],
    queryFn: () => db.slaConfig.get(),
  })
  const [localConfig, setLocalConfig] = useState(null)
  const [saving, setSaving] = useState(false)

  // Keep local editable copy in sync with fetched config
  React.useEffect(() => {
    if (config && !localConfig) setLocalConfig(config)
  }, [config, localConfig])

  const updatePolicy = (priority, hours) => {
    setLocalConfig((prev) => ({
      ...prev,
      policies: prev.policies.map((p) =>
        p.priority === priority ? { ...p, hours: Number(hours) } : p
      ),
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await db.slaConfig.save(localConfig, currentUserEmail)
      queryClient.invalidateQueries({ queryKey: ['sla-config'] })
      toast.success(t('cp.slaPolicies.saved'))
      db.auditLog
        .log(currentUserEmail, 'sla_updated', 'Updated SLA policy configuration')
        .catch(() => {})
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'saveSLA' })
      toast.error(t('cp.slaPolicies.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  if (slaLoading || !localConfig)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )

  return (
    <div className="max-w-2xl space-y-6">
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('cp.slaPolicies.header')}</h3>
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
              Auto-set ticket due dates based on priority when a new ticket is created.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-sm text-gray-600 dark:text-[#9aa4b2] font-medium">{t('cp.slaPolicies.enabled')}</span>
            <button
              onClick={() => setLocalConfig((c) => ({ ...c, enabled: !c.enabled }))}
              className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${localConfig.enabled ? 'bg-indigo-600' : 'bg-gray-300'}`}
            >
              <span
                className={`absolute top-0.5 start-0.5 w-4 h-4 rounded-full bg-white dark:bg-[#121823] shadow transition-transform ${localConfig.enabled ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
          </label>
        </div>

        <div className={`space-y-3 ${!localConfig.enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          {PRIORITIES.map((p) => {
            const policy = localConfig.policies?.find((pl) => pl.priority === p) || {
              priority: p,
              hours: 72,
            }
            const colors = {
              Critical: 'text-red-600',
              High: 'text-orange-600',
              Medium: 'text-yellow-600',
              Low: 'text-green-600',
            }
            return (
              <div key={p} className="flex items-center gap-4 p-3 bg-gray-50 dark:bg-[#0f1520] rounded-lg">
                <span className={`w-20 text-sm font-semibold ${colors[p]}`}>{p}</span>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="number"
                    min={1}
                    max={8760}
                    value={policy.hours}
                    onChange={(e) => updatePolicy(p, e.target.value)}
                    className="w-24 px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                  />
                  <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('cp.slaPolicies.hours')}</span>
                  <span className="text-xs text-gray-500 dark:text-[#9aa4b2] ms-2">
                    (
                    {policy.hours >= 24 ? `${(policy.hours / 24).toFixed(1)}d` : `${policy.hours}h`}
                    )
                  </span>
                </div>
              </div>
            )
          })}

          <div className="flex items-center gap-3 pt-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <button
                onClick={() => setLocalConfig((c) => ({ ...c, pauseOnHold: !c.pauseOnHold }))}
                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${localConfig.pauseOnHold ? 'bg-indigo-600' : 'bg-gray-300'}`}
              >
                <span
                  className={`absolute top-0.5 start-0.5 w-4 h-4 rounded-full bg-white dark:bg-[#121823] shadow transition-transform ${localConfig.pauseOnHold ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
              <span className="text-sm text-gray-600 dark:text-[#9aa4b2]">
                Pause SLA clock when ticket is "On Hold"
              </span>
            </label>
          </div>
        </div>

        <div className="pt-3 border-t border-gray-100 dark:border-[#212a38]">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Spinner size="sm" color="white" /> : null} {t('cp.slaPolicies.savePolicies')}
          </button>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
        <strong>{t('cp.slaPolicies.howItWorks')}</strong> When SLA is enabled, creating a new ticket will automatically
        set its due date based on the priority selected. The due date can always be overridden
        manually in the ticket form.
      </div>
    </div>
  )
}
