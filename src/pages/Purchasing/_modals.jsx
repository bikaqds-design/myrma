import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import Modal from '../../components/Modal'
import { ModalOverlay, ModalCard, Button, Label, Select, Input, Textarea } from '../../components/ui'
import { ProductSearchInput } from '../Pipeline/_shared'

// Shared modal header — mirrors ModalHeader in SalesDocuments/_modals.jsx so
// every Purchasing modal has the same title bar/close-button chrome.
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

function TotalRow({ label, value, muted }) {
  const cls = muted ? 'text-[#6c6760] dark:text-[#9aa4b2]' : 'text-[#211f1b] dark:text-[#e8ebf0]'
  return (
    <div className="flex items-center justify-between">
      <span className={cls}>{label}</span>
      <span className={cls}>{value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
    </div>
  )
}

// Labeled numeric cell — mirrors NumCell in SalesDocumentForm.jsx so a line's
// Qty/Unit Cost/Discount/Tax fields stay identifiable once they hold a value
// (a bare placeholder disappears the moment the field is non-empty, e.g. "0").
function NumCell({ label, value, onChange, min, max, step }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{label}</div>
      <Input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" />
    </div>
  )
}

// Per-line and document totals — shared by the editor below and by the forms
// that render the Subtotal/Discount/Tax/Grand Total summary (mirrors the
// totals math in SalesDocumentForm.jsx).
function lineTotal(l) {
  const base = (l.qty_ordered || 0) * (l.unit_cost || 0)
  const afterDisc = base - base * ((l.discount_pct || 0) / 100)
  return afterDisc + afterDisc * ((l.tax_pct || 0) / 100)
}
function computeLineTotals(lines) {
  let subtotal = 0, discount = 0, tax = 0
  for (const l of lines) {
    const base = (l.qty_ordered || 0) * (l.unit_cost || 0)
    const disc = base * ((l.discount_pct || 0) / 100)
    const net = base - disc
    subtotal += base; discount += disc; tax += net * ((l.tax_pct || 0) / 100)
  }
  return { subtotal, discount, tax, grand: subtotal - discount + tax }
}

// ─── Shared line-item editor (product search, qty, unit cost, disc/tax) ────────
// Mirrors the line-item card layout in SalesDocumentForm.jsx: label + "add
// line" in a header row, each line as its own inset card.
function LineItemsEditor({ lines, setLines, products, t }) {
  function addLine() {
    setLines([...lines, { product_id: '', product_name: '', qty_ordered: 1, unit_cost: 0, discount_pct: 0, tax_pct: 0 }])
  }
  function updateLine(i, patch) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function removeLine(i) {
    setLines(lines.filter((_, idx) => idx !== i))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Label className="mb-0">{t('purchasing.lineItems')}</Label>
        <button onClick={addLine} className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
          + {t('purchasing.addLine')}
        </button>
      </div>
      <div className="space-y-2">
        {lines.map((line, i) => (
          <div key={i} className="p-3 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
            <div className="flex items-start gap-2">
              <ProductSearchInput
                value={line.product_name}
                onChange={(v) => updateLine(i, { product_name: v })}
                onSelectProduct={(p) => updateLine(i, { product_id: p.id, product_name: p.product_name })}
                products={products}
                placeholder={t('inventory.typeProductName')}
                className="flex-1"
              />
              <button
                onClick={() => removeLine(i)}
                aria-label={t('common.remove')}
                className="mt-1.5 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2 mt-2 items-end">
              <NumCell label={t('purchasing.qty')} min="1" value={line.qty_ordered}
                onChange={(v) => updateLine(i, { qty_ordered: parseInt(v, 10) || 0 })} />
              <NumCell label={t('purchasing.unitCost')} min="0" step="0.01" value={line.unit_cost}
                onChange={(v) => updateLine(i, { unit_cost: parseFloat(v) || 0 })} />
              <NumCell label={t('salesDocuments.fDiscount')} min="0" max="100" value={line.discount_pct ?? ''}
                onChange={(v) => updateLine(i, { discount_pct: parseFloat(v) || 0 })} />
              <NumCell label={t('salesDocuments.fTax')} min="0" max="100" value={line.tax_pct ?? ''}
                onChange={(v) => updateLine(i, { tax_pct: parseFloat(v) || 0 })} />
              <div className="text-right">
                <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{t('salesDocuments.fLineTotal')}</div>
                <div className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] py-2">
                  {lineTotal(line).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Shared vendor field-set (brand + vendor fields) — reused by the Products
// brand modal's "Vendor details" section and the two modals below.
export function VendorFieldsSection({ values, onChange, t }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <Label>{t('purchasing.contactPerson')}</Label>
        <Input value={values.contact_person || ''} onChange={(e) => onChange({ contact_person: e.target.value })} className="w-full" />
      </div>
      <div>
        <Label>{t('common.email')}</Label>
        <Input type="email" value={values.email || ''} onChange={(e) => onChange({ email: e.target.value })} className="w-full" />
      </div>
      <div>
        <Label>{t('purchasing.phone')}</Label>
        <Input value={values.phone || ''} onChange={(e) => onChange({ phone: e.target.value })} className="w-full" />
      </div>
      <div>
        <Label>{t('purchasing.taxId')}</Label>
        <Input value={values.tax_id || ''} onChange={(e) => onChange({ tax_id: e.target.value })} className="w-full" />
      </div>
      <div>
        <Label>{t('purchasing.paymentTerms')}</Label>
        <Input value={values.payment_terms || ''} onChange={(e) => onChange({ payment_terms: e.target.value })} className="w-full" />
      </div>
    </div>
  )
}

// ─── Create Vendor (a Brand with vendor fields) ────────────────────────────────
export function CreateVendorModal({ onClose, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [vendorFields, setVendorFields] = useState({})
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t('purchasing.vendorNameRequired'))
      return
    }
    setSaving(true)
    try {
      await db.brands.create({
        brand_name: name.trim(),
        status: 'active',
        created_by: userEmail,
        ...vendorFields,
      })
      toast.success(t('purchasing.vendorCreated'))
      onSuccess()
      onClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('purchasing.newVendor')} className="max-w-md">
      <div className="space-y-3">
        <div>
          <Label required>{t('purchasing.vendorName')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" autoFocus />
        </div>
        <VendorFieldsSection values={vendorFields} onChange={(patch) => setVendorFields((v) => ({ ...v, ...patch }))} t={t} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>{t('common.create')}</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Edit Vendor (Purchasing's Vendors tab) ────────────────────────────────────
export function VendorEditModal({ vendor, onClose, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [name, setName] = useState(vendor.brand_name || '')
  const [vendorFields, setVendorFields] = useState({
    contact_person: vendor.contact_person, email: vendor.email,
    phone: vendor.phone, tax_id: vendor.tax_id, payment_terms: vendor.payment_terms,
  })
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t('purchasing.vendorNameRequired'))
      return
    }
    setSaving(true)
    try {
      await db.brands.update(vendor.id, { brand_name: name.trim(), updated_by: userEmail, ...vendorFields })
      toast.success(t('purchasing.vendorUpdated'))
      onSuccess()
      onClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('common.edit') + ' — ' + vendor.brand_name} className="max-w-md">
      <div className="space-y-3">
        <div>
          <Label required>{t('purchasing.vendorName')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" autoFocus />
        </div>
        <VendorFieldsSection values={vendorFields} onChange={(patch) => setVendorFields((v) => ({ ...v, ...patch }))} t={t} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Purchase Order form — standalone create OR pre-confirmation edit ──────────
export function CreatePurchaseOrderModal({ mode = 'create', initial, onClose, vendors, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [vendorId, setVendorId] = useState(initial?.vendor_id || '')
  const [lines, setLines] = useState(initial?.line_items || [])
  const [issueDate, setIssueDate] = useState(initial?.issue_date || new Date().toISOString().slice(0, 10))
  const [expectedDate, setExpectedDate] = useState(initial?.expected_delivery_date || '')
  const [currency, setCurrency] = useState(initial?.currency || '')
  const [paymentTerms, setPaymentTerms] = useState(initial?.payment_terms || '')
  const [deliveryTerms, setDeliveryTerms] = useState(initial?.delivery_terms || '')
  const [shippingAddress, setShippingAddress] = useState(initial?.shipping_address || '')
  const [billingAddress, setBillingAddress] = useState(initial?.billing_address || '')
  const [termsConditions, setTermsConditions] = useState(initial?.terms_conditions || '')
  const [notes, setNotes] = useState(initial?.notes || '')
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState([])

  useEffect(() => { db.products.list().then(setProducts).catch(() => {}) }, [])

  const vendorName = useMemo(() => vendors?.find((v) => v.id === vendorId)?.brand_name, [vendors, vendorId])
  // Purchase Orders are placed with one vendor (= one Brand) — only offer
  // that brand's own products, not the whole catalog.
  const vendorProducts = useMemo(() => products.filter((p) => p.brand_id === vendorId), [products, vendorId])

  async function handleSave() {
    if (!vendorId || lines.length === 0) {
      toast.error(t('purchasing.vendorAndLineRequired'))
      return
    }
    setSaving(true)
    try {
      const fields = {
        lineItems: lines,
        issueDate: issueDate || undefined,
        expectedDeliveryDate: expectedDate || undefined,
        currency: currency || undefined,
        paymentTerms: paymentTerms || undefined,
        deliveryTerms: deliveryTerms || undefined,
        shippingAddress: shippingAddress || undefined,
        billingAddress: billingAddress || undefined,
        termsConditions: termsConditions || undefined,
        notes: notes || undefined,
      }
      let row
      if (mode === 'edit') {
        row = await db.purchaseOrders.update(initial.id, {
          line_items: lines, issue_date: issueDate || null, expected_delivery_date: expectedDate || null,
          currency: currency || null, payment_terms: paymentTerms || null, delivery_terms: deliveryTerms || null,
          shipping_address: shippingAddress || null, billing_address: billingAddress || null,
          terms_conditions: termsConditions || null, notes: notes || null,
        })
      } else {
        row = await db.purchaseOrders.create({ vendorId, ...fields, createdBy: userEmail })
      }
      toast.success(t(mode === 'edit' ? 'purchasing.poUpdated' : 'purchasing.poCreated'))
      onSuccess(row)
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  const totals = useMemo(() => computeLineTotals(lines), [lines])
  const titleKey = mode === 'edit' ? 'salesDocuments.edit' : 'purchasing.newPurchaseOrder'

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t(titleKey)} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full">
        <ModalHeader title={t(titleKey)} onClose={onClose} />
        <div className="px-5 sm:px-6 py-5 space-y-4">
          {/* Header fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Label required>{t('purchasing.vendor')}</Label>
              {mode === 'edit' ? (
                <Input value={vendorName || ''} disabled className="w-full opacity-70" />
              ) : (
                <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full">
                  <option value="">{t('common.select')}</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.brand_name}</option>)}
                </Select>
              )}
            </div>
            <div>
              <Label>{t('purchasing.issueDate')}</Label>
              <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="w-full" />
            </div>
            <div>
              <Label>{t('purchasing.expectedDeliveryDate')}</Label>
              <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className="w-full" />
            </div>
            <div>
              <Label>{t('purchasing.currency')}</Label>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full" placeholder="USD" />
            </div>
            <div>
              <Label>{t('purchasing.paymentTerms')}</Label>
              <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className="w-full" />
            </div>
            <div className="sm:col-span-2">
              <Label>{t('purchasing.deliveryTerms')}</Label>
              <Input value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} className="w-full" />
            </div>
          </div>

          {/* Line items */}
          <LineItemsEditor lines={lines} setLines={setLines} products={vendorProducts} t={t} />

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

          {/* Shipping / billing */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>{t('purchasing.shippingAddress')}</Label>
              <Textarea value={shippingAddress} onChange={(e) => setShippingAddress(e.target.value)} rows={2} className="w-full" />
            </div>
            <div>
              <Label>{t('purchasing.billingAddress')}</Label>
              <Textarea value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} rows={2} className="w-full" />
            </div>
          </div>

          {/* Terms & notes */}
          <div>
            <Label>{t('purchasing.termsConditions')}</Label>
            <Textarea value={termsConditions} onChange={(e) => setTermsConditions(e.target.value)} rows={2} className="w-full" />
          </div>
          <div>
            <Label>{t('purchasing.notes')}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full" />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
              {t(mode === 'edit' ? 'common.save' : 'common.create')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ─── Vendor Invoice form — standalone create OR pre-approval edit ──────────────
export function VendorInvoiceFormModal({ mode, initial, vendors, userEmail, onClose, onSuccess }) {
  const { t } = useTranslation()
  const [vendorId, setVendorId] = useState(initial?.vendor_id || '')
  const [lines, setLines] = useState(initial?.line_items || [])
  const [invoiceDate, setInvoiceDate] = useState(initial?.invoice_date || '')
  const [dueDate, setDueDate] = useState(initial?.due_date || '')
  const [notes, setNotes] = useState(initial?.notes || '')
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState([])

  useEffect(() => { db.products.list().then(setProducts).catch(() => {}) }, [])

  const vendorName = useMemo(() => vendors?.find((v) => v.id === vendorId)?.brand_name, [vendors, vendorId])
  // Same scoping as the PO form: only this vendor's (= this brand's) products.
  const vendorProducts = useMemo(() => products.filter((p) => p.brand_id === vendorId), [products, vendorId])

  async function handleSave() {
    if (!vendorId || lines.length === 0) {
      toast.error(t('purchasing.vendorAndLineRequired'))
      return
    }
    setSaving(true)
    try {
      let row
      if (mode === 'edit') {
        row = await db.vendorInvoices.update(initial.id, {
          line_items: lines, invoice_date: invoiceDate || null, due_date: dueDate || null, notes: notes || null,
        })
      } else {
        row = await db.vendorInvoices.create({
          vendorId, lineItems: lines,
          invoiceDate: invoiceDate || undefined, dueDate: dueDate || undefined,
          notes: notes || undefined, createdBy: userEmail,
        })
      }
      toast.success(t(mode === 'edit' ? 'purchasing.viUpdated' : 'purchasing.viCreated'))
      onSuccess(row)
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t(mode === 'edit' ? 'salesDocuments.edit' : 'purchasing.newVendorInvoice')} className="max-w-3xl">
      <div className="space-y-4">
        <div>
          <Label required>{t('purchasing.vendor')}</Label>
          {mode === 'edit' ? (
            <Input value={vendorName || ''} disabled className="w-full opacity-70" />
          ) : (
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full">
              <option value="">{t('common.select')}</option>
              {vendors?.map((v) => <option key={v.id} value={v.id}>{v.brand_name}</option>)}
            </Select>
          )}
        </div>
        <LineItemsEditor lines={lines} setLines={setLines} products={vendorProducts} t={t} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('purchasing.invoiceDate')}</Label>
            <Input type="date" value={invoiceDate || ''} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full" />
          </div>
          <div>
            <Label>{t('purchasing.dueDate')}</Label>
            <Input type="date" value={dueDate || ''} onChange={(e) => setDueDate(e.target.value)} className="w-full" />
          </div>
        </div>
        <div>
          <Label>{t('purchasing.notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
            {t(mode === 'edit' ? 'common.save' : 'common.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Record Vendor Payment — split across one or more open vendor invoices ─────
const METHODS = ['cash', 'bank_transfer', 'check', 'card', 'other']
const METHOD_LABEL_KEY = {
  cash: 'accounting.methodCash', bank_transfer: 'accounting.methodBankTransfer',
  check: 'accounting.methodCheck', card: 'accounting.methodCard', other: 'accounting.methodOther',
}
const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const todayStr = () => new Date().toISOString().slice(0, 10)
const PAYABLE_STATUSES = ['approved', 'partially_received', 'received']

export function RecordVendorPaymentModal({ vendors = [], vendorId: initialVendorId = '', initialInvoiceId, currentUserEmail, onClose, onRecorded }) {
  const { t } = useTranslation()
  const [vendorId, setVendorId] = useState(initialVendorId)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('bank_transfer')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayStr())
  const [notes, setNotes] = useState('')
  const [openInvoices, setOpenInvoices] = useState([])
  const [loadingInvoices, setLoadingInvoices] = useState(false)
  const [allocations, setAllocations] = useState({})
  const [saving, setSaving] = useState(false)

  const selectedVendor = vendors.find((v) => v.id === vendorId)

  useEffect(() => {
    setOpenInvoices([])
    setAllocations({})
    if (!vendorId) return
    let cancelled = false
    setLoadingInvoices(true)
    db.vendorInvoices.list()
      .then((all) => {
        if (cancelled) return
        const open = all
          .filter((vi) => vi.vendor_id === vendorId && PAYABLE_STATUSES.includes(vi.status))
          .filter((vi) => (Number(vi.total) || 0) - (Number(vi.amount_paid) || 0) > 0.001)
          .sort((a, b) => (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'))
        setOpenInvoices(open)
        if (initialInvoiceId) {
          const inv = open.find((vi) => vi.id === initialInvoiceId)
          if (inv) {
            const remaining = Math.round(((inv.total ?? 0) - (inv.amount_paid ?? 0)) * 100) / 100
            setAllocations({ [inv.id]: remaining.toFixed(2) })
            setAmount(remaining.toFixed(2))
          }
        }
      })
      .catch((err) => console.error('load open vendor invoices failed', err))
      .finally(() => { if (!cancelled) setLoadingInvoices(false) })
    return () => { cancelled = true }
  }, [vendorId, initialInvoiceId])

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
      if (give > 0) { next[inv.id] = give.toFixed(2); remaining -= give }
    }
    setAllocations(next)
  }

  const updateAllocation = (invoiceId, value) => setAllocations((prev) => ({ ...prev, [invoiceId]: value }))
  const isValid = !!vendorId && totalAmount > 0 && allocatedTotal <= totalAmount + 0.001

  const handleSubmit = async () => {
    if (!isValid) return
    setSaving(true)
    try {
      await db.vendorPayments.record({
        vendor_id: vendorId,
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
      console.error('Record vendor payment failed', err)
      toast.error(t('accounting.recordFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('purchasing.recordPayment')} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full">
        <ModalHeader title={t('purchasing.recordPayment')} onClose={onClose} />
        <div className="px-5 sm:px-6 py-5 space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label required>{t('purchasing.vendor')}</Label>
              {vendors.length > 0 ? (
                <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} disabled={!!initialInvoiceId}>
                  <option value="">{t('common.select')}</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.brand_name}</option>)}
                </Select>
              ) : (
                <Input value={selectedVendor?.brand_name || ''} disabled />
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

          {vendorId && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="mb-0">{t('purchasing.applyToInvoices')}</Label>
                {openInvoices.length > 0 && (
                  <button onClick={handleAutoAllocate} className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                    {t('accounting.autoAllocate')}
                  </button>
                )}
              </div>
              {loadingInvoices ? (
                <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</div>
              ) : openInvoices.length === 0 ? (
                <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.noOpenInvoices')}</div>
              ) : (
                <div className="rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.colCode')}</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.dueDate')}</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.remainingBalance')}</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2] w-28">{t('accounting.applyAmount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {openInvoices.map((inv) => {
                        const remaining = Math.round(((inv.total ?? 0) - (inv.amount_paid ?? 0)) * 100) / 100
                        return (
                          <tr key={inv.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0">
                            <td className="px-3 py-2 font-mono text-xs text-[#211f1b] dark:text-[#e8ebf0]">{inv.vi_code || '—'}</td>
                            <td className="px-3 py-2 text-[#6c6760] dark:text-[#9aa4b2]">{inv.due_date || '—'}</td>
                            <td className="px-3 py-2 text-right text-[#6c6760] dark:text-[#9aa4b2]">{fmtMoney(remaining)}</td>
                            <td className="px-3 py-2">
                              <input
                                type="number" min={0} max={remaining} step={0.01}
                                value={allocations[inv.id] ?? ''}
                                onChange={(e) => updateAllocation(inv.id, e.target.value)}
                                className="w-full px-2 py-1 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded text-sm text-right focus:ring-1 focus:ring-[#4338ca] outline-none"
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
            <Button size="sm" disabled={!isValid} loading={saving} onClick={handleSubmit}>{t('purchasing.recordPayment')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
