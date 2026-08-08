import React, { useState, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Input, Select, Textarea, Label } from '../../components/ui'
import { ProductSearchInput } from '../Pipeline/_shared'

const EMPTY_LINE = { product_id: null, product_name: '', description: '', qty: 1, unit_price: 0, discount_pct: null, tax_pct: null }

// Type-specific date field per document type (see the shared layout in the plan).
const DATE_FIELD = {
  quotation:   { key: 'validity_until', labelKey: 'salesDocuments.fValidityUntil' },
  sales_order: { key: 'delivery_date',  labelKey: 'salesDocuments.fDeliveryDate' },
  invoice:     { key: 'due_date',       labelKey: 'salesDocuments.fDueDate' },
}

function lineTotal(l) {
  const base = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
  const net = base - base * ((Number(l.discount_pct) || 0) / 100)
  return net + net * ((Number(l.tax_pct) || 0) / 100)
}

/**
 * Shared create form for Quotation / Sales Order / Invoice.
 * Free-form product names (no product_id) are allowed on quotations only;
 * SO/Invoice lines must resolve to a catalog product.
 */
export default function SalesDocumentForm({ docType, initial = null, customers = [], products = [], salesReps = [], currentUserEmail, onCancel, onSaved }) {
  const { t } = useTranslation()
  const isQuotation = docType === 'quotation'
  const isEdit = !!initial
  const dateField = DATE_FIELD[docType] ?? DATE_FIELD.quotation
  const initialDate = initial?.[dateField.key] ? String(initial[dateField.key]).split('T')[0] : ''

  const [customerId, setCustomerId] = useState(initial?.customer_id || '')
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const [assignedRep, setAssignedRep] = useState(initial?.assigned_rep || '')
  const [referencePo, setReferencePo] = useState(initial?.reference_po || '')
  const [paymentTerms, setPaymentTerms] = useState(initial?.payment_terms || '')
  const [typeDate, setTypeDate] = useState(initialDate)
  const [notes, setNotes] = useState(initial?.notes || '')
  const [lines, setLines] = useState(
    initial?.line_items?.length ? initial.line_items.map((l) => ({ ...EMPTY_LINE, ...l })) : [{ ...EMPTY_LINE }]
  )
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

  const updateLine = (i, patch) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const selectProduct = (i, product) => updateLine(i, { product_id: product.id, product_name: product.product_name })
  const addLine = () => setLines((prev) => [...prev, { ...EMPTY_LINE }])
  const removeLine = (i) => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)))

  const totals = useMemo(() => {
    let subtotal = 0, discount = 0, tax = 0
    for (const l of lines) {
      const base = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
      const disc = base * ((Number(l.discount_pct) || 0) / 100)
      const net = base - disc
      subtotal += base; discount += disc; tax += net * ((Number(l.tax_pct) || 0) / 100)
    }
    return { subtotal, discount, tax, grand: subtotal - discount + tax }
  }, [lines])

  // A draft invoice's only route forward is the Activities approval pool — the
  // detail page deliberately shows "Awaiting approval in Activities" instead of
  // a Post button. The SO → Invoice path raises this activity at conversion
  // (SalesDocumentDetail.createInvoiceApprovalActivity); a standalone invoice
  // created here needs the same, or it sits in draft forever with nothing left
  // to click. Quotations/SOs don't need it — they have an explicit "Send for
  // Approval" action of their own.
  const createInvoiceApprovalActivity = (invoice) => {
    const customer = customers.find((c) => c.id === invoice.customer_id)
    const customerName = customer?.company_name || customer?.contact_person || '—'
    // No inv_code exists yet (post() assigns it), so the code slot carries the
    // customer's own code to keep the pool row searchable.
    const code = customer?.customer_code || ''
    return db.activities.create({
      related_type: 'customer',
      related_id: invoice.customer_id,
      type: 'approval',
      title: `approval|invoice|${invoice.id}|${code}|${invoice.total ?? 0}|${customerName}`,
      due_date: invoice.due_date || new Date().toISOString(),
      assigned_rep: invoice.assigned_rep || null,
      outcome_notes: null,
      created_by: currentUserEmail,
    }).catch((err) => {
      console.error('invoice approval activity failed', err)
      toast.error(t('pipeline.approvalActivityFailed'))
    })
  }

  const handleSave = async () => {
    if (!customerId) { toast.error(t('salesDocuments.errNoCustomer')); return }
    const cleaned = lines.filter((l) => l.product_name.trim())
    if (cleaned.length === 0) { toast.error(t('salesDocuments.errNoLines')); return }
    // SO + Invoice require every line to be a catalog product (product_id set).
    if (!isQuotation && cleaned.some((l) => !l.product_id)) {
      toast.error(t('salesDocuments.errProductRequired')); return
    }

    const line_items = cleaned.map((l) => ({
      product_id: l.product_id ?? null,
      product_name: l.product_name.trim(),
      description: l.description?.trim() || null,
      qty: Number(l.qty) || 0,
      unit_price: Number(l.unit_price) || 0,
      discount_pct: l.discount_pct === '' || l.discount_pct == null ? null : Number(l.discount_pct),
      tax_pct: l.tax_pct === '' || l.tax_pct == null ? null : Number(l.tax_pct),
    }))

    const datePatch = { [dateField.key]: typeDate || null }
    const editFields = {
      line_items,
      payment_terms: paymentTerms || null,
      reference_po: referencePo || null,
      notes: notes || null,
      assigned_rep: assignedRep || null,
      ...datePatch,
    }
    const createPayload = {
      customer_id: customerId,
      line_items,
      payment_terms: paymentTerms || null,
      reference_po: referencePo || null,
      notes: notes || null,
      assigned_rep: assignedRep || null,
      created_by: currentUserEmail,
      ...datePatch,
    }

    const MODULE = { quotation: db.quotations, sales_order: db.salesOrders, invoice: db.crmInvoices }[docType]

    setSaving(true)
    try {
      if (isEdit) {
        await MODULE.update(initial.id, editFields)
        toast.success(t('salesDocuments.savedToast'))
      } else {
        const created = await MODULE.create(createPayload)
        if (docType === 'invoice') await createInvoiceApprovalActivity(created)
        toast.success(t('salesDocuments.createdToast'))
      }
      onSaved?.()
    } catch (err) {
      console.error('Save sales document failed', err)
      toast.error(t('salesDocuments.createFailed'))
    } finally {
      setSaving(false)
    }
  }

  const selectedCustomer = customers.find((c) => c.id === customerId)
  const inputCls = 'w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none'

  return (
    <div className="space-y-4">
      {/* Header fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Customer search */}
        <div ref={customerRef} className="relative">
          <Label required>{t('salesDocuments.fCustomer')}</Label>
          <input
            value={customerId ? (selectedCustomer?.company_name || selectedCustomer?.contact_person || '') : customerQuery}
            onChange={(e) => { if (isEdit) return; setCustomerId(''); setCustomerQuery(e.target.value); setCustomerOpen(true) }}
            onFocus={() => { if (!isEdit && !customerId && customerQuery.trim()) setCustomerOpen(true) }}
            readOnly={isEdit}
            placeholder={t('salesDocuments.selectCustomer')}
            className={`${inputCls} ${isEdit ? 'opacity-70 cursor-not-allowed' : ''}`}
            autoComplete="off"
          />
          {!isEdit && customerOpen && customerMatches.length > 0 && (
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

        {/* Assigned rep */}
        <div>
          <Label>{t('salesDocuments.fRep')}</Label>
          <Select value={assignedRep} onChange={(e) => setAssignedRep(e.target.value)}>
            <option value="">{t('salesDocuments.assignToMe')}</option>
            {salesReps.map((r) => <option key={r.user_email} value={r.user_email}>{r.user_email}</option>)}
          </Select>
        </div>

        {/* Type-specific date */}
        <div>
          <Label>{t(dateField.labelKey)}</Label>
          <Input type="date" value={typeDate} onChange={(e) => setTypeDate(e.target.value)} />
        </div>

        {/* Reference / PO */}
        <div>
          <Label>{t('salesDocuments.fReference')}</Label>
          <Input value={referencePo} onChange={(e) => setReferencePo(e.target.value)} />
        </div>

        {/* Payment terms */}
        <div className="sm:col-span-2">
          <Label>{t('salesDocuments.fPaymentTerms')}</Label>
          <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
        </div>
      </div>

      {/* Line items */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="mb-0">{t('salesDocuments.fLines')}</Label>
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
              <Input
                value={l.description || ''}
                onChange={(e) => updateLine(i, { description: e.target.value })}
                placeholder={t('salesDocuments.fDescription')}
                className="mt-2 text-xs"
              />
              <div className="grid grid-cols-5 gap-2 mt-2 items-end">
                <NumCell label={t('salesDocuments.fQty')} value={l.qty} onChange={(v) => updateLine(i, { qty: v })} />
                <NumCell label={t('salesDocuments.fUnitPrice')} value={l.unit_price} onChange={(v) => updateLine(i, { unit_price: v })} />
                <NumCell label={t('salesDocuments.fDiscount')} value={l.discount_pct ?? ''} onChange={(v) => updateLine(i, { discount_pct: v })} />
                <NumCell label={t('salesDocuments.fTax')} value={l.tax_pct ?? ''} onChange={(v) => updateLine(i, { tax_pct: v })} />
                <div className="text-right">
                  <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{t('salesDocuments.fLineTotal')}</div>
                  <div className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] py-2">
                    {lineTotal(l).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Totals */}
      <div className="flex justify-end">
        <div className="w-full sm:w-64 space-y-1 text-sm">
          <TotalRow label={t('salesDocuments.subtotal')} value={totals.subtotal} />
          {totals.discount > 0 && <TotalRow label={t('salesDocuments.totalDiscount')} value={-totals.discount} muted />}
          {totals.tax > 0 && <TotalRow label={t('salesDocuments.totalTax')} value={totals.tax} muted />}
          <div className="flex items-center justify-between pt-2 mt-1 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.grandTotal')}</span>
            <span className="font-bold text-indigo-600 dark:text-[#a5b4fc]">
              {totals.grand.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div>
        <Label>{t('salesDocuments.fNotes')}</Label>
        <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-2 border-t border-[#e6e9ef] dark:border-[#212a38]">
        <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button onClick={handleSave} loading={saving}>{isEdit ? t('common.save') : t('salesDocuments.create')}</Button>
      </div>
    </div>
  )
}

function NumCell({ label, value, onChange }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{label}</div>
      <Input type="number" value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" />
    </div>
  )
}

function TotalRow({ label, value, muted }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-[#6c6760] dark:text-[#9aa4b2]' : 'text-[#211f1b] dark:text-[#e8ebf0]'}>{label}</span>
      <span className={muted ? 'text-[#6c6760] dark:text-[#9aa4b2]' : 'text-[#211f1b] dark:text-[#e8ebf0]'}>
        {value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
    </div>
  )
}
