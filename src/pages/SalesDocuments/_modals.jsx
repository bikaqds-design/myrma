import React, { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Label, Input } from '../../components/ui'
import SalesDocumentForm from './SalesDocumentForm'
import { ProductSearchInput } from '../Pipeline/_shared'

// ── Shared helpers ───────────────────────────────────────────────────────────

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

// ── DocumentFormModal (create + edit) ────────────────────────────────────────

/**
 * DocumentFormModal — wraps the shared SalesDocumentForm in a modal for the
 * standalone create path and for editing an existing document. Pass `initial`
 * (an existing row) to switch the form into edit mode.
 *
 * The card height is left to grow with content; the overlay (items-start +
 * py-8 + overflow-y-auto) handles scrolling, so the title is never clipped.
 */
export function DocumentFormModal({ docType, initial = null, customers, products, salesReps, currentUserEmail, onClose, onSaved }) {
  const { t } = useTranslation()
  const titleKey = initial ? `salesDocuments.editTitle_${docType}` : `salesDocuments.createTitle_${docType}`
  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t(titleKey)}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38]"
      >
        <ModalHeader title={t(titleKey)} onClose={onClose} />
        <div className="px-5 sm:px-6 py-5">
          <SalesDocumentForm
            docType={docType}
            initial={initial}
            customers={customers}
            products={products}
            salesReps={salesReps}
            currentUserEmail={currentUserEmail}
            onCancel={onClose}
            onSaved={onSaved}
          />
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// Backwards-compatible alias for the create-only call site.
export const CreateDocumentModal = DocumentFormModal

// ── RecordPaymentModal ───────────────────────────────────────────────────────

const PAYMENT_METHODS = ['cash', 'bank_transfer', 'check', 'card', 'other']
const PAYMENT_METHOD_LABEL_KEY = {
  cash: 'accounting.methodCash',
  bank_transfer: 'accounting.methodBankTransfer',
  check: 'accounting.methodCheck',
  card: 'accounting.methodCard',
  other: 'accounting.methodOther',
}

export function RecordPaymentModal({ invoice, onClose, onConfirm }) {
  const { t } = useTranslation()
  const total = Number(invoice.total) || 0
  const alreadyPaid = Number(invoice.amount_paid) || 0
  const remaining = Math.max(total - alreadyPaid, 0)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('bank_transfer')

  const num = parseFloat(amount) || 0
  const isValid = num > 0 && num <= remaining + 0.001

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('salesDocuments.recordPayment')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-sm w-full"
      >
        <ModalHeader title={t('salesDocuments.recordPayment')} onClose={onClose} />
        <div className="px-5 py-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl p-3">
              <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-0.5">{t('salesDocuments.grandTotal')}</div>
              <div className="font-semibold text-sm text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(total)}</div>
            </div>
            <div className="bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl p-3">
              <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-0.5">{t('salesDocuments.amountPaid')}</div>
              <div className="font-semibold text-sm text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(alreadyPaid)}</div>
            </div>
            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-3">
              <div className="text-[10px] uppercase text-indigo-500 dark:text-indigo-400 mb-0.5">{t('salesDocuments.remainingBalance')}</div>
              <div className="font-bold text-sm text-[#4338ca] dark:text-[#a5b4fc]">{fmtMoney(remaining)}</div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase mb-1.5">
              {t('salesDocuments.paymentAmount')}
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min={0.01}
              max={remaining}
              step={0.01}
              placeholder={fmtMoney(remaining)}
              className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase mb-1.5">
              {t('accounting.method')}
            </label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none"
            >
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(PAYMENT_METHOD_LABEL_KEY[m])}</option>)}
            </select>
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!isValid} onClick={() => onConfirm(num, method)}>
              {t('salesDocuments.recordPayment')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ── VoidModal ────────────────────────────────────────────────────────────────

export function VoidModal({ requireReason = true, onClose, onConfirm }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const isValid = !requireReason || reason.trim().length > 0

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('salesDocuments.voidConfirm')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full"
      >
        <ModalHeader title={t('salesDocuments.voidConfirm')} onClose={onClose} />
        <div className="px-5 py-5 space-y-4">
          <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3">
            <svg className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
              {requireReason ? t('salesDocuments.voidRequired') : t('salesDocuments.voidConfirm')}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase mb-1.5">
              {t('salesDocuments.voidReason')} {requireReason ? '' : `(${t('common.optional') ?? 'optional'})`}
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('salesDocuments.voidReasonPlaceholder')}
              rows={3}
              className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none resize-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
              autoFocus
            />
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="danger" size="sm" disabled={!isValid} onClick={() => onConfirm(reason.trim())}>
              {t('salesDocuments.voidConfirm')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ── CreateCreditNoteModal ────────────────────────────────────────────────────

const CN_TYPES = ['rebate', 'discount', 'correction']

export function CreateCreditNoteModal({ invoice, onClose, onConfirm }) {
  const { t } = useTranslation()
  const [cnType, setCnType] = useState('discount')
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState(
    (invoice.line_items || []).map((l) => ({ ...l, included: true, adjustedQty: l.qty }))
  )

  const updateLine = (idx, field, val) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: val } : l)))

  const lineTotal = (l) => {
    if (!l.included) return 0
    const qty = Math.min(Number(l.adjustedQty) || 0, l.qty)
    const base = qty * (Number(l.unit_price) || 0)
    const net = base - base * ((Number(l.discount_pct) || 0) / 100)
    return net + net * ((Number(l.tax_pct) || 0) / 100)
  }
  const grandTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0)

  const includedCount = lines.filter((l) => l.included && (Number(l.adjustedQty) || 0) > 0).length
  const isValid = reason.trim().length > 0 && includedCount > 0

  const handleSubmit = () => {
    const included = lines
      .filter((l) => l.included && (Number(l.adjustedQty) || 0) > 0)
      .map((l) => ({
        product_id: l.product_id ?? null,
        product_name: l.product_name,
        qty: Math.min(Number(l.adjustedQty), l.qty),
        unit_price: Number(l.unit_price) || 0,
        restock: false,
      }))
    onConfirm({ type: cnType, reason: reason.trim(), lines: included })
  }

  const TYPE_LABEL_KEY = {
    rebate: 'salesDocuments.cnTypeRebate',
    discount: 'salesDocuments.cnTypeDiscount',
    correction: 'salesDocuments.cnTypeCorrection',
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('salesDocuments.createCreditNote')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full"
      >
        <ModalHeader title={t('salesDocuments.createCreditNote')} onClose={onClose} />
        <div className="px-5 py-5 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase mb-1.5">
                {t('salesDocuments.cnType')}
              </label>
              <select
                value={cnType}
                onChange={(e) => setCnType(e.target.value)}
                className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none"
              >
                {CN_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(TYPE_LABEL_KEY[ty])}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase mb-1.5">
                {t('salesDocuments.cnReason')} *
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('salesDocuments.cnReasonPlaceholder')}
                className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
                autoFocus
              />
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase mb-2">
              {t('salesDocuments.cnLines')}
            </div>
            <div className="rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                    <th className="pl-3 pr-2 py-2 w-8" />
                    <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">
                      {t('salesDocuments.fProduct')}
                    </th>
                    <th className="px-3 py-2 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2] w-24">
                      {t('salesDocuments.fQty')}
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2] w-28">
                      {t('salesDocuments.fLineTotal')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className={`border-b border-[#f0f2f6] dark:border-[#1a2230] ${!l.included ? 'opacity-40' : ''}`}>
                      <td className="pl-3 pr-2 py-2">
                        <input
                          type="checkbox"
                          checked={l.included}
                          onChange={(e) => updateLine(i, 'included', e.target.checked)}
                          className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]">{l.product_name}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          disabled={!l.included}
                          value={l.adjustedQty}
                          onChange={(e) => {
                            const v = Math.min(Math.max(Number(e.target.value) || 0, 0), l.qty)
                            updateLine(i, 'adjustedQty', v)
                          }}
                          min={0}
                          max={l.qty}
                          step={1}
                          className="w-full px-2 py-1 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded text-sm text-center focus:ring-1 focus:ring-[#4338ca] outline-none disabled:opacity-40"
                        />
                        <div className="text-[10px] text-center text-[#746f65] dark:text-[#a4acb7] mt-0.5">
                          max {l.qty}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-[#211f1b] dark:text-[#e8ebf0]">
                        {fmtMoney(lineTotal(l))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex justify-end items-center gap-3 px-4 py-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
                <span className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
                  {t('salesDocuments.grandTotal')}:
                </span>
                <span className="font-bold text-indigo-600 dark:text-[#a5b4fc]">{fmtMoney(grandTotal)}</span>
              </div>
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!isValid} onClick={handleSubmit}>
              {t('salesDocuments.createCreditNote')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ── CreateStandaloneCreditNoteModal ─────────────────────────────────────────
// Standalone CN creation entry point (Sales Documents "+ Create" menu, and the
// RMA ticket "Issue Credit Note" action). Unlike CreateCreditNoteModal above
// (which pre-fills lines from an existing invoice), this builds line items
// from scratch and optionally links to an open invoice so the CN's balance is
// applied against it on issue (see creditNotes.issue() for the apply step).

const ALL_CN_TYPES = ['rma_return', 'rebate', 'discount', 'correction']
const EMPTY_CN_LINE = { product_id: null, product_name: '', qty: 1, unit_price: 0 }

export function CreateStandaloneCreditNoteModal({
  customers = [],
  products = [],
  currentUserEmail,
  initialCustomerId = '',
  initialType = 'discount',
  initialTicketId = null,
  lockCustomer = false,
  onClose,
  onCreated,
}) {
  const { t } = useTranslation()
  const [customerId, setCustomerId] = useState(initialCustomerId)
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const [cnType, setCnType] = useState(initialType)
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState([{ ...EMPTY_CN_LINE }])
  const [saving, setSaving] = useState(false)

  const [linkInvoice, setLinkInvoice] = useState(false)
  const [invoiceId, setInvoiceId] = useState('')
  const [openInvoices, setOpenInvoices] = useState([])
  const [loadingInvoices, setLoadingInvoices] = useState(false)

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
    setInvoiceId('')
    setOpenInvoices([])
    if (!linkInvoice || !customerId) return
    let cancelled = false
    setLoadingInvoices(true)
    db.crmInvoices.list({ customerId, docStatus: 'posted' })
      .then((invoices) => {
        if (cancelled) return
        setOpenInvoices(invoices.filter((inv) => (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0) > 0.001))
      })
      .catch((err) => console.error('load open invoices failed', err))
      .finally(() => { if (!cancelled) setLoadingInvoices(false) })
    return () => { cancelled = true }
  }, [linkInvoice, customerId])

  const updateLine = (i, patch) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const selectProduct = (i, product) => updateLine(i, { product_id: product.id, product_name: product.product_name })
  const addLine = () => setLines((prev) => [...prev, { ...EMPTY_CN_LINE }])
  const removeLine = (i) => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)))

  const lineTotal = (l) => (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
  const grandTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0)

  const cleanedLines = lines.filter((l) => l.product_name.trim() && (Number(l.qty) || 0) > 0)
  const isValid = !!customerId && reason.trim().length > 0 && cleanedLines.length > 0 && (!linkInvoice || !!invoiceId)

  const TYPE_LABEL_KEY = {
    rma_return: 'salesDocuments.cnTypeRmaReturn',
    rebate: 'salesDocuments.cnTypeRebate',
    discount: 'salesDocuments.cnTypeDiscount',
    correction: 'salesDocuments.cnTypeCorrection',
  }

  const handleSubmit = async () => {
    if (!isValid) return
    const selectedInvoice = linkInvoice ? openInvoices.find((inv) => inv.id === invoiceId) : null
    setSaving(true)
    try {
      const cn = await db.creditNotes.create({
        type: cnType,
        customer_id: customerId,
        reason: reason.trim(),
        created_by: currentUserEmail,
        line_items: cleanedLines.map((l) => ({
          product_id: l.product_id ?? null,
          product_name: l.product_name.trim(),
          qty: Number(l.qty) || 0,
          unit_price: Number(l.unit_price) || 0,
          restock: false,
        })),
        source_invoice_id: selectedInvoice?.id ?? null,
        source_invoice_number: selectedInvoice?.inv_code ?? null,
        ticket_id: initialTicketId,
      })
      toast.success(t('salesDocuments.createdToast'))
      onCreated?.(cn)
    } catch (err) {
      console.error('Create standalone credit note failed', err)
      toast.error(t('salesDocuments.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none'

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('salesDocuments.newCreditNote')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full"
      >
        <ModalHeader title={t('salesDocuments.newCreditNote')} onClose={onClose} />
        <div className="px-5 sm:px-6 py-5 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div ref={customerRef} className="relative">
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
                <div className="absolute top-full left-0 mt-1 w-full z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1 max-h-48 overflow-y-auto">
                  {customerMatches.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setCustomerId(c.id); setCustomerQuery(''); setCustomerOpen(false) }}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] flex items-center justify-between gap-2"
                    >
                      <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate">{c.company_name || c.contact_person}</span>
                      {c.customer_code && <span className="text-xs font-mono text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0">{c.customer_code}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <Label>{t('salesDocuments.cnType')}</Label>
              <select
                value={cnType}
                onChange={(e) => setCnType(e.target.value)}
                className={inputCls}
              >
                {ALL_CN_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(TYPE_LABEL_KEY[ty])}</option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <Label required>{t('salesDocuments.cnReason')}</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('salesDocuments.cnReasonPlaceholder')}
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="mb-0">{t('salesDocuments.cnLines')}</Label>
              <button onClick={addLine} className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                + {t('salesDocuments.addLine')}
              </button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="p-3 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <div className="flex items-start gap-2">
                    <ProductSearchInput
                      value={l.product_name}
                      onChange={(text) => updateLine(i, { product_name: text, product_id: null })}
                      onSelectProduct={(p) => selectProduct(i, p)}
                      products={products}
                      placeholder={t('salesDocuments.productPlaceholder')}
                      className="flex-1"
                      inputClassName={inputCls}
                    />
                    <button
                      onClick={() => removeLine(i)}
                      aria-label="remove line"
                      className="mt-1.5 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-2 items-end">
                    <div>
                      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{t('salesDocuments.fQty')}</div>
                      <Input type="number" min={0} value={l.qty} onChange={(e) => updateLine(i, { qty: e.target.value })} className="text-sm" />
                    </div>
                    <div>
                      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{t('salesDocuments.fUnitPrice')}</div>
                      <Input type="number" min={0} value={l.unit_price} onChange={(e) => updateLine(i, { unit_price: e.target.value })} className="text-sm" />
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{t('salesDocuments.fLineTotal')}</div>
                      <div className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] py-2">
                        {fmtMoney(lineTotal(l))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end items-center gap-3 px-1 pt-3">
              <span className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
                {t('salesDocuments.grandTotal')}:
              </span>
              <span className="font-bold text-indigo-600 dark:text-[#a5b4fc]">{fmtMoney(grandTotal)}</span>
            </div>
          </div>

          {/* Link to invoice */}
          <div className="rounded-xl border border-[#e6e9ef] dark:border-[#212a38] p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] cursor-pointer">
              <input
                type="checkbox"
                checked={linkInvoice}
                disabled={!customerId}
                onChange={(e) => setLinkInvoice(e.target.checked)}
                className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
              />
              {t('salesDocuments.cnLinkInvoice')}
            </label>
            {linkInvoice && (
              <div className="mt-3">
                {loadingInvoices ? (
                  <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</div>
                ) : openInvoices.length === 0 ? (
                  <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.cnNoOpenInvoices')}</div>
                ) : (
                  <select
                    value={invoiceId}
                    onChange={(e) => setInvoiceId(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">{t('salesDocuments.cnSelectInvoice')}</option>
                    {openInvoices.map((inv) => {
                      const remaining = (Number(inv.total) || 0) - (Number(inv.amount_paid) || 0)
                      return (
                        <option key={inv.id} value={inv.id}>
                          {inv.inv_code} — {fmtMoney(remaining)} {t('salesDocuments.cnRemainingSuffix')}
                        </option>
                      )
                    })}
                  </select>
                )}
              </div>
            )}
          </div>

          {/* Issuing from a ticket also closes that ticket. It did so silently,
              which is a surprising amount to happen behind one button. */}
          {initialTicketId && (
            <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
              {t('salesDocuments.cnWillCloseTicket')}
            </p>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!isValid} loading={saving} onClick={handleSubmit}>
              {t('salesDocuments.createCreditNote')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
