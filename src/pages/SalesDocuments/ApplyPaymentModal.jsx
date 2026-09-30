import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Input, Label, Spinner } from '../../components/ui'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { defaultApplyAmount, validateDepositAmount } from './_credit'

// A-06 (20260919): use money already received — a deposit, or a payment left
// unapplied — against this posted invoice. Only the customer's payments in the
// invoice's currency are offered; apply_payment_to_invoice checks the rest.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function ApplyPaymentModal({ invoice, currency, currentUserEmail, onClose, onApplied }) {
  const { t, i18n } = useTranslation()
  const balance = Math.round((Number(invoice.total) - Number(invoice.amount_paid || 0)) * 100) / 100
  const [picked, setPicked] = useState(null)
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['unapplied-payments', invoice.customer_id, currency],
    queryFn: () => db.payments.unappliedForCustomer(invoice.customer_id, currency),
  })

  const pick = (p) => {
    setPicked(p)
    setAmount(String(defaultApplyAmount(p.unapplied_amount, balance)))
    setErr(null)
  }

  const apply = async (e) => {
    e.preventDefault()
    if (!picked) { setErr(t('salesDocuments.apErrPick')); return }
    const bad = validateDepositAmount(amount)
    const cents = Math.round(Number(amount) * 100)
    if (bad || cents > Math.round(Number(picked.unapplied_amount) * 100) || cents > Math.round(balance * 100)) {
      setErr(t('salesDocuments.apErrAmount', { max: fmtMoney(Math.min(Number(picked.unapplied_amount), balance)) }))
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await db.payments.applyToInvoice({ paymentId: picked.id, invoiceId: invoice.id, amount: cents / 100, actorEmail: currentUserEmail })
      toast.success(t('salesDocuments.apDoneToast'))
      onApplied()
    } catch (ex) {
      setErr(ex?.message || t('common.error'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('salesDocuments.apTitle')} dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-lg w-full">
        <form onSubmit={apply} className="p-5 space-y-3">
          <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.apTitle')}</h2>
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.apBalance', { amount: fmtMoney(balance), currency })}</p>
          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
          ) : isLoading ? (
            <div className="py-6 flex justify-center"><Spinner /></div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.apNone', { currency })}</p>
          ) : (
            <fieldset className="space-y-1.5">
              <legend className="sr-only">{t('salesDocuments.apTitle')}</legend>
              {rows.map((p) => (
                <label key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] px-3 py-2 text-sm cursor-pointer">
                  <span className="flex items-center gap-2">
                    <input type="radio" name="ap-payment" checked={picked?.id === p.id} onChange={() => pick(p)} />
                    <span className="font-mono text-xs">{p.payment_code || '—'}</span>
                    {p.is_deposit && <span className="text-xs rounded-full px-2 py-0.5 bg-indigo-50 text-indigo-700 dark:bg-[#1d2440] dark:text-[#a5b4fc]">{t('salesDocuments.apDeposit')}</span>}
                    <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] tabular-nums">{p.payment_date}</span>
                  </span>
                  <span className="tabular-nums">{t('salesDocuments.apLeft', { left: fmtMoney(p.unapplied_amount) })}</span>
                </label>
              ))}
            </fieldset>
          )}
          {picked && (
            <div>
              <Label htmlFor="ap-amount" required>{t('salesDocuments.apAmount', { currency })}</Label>
              <Input id="ap-amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setErr(null) }} />
            </div>
          )}
          {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={busy} disabled={rows.length === 0}>{t('salesDocuments.apApply')}</Button>
          </div>
        </form>
      </ModalCard>
    </ModalOverlay>
  )
}
