import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Input, Label, Spinner } from '../../components/ui'
import Pagination from '../../components/Pagination'
import { useConfirm } from '../../hooks/useConfirm'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { canDo } from '../../lib/permissions'
import { isFinanceRole } from './_periods'
import { lastEndedMonth, monthHasEnded, reconDocLink, revaluationSummary } from './_reports'

// Accounting › Revaluation (A-08c over 20260918): at a month end every open
// foreign balance is valued again at that day's rate. The preview shows each
// item and the unrealised gain or loss; running it (administrators and
// accountants, owner decisions 2026-09-30) posts on the month end to the
// unrealised accounts and reverses on the 1st. Once per month.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtRate = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 }))
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'
const th = 'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'

function ItemsTable({ items, t }) {
  return (
    <div className={`${card} overflow-x-auto`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
            <th className={`${th} text-start`}>{t('accounting.recColDocument')}</th>
            <th className={`${th} text-start`}>{t('accounting.fxrColParty')}</th>
            <th className={`${th} text-end`}>{t('accounting.fxrColOpen')}</th>
            <th className={`${th} text-end`}>{t('accounting.fxrColBookedRate')}</th>
            <th className={`${th} text-end`}>{t('accounting.fxrColMonthEndRate')}</th>
            <th className={`${th} text-end`}>{t('accounting.fxrColEffect')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const href = reconDocLink(i)
            const eff = Number(i.effect)
            return (
              <tr key={`${i.doc_type}-${i.doc_id}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className={td}>
                  <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t(`accounting.recDoc_${i.doc_type}`, { defaultValue: i.doc_type })} </span>
                  {href
                    ? <Link to={href} className="font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline">{i.doc_code || '—'}</Link>
                    : <span className="font-mono text-xs">{i.doc_code || '—'}</span>}
                </td>
                <td className={td}>{i.party_name || '—'}</td>
                <td className={`${td} text-end tabular-nums whitespace-nowrap`}>{i.currency} {fmtMoney(i.open_amount)}</td>
                <td className={`${td} text-end tabular-nums`}>{fmtRate(i.doc_rate)}</td>
                <td className={`${td} text-end tabular-nums`}>
                  {i.rate === null || i.rate === undefined
                    ? <span className="text-red-600 dark:text-red-400">{t('accounting.fxrNoRate')}</span>
                    : fmtRate(i.rate)}
                </td>
                <td className={`${td} text-end tabular-nums font-semibold ${eff > 0 ? 'text-green-700 dark:text-green-400' : eff < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                  {i.effect === null || i.effect === undefined ? '—' : fmtMoney(eff)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Totals({ sum, baseCurrency, t }) {
  const cell = 'flex flex-col gap-0.5'
  return (
    <div className={`${card} p-4 grid gap-3 grid-cols-2 sm:grid-cols-4 text-sm`}>
      <div className={cell}><span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxrGain')}</span><span className="tabular-nums font-bold text-green-700 dark:text-green-400">{fmtMoney(sum.gain)}</span></div>
      <div className={cell}><span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxrLoss')}</span><span className="tabular-nums font-bold text-red-600 dark:text-red-400">{fmtMoney(sum.loss)}</span></div>
      <div className={cell}><span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxrNet', { currency: baseCurrency })}</span><span className="tabular-nums font-bold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(sum.net)}</span></div>
      <div className={cell}><span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxrSides')}</span><span className="tabular-nums text-xs text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.fxrSidesValue', { receivable: fmtMoney(sum.receivable), payable: fmtMoney(sum.payable) })}</span></div>
    </div>
  )
}

export default function FxRevaluationTab({ currentUserRole, currentUserPermissions }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const baseCurrency = useBaseCurrency()
  const { confirm, confirmDialog } = useConfirm()
  const [month, setMonth] = useState(lastEndedMonth)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(12)
  const [openRun, setOpenRun] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  // what the database checks: finance, with accounting.close_period
  const canRun = isFinanceRole(currentUserRole) && canDo(currentUserRole, currentUserPermissions, 'accounting', 'close_period')
  const ended = monthHasEnded(month)

  const monthLabel = (m) => {
    const [y, mo] = String(m).split('-').map(Number)
    return new Date(y, mo - 1, 1).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })
  }

  const runs = useQuery({
    queryKey: ['fx-revaluation', 'runs', page, perPage],
    queryFn: () => db.fxRevaluation.runsPage(page, perPage),
    placeholderData: keepPreviousData,
  })
  const runRows = runs.data?.data ?? EMPTY_ARRAY
  const done = runRows.find((r) => r.period_start === month)

  const preview = useQuery({
    queryKey: ['fx-revaluation', 'preview', month],
    queryFn: () => db.fxRevaluation.preview(month),
    enabled: ended,
  })
  const items = preview.data ?? EMPTY_ARRAY
  const sum = revaluationSummary(items)

  const runLines = useQuery({
    queryKey: ['fx-revaluation', 'lines', openRun],
    queryFn: () => db.fxRevaluation.lines(openRun),
    enabled: !!openRun,
  })

  const run = () =>
    confirm({
      title: t('accounting.fxrRunTitle', { month: monthLabel(month) }),
      message: t('accounting.fxrRunConfirm', { gain: fmtMoney(sum.gain), loss: fmtMoney(sum.loss), currency: baseCurrency }),
      confirmLabel: t('accounting.fxrRun'),
      tone: 'primary',
      onConfirm: async () => {
        if (inFlight.current) return
        inFlight.current = true
        setBusy(true)
        try {
          await db.fxRevaluation.run(month)
          toast.success(t('accounting.fxrDoneToast', { month: monthLabel(month) }))
          queryClient.invalidateQueries({ queryKey: ['fx-revaluation'] })
          queryClient.invalidateQueries({ queryKey: ['ledger'] })
          queryClient.invalidateQueries({ queryKey: ['accounting-periods'] })
        } catch (e) {
          toast.error(e?.message || t('common.error'), { duration: 7000 })
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      },
    })

  return (
    <div className="space-y-4">
      <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-[75ch]">{t('accounting.fxrHint')}</p>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="fxr-month">{t('accounting.fxrMonth')}</Label>
          <Input id="fxr-month" type="month" value={month.slice(0, 7)} max={lastEndedMonth().slice(0, 7)}
            onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} />
        </div>
        {canRun && ended && !done && (
          <Button onClick={run} loading={busy} disabled={busy || preview.isLoading || sum.missingCurrencies.length > 0}>
            {t('accounting.fxrRun')}
          </Button>
        )}
        {done && (
          <p className="text-sm text-green-700 dark:text-green-400 pb-2">{t('accounting.fxrAlreadyDone', { month: monthLabel(month) })}</p>
        )}
      </div>

      {!ended ? (
        <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">{t('accounting.fxrNotEnded')}</p>
      ) : preview.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{preview.error.message}</p>
      ) : preview.isLoading ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : items.length === 0 ? (
        <p className={`${card} p-6 text-sm text-center text-[#6c6760] dark:text-[#9aa4b2]`}>{t('accounting.fxrNone', { month: monthLabel(month) })}</p>
      ) : (
        <>
          {sum.missingCurrencies.length > 0 && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {t('accounting.fxrMissingRates', { currencies: sum.missingCurrencies.join(', ') })}
            </p>
          )}
          {!done && <Totals sum={sum} baseCurrency={baseCurrency} t={t} />}
          {!done && <ItemsTable items={items} t={t} />}
        </>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.fxrHistory')}</h3>
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                <th className={`${th} text-start`}>{t('accounting.fxrMonth')}</th>
                <th className={`${th} text-end`}>{t('accounting.fxrItems')}</th>
                <th className={`${th} text-end`}>{t('accounting.fxrGain')}</th>
                <th className={`${th} text-end`}>{t('accounting.fxrLoss')}</th>
                <th className={`${th} text-start`}>{t('accounting.fxrRunBy')}</th>
                <th className={th}><span className="sr-only">{t('accounting.fxrShowLines')}</span></th>
              </tr>
            </thead>
            <tbody>
              {runs.error ? (
                <tr><td colSpan={6} role="alert" className="py-6 text-center text-sm text-red-600 dark:text-red-400">{runs.error.message}</td></tr>
              ) : runRows.length === 0 && !runs.isLoading ? (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxrNoRuns')}</td></tr>
              ) : runRows.map((r) => (
                <tr key={r.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className={td}>{monthLabel(r.period_start)}</td>
                  <td className={`${td} text-end tabular-nums`}>{r.item_count}</td>
                  <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.total_gain)}</td>
                  <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.total_loss)}</td>
                  <td className={`${td} text-xs`}>{r.created_by || '—'}</td>
                  <td className={`${td} text-end`}>
                    {r.item_count > 0 && (
                      <Button size="sm" variant="secondary" aria-expanded={openRun === r.id}
                        onClick={() => setOpenRun((o) => (o === r.id ? null : r.id))}>
                        {t(openRun === r.id ? 'accounting.fxrHideLines' : 'accounting.fxrShowLines')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(runs.data?.count ?? 0) > perPage && (
          <Pagination total={runs.data.count} page={page} itemsPerPage={perPage} setItemsPerPage={(n) => { setPerPage(n); setPage(1) }} onPage={setPage} />
        )}
        {openRun && (runLines.isLoading
          ? <div className="py-6 flex justify-center"><Spinner /></div>
          : <ItemsTable items={runLines.data ?? EMPTY_ARRAY} t={t} />)}
      </section>
      {confirmDialog}
    </div>
  )
}
