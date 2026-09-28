import React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../../api/supabaseClient'
import { sodConflicts } from '../../../lib/permissions'
import { EMPTY_ARRAY } from '../../../lib/stableEmpty'
import { SetupCard } from './_shared'

/**
 * Separation of duties (S-02, 20260915). The switch is rma_config
 * 'separation_of_duties' — off by default (owner decision) so a one-manager
 * company can work; on, the database refuses to let the person who created a
 * quotation, sales order, invoice, purchase order or supplier invoice approve
 * it (administrators exempt, owner decision). Below it, who could approve
 * their own document while it is off.
 */
export default function SeparationOfDuties({ enabled, busy, onToggle }) {
  const { t } = useTranslation()
  // Control Panel is administrators' only, so every user row is readable.
  const { data: users = EMPTY_ARRAY, error } = useQuery({
    queryKey: ['user-roles', 'all'],
    queryFn: () => db.userRoles.listAllRoles(),
    staleTime: 60_000,
  })
  const conflicts = sodConflicts(users)

  return (
    <SetupCard title={t('cp.setup.sodTitle')}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">{t('cp.setup.sodHint')}</p>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={onToggle}
          disabled={busy}
          aria-label={t('cp.setup.sodTitle')}
          className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-[#2a3441]'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-1'}`} />
        </button>
      </div>

      <div className="mt-4 border-t border-[#f0f2f6] dark:border-[#1a2230] pt-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.sodConflictsTitle')}</h4>
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">
          {t(enabled ? 'cp.setup.sodConflictsOn' : 'cp.setup.sodConflictsOff')}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 mt-2">{error.message}</p>
        ) : conflicts.length === 0 ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] mt-2">{t('cp.setup.sodNone')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-[#f0f2f6] dark:divide-[#1a2230] text-sm" aria-label={t('cp.setup.sodConflictsTitle')}>
            {conflicts.map((c) => (
              <li key={c.email} className="py-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-[#211f1b] dark:text-[#e8ebf0]">
                  {c.email} <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">· {t(`roles.${c.role}`, { defaultValue: c.role })}</span>
                </span>
                <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                  {c.pairs.map((p) => t(`cp.setup.sodPair_${p}`)).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SetupCard>
  )
}
