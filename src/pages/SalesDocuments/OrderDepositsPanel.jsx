import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Input, Label, Select, Textarea } from '../../components/ui'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { validateDepositAmount } from './_credit'

// A-06 (20260919): deposits taken on a sales order — money received before
// invoicing, held in Customer deposits until applied to one of the customer's
// invoices. In the order's currency. Recording one needs
// accounting.record_payment (record_payment's own rule).

const METHODS = ['bank_transfer', 'cash', 'check', 'card', 'other']
const METHOD_LABEL_KEY = {
  cash: 'accounting.methodCash',
  bank_transfer: 'accounting.methodBankTransfer',
  check: 'accounting.methodCheck',
  card: 'accounting.methodCard',
  other: 'accounting.methodOther',
}
const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function DepositModal({ so, currency, foreign, currentUserEmail, onClose, onSaved }) {
  const { t, i18n } = useTranslation()
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('bank_transfer')
  const [reference, setReference] = useState('')
  const [date, setDate] = useState(todayIso)
  const [notes, setNotes] = useState('')
  const [rate, setRate] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  // a foreign order: the rate starts at the table's rate for the day
  useQuery({
    queryKey: ['exchange-rate', currency, date],
    queryFn: async () => {
      const r = await db.exchangeRates.rateFor(currency, date)
      if (r != null) setRate((cur) => (cur === '' ? String(r) : cur))
      return r
    },
    enabled: foreign,
  })

  const save = async (e) => {
    e.preventDefault()
    const bad = validateDepositAmount(amount)
    if (bad) { setErr(t(bad)); return }
    if (foreign && !(Number(rate) > 0)) { setErr(t('salesDocuments.depErrRate')); return }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const dep = await db.payments.recordDeposit({
        customer_id: so.customer_id,
        amount: Number(amount),
        method,
        reference_number: reference.trim() || null,
        payment_date: date || null,
        notes: notes.trim() || null,
        sales_order_id: so.id,
        currency,
        exchange_rate: foreign ? Number(rate) : null,
        created_by: currentUserEmail,
      })
      toast.success(t('salesDocuments.depSavedToast', { code: dep.payment_code || '' }))
      onSaved()
    } catch (ex) {
      setErr(ex?.message || t('common.error'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('salesDocuments.depTitle')} dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-lg w-full">
        <form onSubmit={save} className="p-5 space-y-3">
          <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.depTitle')}</h2>
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.depHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="dep-amount" required>{t('salesDocuments.depAmount', { currency })}</Label>
              <Input id="dep-amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(null) }} />
            </div>
            <div>
              <Label htmlFor="dep-method">{t('accounting.method')}</Label>
              <Select id="dep-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{t(METHOD_LABEL_KEY[m])}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="dep-date">{t('accounting.colDate')}</Label>
              <Input id="dep-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="dep-ref">{t('accounting.reference')}</Label>
              <Input id="dep-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            {foreign && (
              <div>
                <Label htmlFor="dep-rate" required>{t('salesDocuments.depRate', { currency })}</Label>
                <Input id="dep-rate" inputMode="decimal" value={rate} onChange={(e) => { setRate(e.target.value); setErr(null) }} />
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="dep-notes">{t('salesDocuments.depNotes')}</Label>
            <Textarea id="dep-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={busy}>{t('salesDocuments.depSave')}</Button>
          </div>
        </form>
      </ModalCard>
    </ModalOverlay>
  )
}

export default function OrderDepositsPanel({ so, canRecord, currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const baseCurrency = useBaseCurrency()
  const [open, setOpen] = useState(false)
  const currency = so.currency || baseCurrency
  const foreign = currency !== baseCurrency
  const closed = ['cancelled', 'declined'].includes(so.status)

  const { data: deposits = EMPTY_ARRAY, error } = useQuery({
    queryKey: ['order-deposits', so.id],
    queryFn: () => db.payments.depositsForOrder(so.id),
  })
  const live = deposits.filter((d) => d.status === 'active')
  const taken = live.reduce((s, d) => s + Math.round(Number(d.amount) * 100), 0) / 100
  const left = live.reduce((s, d) => s + Math.round(Number(d.unapplied_amount) * 100), 0) / 100

  if (closed && deposits.length === 0) return null

  return (
    <section aria-label={t('salesDocuments.depPanel')}
      className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
        <div>
          <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.depPanel')}</h3>
          {live.length > 0 && (
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
              {t('salesDocuments.depSummary', { taken: fmtMoney(taken), left: fmtMoney(left), currency })}
            </p>
          )}
        </div>
        {canRecord && !closed && (
          <Button size="sm" onClick={() => setOpen(true)}>{t('salesDocuments.depTake')}</Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="px-4 py-3 text-sm text-red-600 dark:text-red-400">{error.message}</p>
      ) : deposits.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.depNone')}</p>
      ) : (
        <ul className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230] text-sm">
          {deposits.map((d) => (
            <li key={d.id} className="px-4 py-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-[#211f1b] dark:text-[#e8ebf0]">
                <span className="font-mono text-xs">{d.payment_code || '—'}</span>
                <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] ms-2 tabular-nums">{d.payment_date}</span>
                {d.status === 'voided' && <span className="text-xs text-red-600 dark:text-red-400 ms-2">{t('salesDocuments.depVoided')}</span>}
              </span>
              <span className="tabular-nums text-[#211f1b] dark:text-[#e8ebf0]">
                {currency} {fmtMoney(d.amount)}
                {d.status === 'active' && Number(d.unapplied_amount) > 0 && Number(d.unapplied_amount) < Number(d.amount) && (
                  <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] ms-2">{t('salesDocuments.depLeft', { left: fmtMoney(d.unapplied_amount) })}</span>
                )}
                {d.status === 'active' && Number(d.unapplied_amount) === 0 && (
                  <span className="text-xs text-green-700 dark:text-green-400 ms-2">{t('salesDocuments.depUsed')}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <DepositModal so={so} currency={currency} foreign={foreign} currentUserEmail={currentUserEmail}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false)
            queryClient.invalidateQueries({ queryKey: ['order-deposits', so.id] })
            queryClient.invalidateQueries({ queryKey: ['credit-status', so.customer_id] })
            queryClient.invalidateQueries({ queryKey: ['payments'] })
          }} />
      )}
    </section>
  )
}
