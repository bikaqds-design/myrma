import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PageHeader, Button, Label, Select, Input } from '../../components/ui'
import { PageSkeleton } from '../../components/Skeleton'
import Modal from '../../components/Modal'

const DOC_LABEL_KEY = {
  proforma_invoice: 'purchasing.docType_proforma_invoice',
  purchase_order: 'purchasing.docType_purchase_order',
  vendor_invoice: 'purchasing.docType_vendor_invoice',
}

// ─── Purchase Document Detail — lifecycle actions per doc type (Sprint 9) ──────
export default function PurchaseDocumentDetail({ docType, docId, currentUserEmail, onBack }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showReceive, setShowReceive] = useState(false)

  const { data: doc, isLoading } = useQuery({
    queryKey: ['purchase-document', docType, docId],
    queryFn: async () => {
      if (docType === 'proforma_invoice') return db.proformaInvoices.get(docId)
      if (docType === 'purchase_order') return db.purchaseOrders.get(docId)
      if (docType === 'vendor_invoice') return db.vendorInvoices.get(docId)
      throw new Error('Unknown document type')
    },
  })

  const { data: vendor } = useQuery({
    queryKey: ['vendor', doc?.vendor_id],
    queryFn: () => db.vendors.get(doc.vendor_id),
    enabled: !!doc?.vendor_id,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-document', docType, docId] })
    queryClient.invalidateQueries({ queryKey: ['purchasing'] })
  }

  async function handleAction(action) {
    try {
      if (docType === 'proforma_invoice') {
        if (action === 'send') await db.proformaInvoices.markSent(docId)
        if (action === 'accept') await db.proformaInvoices.markAccepted(docId)
        if (action === 'cancel') await db.proformaInvoices.cancel(docId)
        if (action === 'convert') {
          const po = await db.purchaseOrders.create({
            vendorId: doc.vendor_id,
            proformaInvoiceId: docId,
            lineItems: doc.line_items,
            createdBy: currentUserEmail,
          })
          toast.success(t('purchasing.poCreated'))
          invalidate()
          navigate(`/purchasing/purchase_order/${po.id}`)
          return
        }
      } else if (docType === 'purchase_order') {
        if (action === 'send') await db.purchaseOrders.markSent(docId)
        if (action === 'confirm') await db.purchaseOrders.markConfirmed(docId)
        if (action === 'cancel') await db.purchaseOrders.cancel(docId)
        if (action === 'convert') {
          const vi = await db.purchaseOrders.convertToVendorInvoice(docId, currentUserEmail)
          toast.success(t('purchasing.viCreated'))
          invalidate()
          navigate(`/purchasing/vendor_invoice/${vi.id}`)
          return
        }
      } else if (docType === 'vendor_invoice') {
        if (action === 'confirm') await db.vendorInvoices.markConfirmed(docId)
        if (action === 'cancel') await db.vendorInvoices.cancel(docId)
      }
      invalidate()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    }
  }

  if (isLoading || !doc) return <PageSkeleton cols={4} />

  const code = doc.pi_code || doc.po_code || doc.vi_code || t('purchasing.pendingCode')

  return (
    <div className="space-y-6">
      <PageHeader title={`${t(DOC_LABEL_KEY[docType])} · ${code}`} subtitle={vendor?.name || ''}>
        <Button variant="secondary" size="sm" onClick={onBack}>
          {t('common.back')}
        </Button>
      </PageHeader>

      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.colStatus')}: </span>
            <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t(`purchasing.st_${doc.status}`)}</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            {docType === 'proforma_invoice' && doc.status === 'draft' && (
              <Button size="sm" variant="secondary" onClick={() => handleAction('send')}>
                {t('purchasing.markSent')}
              </Button>
            )}
            {docType === 'proforma_invoice' && doc.status === 'sent' && (
              <Button size="sm" variant="primary" onClick={() => handleAction('accept')}>
                {t('purchasing.markAccepted')}
              </Button>
            )}
            {docType === 'proforma_invoice' && doc.status === 'accepted' && (
              <Button size="sm" variant="primary" onClick={() => handleAction('convert')}>
                {t('purchasing.convertToPO')}
              </Button>
            )}
            {docType === 'proforma_invoice' && ['draft', 'sent'].includes(doc.status) && (
              <Button size="sm" variant="danger" onClick={() => handleAction('cancel')}>
                {t('common.cancel')}
              </Button>
            )}

            {docType === 'purchase_order' && doc.status === 'draft' && (
              <Button size="sm" variant="secondary" onClick={() => handleAction('send')}>
                {t('purchasing.markSent')}
              </Button>
            )}
            {docType === 'purchase_order' && doc.status === 'sent' && (
              <Button size="sm" variant="primary" onClick={() => handleAction('confirm')}>
                {t('purchasing.markConfirmed')}
              </Button>
            )}
            {docType === 'purchase_order' && doc.status === 'confirmed' && (
              <Button size="sm" variant="primary" onClick={() => handleAction('convert')}>
                {t('purchasing.convertToVI')}
              </Button>
            )}
            {docType === 'purchase_order' && ['draft', 'sent', 'confirmed'].includes(doc.status) && (
              <Button size="sm" variant="danger" onClick={() => handleAction('cancel')}>
                {t('common.cancel')}
              </Button>
            )}

            {docType === 'vendor_invoice' && doc.status === 'draft' && (
              <Button size="sm" variant="primary" onClick={() => handleAction('confirm')}>
                {t('purchasing.markConfirmed')}
              </Button>
            )}
            {docType === 'vendor_invoice' && ['confirmed', 'partially_received'].includes(doc.status) && (
              <Button size="sm" variant="primary" onClick={() => setShowReceive(true)}>
                {t('purchasing.confirmAndReceive')}
              </Button>
            )}
            {docType === 'vendor_invoice' && ['draft', 'confirmed'].includes(doc.status) && (
              <Button size="sm" variant="danger" onClick={() => handleAction('cancel')}>
                {t('common.cancel')}
              </Button>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-2">
            {t('purchasing.lineItems')}
          </h4>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
                <th className="text-left py-2 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.colProduct')}</th>
                <th className="text-right py-2 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.qtyOrdered')}</th>
                {docType === 'vendor_invoice' && (
                  <th className="text-right py-2 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.qtyReceived')}</th>
                )}
                <th className="text-right py-2 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.unitCost')}</th>
              </tr>
            </thead>
            <tbody>
              {doc.line_items.map((line, i) => (
                <tr key={i} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className="py-2 text-[#211f1b] dark:text-[#e8ebf0]">{line.product_name}</td>
                  <td className="py-2 text-right text-[#211f1b] dark:text-[#e8ebf0]">{line.qty_ordered}</td>
                  {docType === 'vendor_invoice' && (
                    <td className="py-2 text-right text-[#211f1b] dark:text-[#e8ebf0]">{line.qty_received || 0}</td>
                  )}
                  <td className="py-2 text-right text-[#211f1b] dark:text-[#e8ebf0]">{line.unit_cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-right mt-2 font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
            {t('purchasing.total')}: {Number(doc.total).toLocaleString()}
          </div>
        </div>

        {doc.notes && (
          <div>
            <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.notes')}: </span>
            <span className="text-sm text-[#211f1b] dark:text-[#e8ebf0]">{doc.notes}</span>
          </div>
        )}
      </div>

      {showReceive && (
        <ReceiveVendorInvoiceModal
          vi={doc}
          onClose={() => setShowReceive(false)}
          userEmail={currentUserEmail}
          onSuccess={invalidate}
        />
      )}
    </div>
  )
}

// ─── Receive Vendor Invoice — dual-mode confirmation & receipt ─────────────────
function ReceiveVendorInvoiceModal({ vi, onClose, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [warehouseId, setWarehouseId] = useState('')
  const [warehouses, setWarehouses] = useState([])
  const [products, setProducts] = useState([])
  const [entries, setEntries] = useState({}) // lineIndex -> { qty } or { serialsText }
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    db.warehouses.list().then((r) => setWarehouses(r.missing ? [] : r.data))
    db.products.list().then(setProducts).catch(() => {})
  }, [])

  const pendingLines = vi.line_items
    .map((line, i) => ({ ...line, index: i }))
    .filter((line) => (line.qty_received || 0) < line.qty_ordered)

  function productFor(productName) {
    return products.find((p) => p.product_name === productName)
  }

  async function handleSubmit() {
    if (!warehouseId) {
      toast.error(t('inventory.selectDestWarehouse'))
      return
    }
    const receiptLines = []
    for (const line of pendingLines) {
      const product = productFor(line.product_name)
      if (!product) continue
      const entry = entries[line.index]
      if (!entry) continue
      if (product.stock_tracking_mode === 'bulk') {
        const qty = parseInt(entry.qty, 10)
        if (qty > 0) receiptLines.push({ productId: product.id, warehouseId, qty })
      } else {
        const serials = (entry.serialsText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
        if (serials.length) receiptLines.push({ productId: product.id, warehouseId, serials })
      }
    }
    if (receiptLines.length === 0) {
      toast.error(t('purchasing.noReceiptLinesEntered'))
      return
    }
    setSaving(true)
    try {
      await db.vendorInvoices.receive(vi.id, receiptLines, userEmail)
      toast.success(t('purchasing.receiveSuccess'))
      onSuccess()
      onClose()
    } catch (err) {
      toast.error(err.message || t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={t('purchasing.confirmAndReceive')} className="max-w-2xl">
      <div className="space-y-4">
        <div>
          <Label required>{t('inventory.selectDestWarehouse')}</Label>
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className="w-full">
            <option value="">{t('common.select')}</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>

        {pendingLines.length === 0 ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.allLinesReceived')}</p>
        ) : (
          pendingLines.map((line) => {
            const product = productFor(line.product_name)
            const isBulk = product?.stock_tracking_mode === 'bulk'
            const remaining = line.qty_ordered - (line.qty_received || 0)
            return (
              <div key={line.index} className="border border-[#e6e9ef] dark:border-[#212a38] rounded-lg p-3 space-y-2">
                <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">
                  {line.product_name} ({t('purchasing.remainingToReceive', { count: remaining })})
                </div>
                {isBulk ? (
                  <Input
                    type="number"
                    min="0"
                    max={remaining}
                    placeholder={t('inventory.quantity')}
                    onChange={(e) =>
                      setEntries({ ...entries, [line.index]: { qty: e.target.value } })
                    }
                    className="w-full"
                  />
                ) : (
                  <textarea
                    placeholder={t('inventory.serialNumbersPlaceholder')}
                    rows={3}
                    onChange={(e) =>
                      setEntries({ ...entries, [line.index]: { serialsText: e.target.value } })
                    }
                    className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] font-mono"
                  />
                )}
              </div>
            )
          })
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={saving}
            disabled={saving || pendingLines.length === 0}
          >
            {t('purchasing.receiveSubmit')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
