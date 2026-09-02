import React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../../api/supabaseClient'
import { SetupCard } from './_shared'
import { EMPTY_ARRAY } from '../../../lib/stableEmpty'

/**
 * Where document numbering stands.
 *
 * Read-only, and deliberately so. document_sequences carries a
 * `no_direct_client_access` policy and that is correct: it is the gapless
 * counter behind every invoice, credit note and payment code. A screen that
 * could edit it could hand two documents the same number.
 *
 * But "cannot be written" should not mean "cannot be seen" — not knowing where
 * the counters stand is how a restore quietly reissues codes that already
 * exist. This reads them through rma_document_counters() (20260800), which
 * changes nothing.
 *
 * Prefixes are shown but not editable, because they are not stored: they are
 * literals inside nextval_for_type. Making them configurable would not renumber
 * anything already issued — it would start a second series alongside the first,
 * which someone then has to reconcile by hand. That is a deliberate change, not
 * a settings toggle.
 */
const KNOWN_PREFIX = {
  invoice: 'INV',
  credit_note: 'CN',
  payment: 'PMT',
  vendor_payment: 'VPMT',
  vendor_invoice: 'VI',
  quotation: 'QT',
  sales_order: 'SO',
}

export default function DocumentNumbering() {
  const { t } = useTranslation()

  const { data: res, isLoading } = useQuery({
    queryKey: ['document-counters'],
    queryFn: () => db.geo.documentCounters(),
  })

  if (isLoading) {
    return <div className="py-12 text-center text-sm text-gray-500">{t('common.loading')}</div>
  }

  const rows = res?.data ?? EMPTY_ARRAY

  if (res?.missing) {
    return (
      <SetupCard title={t('cp.setup.numberingTitle')}>
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">
          {t('cp.setup.numberingNotProvisioned')}
        </p>
      </SetupCard>
    )
  }

  return (
    <SetupCard title={t('cp.setup.numberingTitle')}>
      <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-4">
        {t('cp.setup.numberingHint')}
      </p>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('cp.setup.numberingEmpty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
                <th className="py-2 text-left text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colDocument')}</th>
                <th className="py-2 text-left text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colPrefix')}</th>
                <th className="py-2 text-center text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colYear')}</th>
                <th className="py-2 text-right text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colIssued')}</th>
                <th className="py-2 text-left text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colNext')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const prefix = KNOWN_PREFIX[r.seq_type] ?? r.seq_type.toUpperCase().slice(0, 3)
                const next = String(r.last_value + 1).padStart(5, '0')
                return (
                  <tr key={r.seq_type} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                    <td className="py-2.5 text-gray-900 dark:text-[#e8ebf0]">
                      {t(`cp.setup.doc_${r.seq_type}`, { defaultValue: r.seq_type })}
                    </td>
                    <td className="py-2.5 font-mono text-gray-700 dark:text-[#e8ebf0]">{prefix}</td>
                    <td className="py-2.5 text-center text-gray-700 dark:text-[#e8ebf0]">{r.seq_year}</td>
                    <td className="py-2.5 text-right text-gray-700 dark:text-[#e8ebf0]">{r.last_value}</td>
                    <td className="py-2.5 font-mono text-xs text-gray-500 dark:text-[#9aa4b2]">
                      {prefix}-{r.seq_year}-{next}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-[#e6e9ef] dark:border-[#212a38] space-y-2">
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
          {t('cp.setup.numberingReadOnly')}
        </p>
        {/* The one operational fact worth surfacing here: a restore that omits
            these counters restarts numbering at 1 and collides with codes that
            already exist. */}
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t('cp.setup.numberingRestoreWarning')}
        </p>
      </div>
    </SetupCard>
  )
}
