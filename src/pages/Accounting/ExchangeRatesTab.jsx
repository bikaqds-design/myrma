import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Input, Label, Select } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { useCurrencyOptions } from '../../hooks/useCurrencyOptions'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { isFinanceRole } from './_periods'
import { latestByCurrency, validateRate } from './_currency'

// Accounting › Exchange rates (A-05b over 20260912). A document takes the
// latest rate on or before its date, and its author may change it until it is
// posted. Administrators and accountants keep the table; everyone who can see
// the ledger can read it.

const th = 'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-4 py-2.5 text-[#211f1b] dark:text-[#e8ebf0]'
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'
const fmtRate = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })
const todayIso = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function ExchangeRatesTab({ currentUserRole }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const canEdit = isFinanceRole(currentUserRole)
  const baseCurrency = useBaseCurrency()
  const options = useCurrencyOptions(baseCurrency).filter((c) => c.code !== baseCurrency)
  const [currency, setCurrency] = useState('')
  const [rateDate, setRateDate] = useState(todayIso())
  const [rate, setRate] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: rows = EMPTY_ARRAY, error } = useQuery({
    queryKey: ['exchange-rates'],
    queryFn: () => db.exchangeRates.list(),
    staleTime: 60_000,
  })
  const latest = latestByCurrency(rows)
  const shown = filter ? rows.filter((r) => r.currency === filter) : rows

  const inFlight = useRef(false)
  const run = async (fn, okKey) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      toast.success(t(okKey))
      queryClient.invalidateQueries({ queryKey: ['exchange-rates'] })
      return true
    } catch (e) {
      toast.error(e?.message || t('common.error'), { duration: 7000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const save = async (e) => {
    e.preventDefault()
    const bad = validateRate({ currency, rateDate, rate, baseCurrency })
    if (bad) { setErr(bad); return }
    if (await run(() => db.exchangeRates.save({ currency, rate_date: rateDate, rate: Number(rate), note: note.trim() || null }), 'accounting.fxSavedToast')) {
      setRate(''); setNote(''); setErr(null)
    }
  }
  const remove = (r) =>
    confirm({
      title: t('accounting.fxDeleteTitle', { currency: r.currency, date: r.rate_date }),
      message: t('accounting.fxDeleteConfirm'),
      confirmLabel: t('accounting.fxDelete'),
      onConfirm: () => run(() => db.exchangeRates.remove(r.currency, r.rate_date), 'accounting.fxDeletedToast'),
    })
  const invalid = (f) => (err?.field === f ? { 'aria-invalid': true, 'aria-describedby': 'fx-err' } : {})

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.fxTitle')}</h2>
        <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-[70ch]">{t('accounting.fxHint', { base: baseCurrency })}</p>
      </div>

      {/* the rate in force today, per currency */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {Object.values(latest).sort((a, b) => a.currency.localeCompare(b.currency)).map((r) => (
          <div key={r.currency} className={`${card} p-4`}>
            <div className="text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxLatest', { currency: r.currency })}</div>
            <div className="text-lg font-bold tabular-nums text-[#211f1b] dark:text-[#e8ebf0]">{fmtRate(r.rate)} {baseCurrency}</div>
            <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxSince', { date: r.rate_date })}</div>
          </div>
        ))}
      </div>

      {canEdit && (
        <form onSubmit={save} className={`${card} p-4 grid gap-3 sm:grid-cols-5 items-end`} aria-label={t('accounting.fxAdd')}>
          <div>
            <Label htmlFor="fx-currency" required>{t('accounting.fxCurrency')}</Label>
            <Select id="fx-currency" value={currency} onChange={(e) => { setCurrency(e.target.value); setErr(null) }} {...invalid('currency')}>
              <option value="">{t('accounting.fxChoose')}</option>
              {options.map((c) => <option key={c.code} value={c.code}>{`${c.code} — ${c.name}`}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="fx-date" required>{t('accounting.fxDate')}</Label>
            <Input id="fx-date" type="date" value={rateDate} onChange={(e) => { setRateDate(e.target.value); setErr(null) }} {...invalid('date')} />
          </div>
          <div>
            <Label htmlFor="fx-rate" required>{t('accounting.fxRate', { base: baseCurrency })}</Label>
            <Input id="fx-rate" type="number" step="0.00000001" min="0" value={rate} onChange={(e) => { setRate(e.target.value); setErr(null) }} {...invalid('rate')} />
          </div>
          <div>
            <Label htmlFor="fx-note">{t('accounting.fxNote')}</Label>
            <Input id="fx-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button type="submit" loading={busy}>{t('accounting.fxSave')}</Button>
          <p className="sm:col-span-5 text-xs text-[#6c6760] dark:text-[#9aa4b2]">
            {currency && Number(rate) > 0
              ? t('accounting.fxPreview', { currency, rate: fmtRate(rate), base: baseCurrency })
              : t('accounting.fxSaveHint')}
          </p>
          {err && <p id="fx-err" role="alert" className="sm:col-span-5 text-xs text-red-600 dark:text-red-400">{t(err.key, { base: baseCurrency })}</p>}
        </form>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.fxHistory')}</h3>
        <Select aria-label={t('accounting.fxCurrency')} value={filter} onChange={(e) => setFilter(e.target.value)} className="w-auto">
          <option value="">{t('accounting.fxAllCurrencies')}</option>
          {Object.keys(latest).sort().map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </div>
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.fxDate')}</th>
              <th className={`${th} text-start`}>{t('accounting.fxCurrency')}</th>
              <th className={`${th} text-end`}>{t('accounting.fxRate', { base: baseCurrency })}</th>
              <th className={`${th} text-start`}>{t('accounting.fxNote')}</th>
              {canEdit && <th className={th}><span className="sr-only">{t('accounting.fxDelete')}</span></th>}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={5} role="alert" className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error.message}</td></tr>
            ) : shown.length === 0 ? (
              <tr><td colSpan={5} className="py-8 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.fxNone')}</td></tr>
            ) : shown.map((r) => (
              <tr key={`${r.currency}-${r.rate_date}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className={`${td} tabular-nums`}>{r.rate_date}</td>
                <td className={td}><span className="font-mono text-xs">{r.currency}</span></td>
                <td className={`${td} text-end tabular-nums`}>{fmtRate(r.rate)}</td>
                <td className={`${td} text-[#6c6760] dark:text-[#9aa4b2]`}>{r.note || '—'}</td>
                {canEdit && (
                  <td className={`${td} text-end`}>
                    <Button size="sm" variant="secondary" onClick={() => remove(r)}>{t('accounting.fxDelete')}</Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirmDialog}
    </div>
  )
}
