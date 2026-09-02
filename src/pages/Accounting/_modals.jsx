import React, { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Label, Input, Select, Textarea } from '../../components/ui'

function ModalHeader({ title, onClose }) {
  const { t } = useTranslation()
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between px-5 sm:px-6 py-4 border-b border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#121823] rounded-t-2xl">
      <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{title}</h2>
      <button
        onClick={onClose}
        aria-label={t('common.close')}
        className="text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const METHODS = ['cash', 'bank_transfer', 'check', 'card', 'other']
const METHOD_LABEL_KEY = {
  cash: 'accounting.methodCash',
  bank_transfer: 'accounting.methodBankTransfer',
  check: 'accounting.methodCheck',
  card: 'accounting.methodCard',
  other: 'accounting.methodOther',
}

const todayStr = () => new Date().toISOString().slice(0, 10)

/**
 * RecordPaymentModal — standalone payment entry point (Accounting page).
 * Lets one payment cover several of the customer's open invoices at once
 * (oldest due_date first, suggested via "Auto-allocate"), with leftover
 * staying as unapplied_amount on the payment for later use.
 */
export function RecordPaymentModal({ customers = [], currentUserEmail, initialCustomerId = '', lockCustomer = false, onClose, onRecorded }) {
  const { t } = useTranslation()
  const [customerId, setCustomerId] = useState(initialCustomerId)
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('bank_transfer')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayStr())
  const [notes, setNotes] = useState('')
  const [openInvoices, setOpenInvoices] = useState([])
  const [loadingInvoices, setLoadingInvoices] = useState(false)
  const [allocations, setAllocations] = useState({}) // invoiceId -> amount string
  const [saving, setSaving] = useState(false)

  const customerRef = useRef(null)
  useEffect(() => {
    const handler = (e) => { if (!customerRef.current?.contains(e.target)) setCustomerOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const customerMatches = useMemo(() => {
    const q = customerQuery.trim().toLowerCase()
    if (!q) return []
    return customers
      .filter((c) => (c.company_name || c.contact_person || '').toLowerCase().includes(q) || (c.customer_code || '').toLowerCase().includes(q))
      .slice(0, 8)
  }, [customerQuery, customers])

  const selectedCustomer = customers.find((c) => c.id === customerId)

  useEffect(() => {
    setOpenInvoices([])
    setAllocations({})
    if (!customerId) return
    let cancelled = false
    setLoadingInvoices(true)
    db.crmInvoices.list({ customerId, docStatus: 'posted' })
      .then((invoices) => {
        if (cancelled) return
        const open = invoices
          .filter((inv) => (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0) > 0.001)
          .sort((a, b) => (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'))
        setOpenInvoices(open)
      })
      .catch((err) => console.error('load open invoices failed', err))
      .finally(() => { if (!cancelled) setLoadingInvoices(false) })
    return () => { cancelled = true }
  }, [customerId])

  const totalAmount = parseFloat(amount) || 0
  const allocatedTotal = Object.values(allocations).reduce((sum, v) => sum + (parseFloat(v) || 0), 0)
  const unapplied = Math.max(totalAmount - allocatedTotal, 0)

  const handleAutoAllocate = () => {
    let remaining = totalAmount
    const next = {}
    for (const inv of openInvoices) {
      if (remaining <= 0.001) break
      const due = Math.round(((inv.total ?? 0) - (inv.amount_paid ?? 0)) * 100) / 100
      const give = Math.min(due, remaining)
      if (give > 0) {
        next[inv.id] = give.toFixed(2)
        remaining -= give
      }
    }
    setAllocations(next)
  }

  const updateAllocation = (invoiceId, value) => setAllocations((prev) => ({ ...prev, [invoiceId]: value }))

  const isValid = !!customerId && totalAmount > 0 && allocatedTotal <= totalAmount + 0.001

  const handleSubmit = async () => {
    if (!isValid) return
    setSaving(true)
    try {
      await db.payments.record({
        customer_id: customerId,
        amount: totalAmount,
        method,
        reference_number: referenceNumber.trim() || null,
        payment_date: paymentDate,
        notes: notes.trim() || null,
        created_by: currentUserEmail,
        allocations: Object.entries(allocations)
          .map(([invoice_id, v]) => ({ invoice_id, amount: parseFloat(v) || 0 }))
          .filter((a) => a.amount > 0),
      })
      toast.success(t('accounting.recordedToast'))
      onRecorded?.()
    } catch (err) {
      console.error('Record payment failed', err)
      toast.error(t('accounting.recordFailed'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none'

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('accounting.recordPayment')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full"
      >
        <ModalHeader title={t('accounting.recordPayment')} onClose={onClose} />
        <div className="px-5 sm:px-6 py-5 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div ref={customerRef} className="relative sm:col-span-2">
              <Label required>{t('salesDocuments.fCustomer')}</Label>
              <input
                value={customerId ? (selectedCustomer?.company_name || selectedCustomer?.contact_person || '') : customerQuery}
                onChange={(e) => { if (lockCustomer) return; setCustomerId(''); setCustomerQuery(e.target.value); setCustomerOpen(true) }}
                onFocus={() => { if (!lockCustomer && !customerId && customerQuery.trim()) setCustomerOpen(true) }}
                readOnly={lockCustomer}
                placeholder={t('salesDocuments.selectCustomer')}
                className={`${inputCls} ${lockCustomer ? 'opacity-70 cursor-not-allowed' : ''}`}
                autoComplete="off"
              />
              {!lockCustomer && customerOpen && customerMatches.length > 0 && (
                <div className="absolute top-full start-0 mt-1 w-full z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1 max-h-48 overflow-y-auto">
                  {customerMatches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setCustomerId(c.id); setCustomerQuery(''); setCustomerOpen(false) }}
                      className="w-full px-3 py-2 text-start text-sm hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] flex items-center justify-between gap-2"
                    >
                      <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate">{c.company_name || c.contact_person}</span>
                      {c.customer_code && <span className="text-xs font-mono text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0">{c.customer_code}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <Label required>{t('accounting.amount')}</Label>
              <Input type="number" min={0.01} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <Label>{t('accounting.method')}</Label>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{t(METHOD_LABEL_KEY[m])}</option>)}
              </Select>
            </div>
            <div>
              <Label>{t('accounting.reference')}</Label>
              <Input value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
            </div>
            <div>
              <Label>{t('accounting.colDate')}</Label>
              <Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <Label>{t('salesDocuments.fNotes')}</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>

          {customerId && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="mb-0">{t('accounting.applyToInvoices')}</Label>
                {openInvoices.length > 0 && (
                  <button onClick={handleAutoAllocate} className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                    {t('accounting.autoAllocate')}
                  </button>
                )}
              </div>
              {loadingInvoices ? (
                <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</div>
              ) : openInvoices.length === 0 ? (
                <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.cnNoOpenInvoices')}</div>
              ) : (
                <div className="rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                        <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.colCode')}</th>
                        <th className="px-3 py-2 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fDueDate')}</th>
                        <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.remainingBalance')}</th>
                        <th className="px-3 py-2 text-end text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2] w-28">{t('accounting.applyAmount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openInvoices.map((inv) => {
                        const remaining = Math.round(((inv.total ?? 0) - (inv.amount_paid ?? 0)) * 100) / 100
                        return (
                          <tr key={inv.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0">
                            <td className="px-3 py-2 font-mono text-xs text-[#211f1b] dark:text-[#e8ebf0]">{inv.inv_code}</td>
                            <td className="px-3 py-2 text-[#6c6760] dark:text-[#9aa4b2]">{inv.due_date || '—'}</td>
                            <td className="px-3 py-2 text-end text-[#6c6760] dark:text-[#9aa4b2]">{fmtMoney(remaining)}</td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                min={0}
                                max={remaining}
                                step={0.01}
                                value={allocations[inv.id] ?? ''}
                                onChange={(e) => updateAllocation(inv.id, e.target.value)}
                                className="w-full px-2 py-1 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded text-sm text-end focus:ring-1 focus:ring-[#4338ca] outline-none"
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <div className="flex justify-end items-center gap-4 px-4 py-3 border-t border-[#e6e9ef] dark:border-[#212a38] text-sm">
                    <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.allocated')}: <strong className="text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(allocatedTotal)}</strong></span>
                    <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.unapplied')}: <strong className="text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(unapplied)}</strong></span>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!isValid} loading={saving} onClick={handleSubmit}>
              {t('accounting.recordPayment')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
