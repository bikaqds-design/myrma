import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import Modal from '../../components/Modal'
import { Button, Label, Select, Input, Textarea } from '../../components/ui'
import { ProductSearchInput } from '../Pipeline/_shared'

// ─── Shared line-item editor (product search, qty, unit cost) ─────────────────
function LineItemsEditor({ lines, setLines, products, t }) {
  function addLine() {
    setLines([...lines, { product_id: '', product_name: '', qty_ordered: 1, unit_cost: 0 }])
  }
  function updateLine(i, patch) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function removeLine(i) {
    setLines(lines.filter((_, idx) => idx !== i))
  }
  const total = lines.reduce((sum, l) => sum + (l.qty_ordered || 0) * (l.unit_cost || 0), 0)

  return (
    <div className="space-y-2">
      <Label>{t('purchasing.lineItems')}</Label>
      {lines.map((line, i) => (
        <div key={i} className="flex items-center gap-2">
          <ProductSearchInput
            value={line.product_name}
            onChange={(v) => updateLine(i, { product_name: v })}
            onSelectProduct={(p) => updateLine(i, { product_id: p.id, product_name: p.product_name })}
            products={products}
            placeholder={t('inventory.typeProductName')}
            className="flex-1"
          />
          <Input
            type="number"
            min="1"
            value={line.qty_ordered}
            onChange={(e) => updateLine(i, { qty_ordered: parseInt(e.target.value, 10) || 0 })}
            className="w-20"
            placeholder={t('purchasing.qty')}
          />
          <Input
            type="number"
            min="0"
            step="0.01"
            value={line.unit_cost}
            onChange={(e) => updateLine(i, { unit_cost: parseFloat(e.target.value) || 0 })}
            className="w-28"
            placeholder={t('purchasing.unitCost')}
          />
          <button onClick={() => removeLine(i)} className="text-red-500 hover:text-red-700 text-sm px-1">
            ✕
          </button>
        </div>
      ))}
      <button onClick={addLine} className="text-sm text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
        + {t('purchasing.addLine')}
      </button>
      <div className="text-right text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
        {t('purchasing.total')}: {total.toLocaleString()}
      </div>
    </div>
  )
}

// ─── Create Vendor ──────────────────────────────────────────────────────────────
export function CreateVendorModal({ onClose, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [contactPerson, setContactPerson] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [taxId, setTaxId] = useState('')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t('purchasing.vendorNameRequired'))
      return
    }
    setSaving(true)
    try {
      await db.vendors.create({
        name: name.trim(),
        contact_person: contactPerson || null,
        email: email || null,
        phone: phone || null,
        tax_id: taxId || null,
        payment_terms: paymentTerms || null,
        created_by: userEmail,
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
        <div>
          <Label>{t('purchasing.contactPerson')}</Label>
          <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} className="w-full" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('common.email')}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" />
          </div>
          <div>
            <Label>{t('purchasing.phone')}</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('purchasing.taxId')}</Label>
            <Input value={taxId} onChange={(e) => setTaxId(e.target.value)} className="w-full" />
          </div>
          <div>
            <Label>{t('purchasing.paymentTerms')}</Label>
            <Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} className="w-full" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
            {t('common.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Create Proforma Invoice ─────────────────────────────────────────────────────
export function CreateProformaInvoiceModal({ onClose, vendors, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [vendorId, setVendorId] = useState('')
  const [lines, setLines] = useState([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState([])

  React.useEffect(() => {
    db.products.list().then(setProducts).catch(() => {})
  }, [])

  async function handleSave() {
    if (!vendorId || lines.length === 0) {
      toast.error(t('purchasing.vendorAndLineRequired'))
      return
    }
    setSaving(true)
    try {
      await db.proformaInvoices.create({
        vendorId,
        lineItems: lines,
        notes: notes || undefined,
        createdBy: userEmail,
      })
      toast.success(t('purchasing.proformaCreated'))
      onSuccess()
      onClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('purchasing.newProformaInvoice')} className="max-w-2xl">
      <div className="space-y-4">
        <div>
          <Label required>{t('purchasing.vendor')}</Label>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full">
            <option value="">{t('common.select')}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <LineItemsEditor lines={lines} setLines={setLines} products={products} t={t} />
        <div>
          <Label>{t('purchasing.notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
            {t('common.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Create Purchase Order ────────────────────────────────────────────────────
export function CreatePurchaseOrderModal({ onClose, vendors, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [vendorId, setVendorId] = useState('')
  const [lines, setLines] = useState([])
  const [expectedDate, setExpectedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState([])

  React.useEffect(() => {
    db.products.list().then(setProducts).catch(() => {})
  }, [])

  async function handleSave() {
    if (!vendorId || lines.length === 0) {
      toast.error(t('purchasing.vendorAndLineRequired'))
      return
    }
    setSaving(true)
    try {
      await db.purchaseOrders.create({
        vendorId,
        lineItems: lines,
        expectedDeliveryDate: expectedDate || undefined,
        notes: notes || undefined,
        createdBy: userEmail,
      })
      toast.success(t('purchasing.poCreated'))
      onSuccess()
      onClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('purchasing.newPurchaseOrder')} className="max-w-2xl">
      <div className="space-y-4">
        <div>
          <Label required>{t('purchasing.vendor')}</Label>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full">
            <option value="">{t('common.select')}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <LineItemsEditor lines={lines} setLines={setLines} products={products} t={t} />
        <div>
          <Label>{t('purchasing.expectedDeliveryDate')}</Label>
          <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} className="w-full" />
        </div>
        <div>
          <Label>{t('purchasing.notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
            {t('common.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── Create Vendor Invoice (standalone — not from a PO) ──────────────────────────
export function CreateVendorInvoiceModal({ onClose, vendors, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [vendorId, setVendorId] = useState('')
  const [lines, setLines] = useState([])
  const [invoiceDate, setInvoiceDate] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [products, setProducts] = useState([])

  React.useEffect(() => {
    db.products.list().then(setProducts).catch(() => {})
  }, [])

  async function handleSave() {
    if (!vendorId || lines.length === 0) {
      toast.error(t('purchasing.vendorAndLineRequired'))
      return
    }
    setSaving(true)
    try {
      await db.vendorInvoices.create({
        vendorId,
        lineItems: lines,
        invoiceDate: invoiceDate || undefined,
        notes: notes || undefined,
        createdBy: userEmail,
      })
      toast.success(t('purchasing.viCreated'))
      onSuccess()
      onClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('purchasing.newVendorInvoice')} className="max-w-2xl">
      <div className="space-y-4">
        <div>
          <Label required>{t('purchasing.vendor')}</Label>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="w-full">
            <option value="">{t('common.select')}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <LineItemsEditor lines={lines} setLines={setLines} products={products} t={t} />
        <div>
          <Label>{t('purchasing.invoiceDate')}</Label>
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} className="w-full" />
        </div>
        <div>
          <Label>{t('purchasing.notes')}</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
            {t('common.create')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
