import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useProductsById } from '../../lib/useLookups'
import { ModalOverlay, ModalCard, Button, Input, Textarea, Label, Select } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { receiptProgress, validateReceipt, parseSerials, unbilledLines, receivableWarehouses } from './_receipts'
import { downloadGoodsReceiptNotePDF } from '../../lib/goodsReceiptNotePdf'

// Goods receipts of one purchase order (P-03a, 20260897) and invoicing what
// they brought in (P-03b, 20260898). Managers and above receive, confirm,
// cancel and raise the supplier invoice; the database enforces that and every
// quantity and serial rule — this screen only offers what the rules allow.

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

const GRN_PILL = {
  draft:     'bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  cancelled: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
}

export default function GoodsReceiptsPanel({ po, vendor, isManager, currentUserEmail, onInvoiceCreated }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const { data: poLines = EMPTY_ARRAY } = useQuery({
    queryKey: ['purchase-order-lines', po.id],
    queryFn: () => db.purchaseOrders.lines(po.id),
  })
  const { data: receipts = EMPTY_ARRAY } = useQuery({
    queryKey: ['goods-receipts', po.id],
    queryFn: () => db.goodsReceipts.listForOrder(po.id),
  })
  const { data: billed = {} } = useQuery({
    queryKey: ['goods-receipts-billed', po.id],
    queryFn: () => db.goodsReceipts.billedLines(po.id),
  })
  const { data: warehouses = EMPTY_ARRAY } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => db.warehouses.list().then((r) => (r.missing ? [] : r.data)),
  })
  const productsById = useProductsById(poLines.map((l) => l.product_id))

  const progress = useMemo(() => receiptProgress(poLines, receipts, productsById), [poLines, receipts, productsById])
  const openTotal = progress.reduce((s, p) => s + p.open, 0)
  const toBill = useMemo(() => unbilledLines(receipts, billed), [receipts, billed])
  const warehouseNames = useMemo(() => Object.fromEntries(warehouses.map((w) => [w.id, w.name])), [warehouses])
  const hasServiceLines = poLines.some((l) => l.product_id && productsById[l.product_id]?.product_type === 'service')
  const canReceiveMore = ['confirmed', 'partially_completed'].includes(po.status) && openTotal > 0

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['goods-receipts', po.id] })
    queryClient.invalidateQueries({ queryKey: ['goods-receipts-billed', po.id] })
    queryClient.invalidateQueries({ queryKey: ['vendor-invoices-by-po', po.id] })
    queryClient.invalidateQueries({ queryKey: ['purchase-document', 'purchase_order', po.id] })
    queryClient.invalidateQueries({ queryKey: ['purchase-documents'] })
    queryClient.invalidateQueries({ queryKey: ['inventory'] })
  }
  // A ref, not only the busy state: a second click can land before React has
  // re-rendered the disabled button, and each action must reach the server once.
  const inFlight = useRef(false)
  const run = async (fn, okKey) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      if (okKey) toast.success(t(okKey))
      refresh()
    } catch (err) {
      console.error(err)
      toast.error(err?.message || t('common.error'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const handleConfirm = (r) =>
    confirm({
      title: t('purchasing.grnConfirmTitle'),
      message: t('purchasing.grnConfirmMsg'),
      confirmLabel: t('purchasing.grnConfirm'),
      tone: 'primary', // a normal step, not a destructive one
      onConfirm: () => run(() => db.goodsReceipts.confirm(r.id, currentUserEmail), 'purchasing.grnConfirmedToast'),
    })
  const handleCancel = (r) =>
    confirm({
      title: t('purchasing.grnCancelTitle'),
      message: t('purchasing.grnCancelMsg'),
      confirmLabel: t('purchasing.grnCancel'),
      onConfirm: () => run(() => db.goodsReceipts.cancel(r.id, currentUserEmail), 'purchasing.grnCancelledToast'),
    })
  const handleInvoice = () =>
    run(async () => {
      const vi = await db.goodsReceipts.invoice(po.id, null, currentUserEmail)
      toast.success(t('purchasing.grnInvoicedToast'))
      refresh()
      onInvoiceCreated?.(vi)
    })
  const handleCreate = (lines, fields) =>
    run(async () => {
      await db.goodsReceipts.create(po.id, lines, fields, currentUserEmail)
      setShowCreate(false)
    }, 'purchasing.grnCreatedToast')

  const invoiceOf = (r) => {
    const ids = [...new Set((r.goods_receipt_lines || []).map((l) => billed[l.id]).filter(Boolean))]
    return ids.length === 1 && (r.goods_receipt_lines || []).every((l) => billed[l.id]) ? ids[0] : null
  }

  const th = 'px-3 py-2 text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]'
  const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
        <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('purchasing.grnTitle')}</h3>
        <div className="flex items-center gap-2">
          {toBill.length > 0 && (
            <Button size="sm" variant="secondary" disabled={!isManager || busy} onClick={handleInvoice}>
              {t('purchasing.grnInvoice', { count: toBill.length })}
            </Button>
          )}
          {canReceiveMore && (
            <Button size="sm" disabled={!isManager || busy} onClick={() => setShowCreate(true)}>
              {t('purchasing.grnNew')}
            </Button>
          )}
        </div>
      </div>

      {progress.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
              <th className={`${th} text-start ps-4`}>{t('purchasing.grnColProduct')}</th>
              <th className={`${th} text-center`}>{t('purchasing.grnColOrdered')}</th>
              <th className={`${th} text-center`}>{t('purchasing.grnColReceived')}</th>
              <th className={`${th} text-center`}>{t('purchasing.grnColOnDraft')}</th>
              <th className={`${th} text-center pe-4`}>{t('purchasing.grnColOpen')}</th>
            </tr>
          </thead>
          <tbody>
            {progress.map((p) => (
              <tr key={p.line.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className={`${td} ps-4 font-medium`}>{p.line.product_name}</td>
                <td className={`${td} text-center`}>{p.ordered}</td>
                <td className={`${td} text-center`}>{p.received}</td>
                <td className={`${td} text-center text-[#6c6760] dark:text-[#9aa4b2]`}>{p.onDraft || '—'}</td>
                <td className={`${td} text-center pe-4 font-semibold`}>{p.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="px-4 py-3 space-y-2">
        {!isManager && canReceiveMore && (
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.grnManagersOnly')}</p>
        )}
        {hasServiceLines && (
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.grnServicesNote')}</p>
        )}
        {receipts.length === 0 ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.grnNone')}</p>
        ) : (
          <ul className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
            {receipts.map((r) => {
              const viId = r.status === 'confirmed' ? invoiceOf(r) : null
              return (
                <li key={r.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{r.grn_code || '—'}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${GRN_PILL[r.status] || GRN_PILL.draft}`}>
                        {t(`purchasing.grnStatus_${r.status}`)}
                      </span>
                      <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{fmtDate(r.confirmed_at || r.created_at)}</span>
                      {r.supplier_ref && (
                        <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.grnSupplierRefShort', { ref: r.supplier_ref })}</span>
                      )}
                    </div>
                    <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5 truncate">
                      {(r.goods_receipt_lines || [])
                        .map((l) => `${l.qty} × ${l.product_name} → ${warehouseNames[l.warehouse_id] || '—'}`)
                        .join(' · ')}
                    </div>
                    {r.notes && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{r.notes}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {r.status === 'draft' && isManager && (
                      <>
                        <Button size="sm" onClick={() => handleConfirm(r)} loading={busy}>{t('purchasing.grnConfirm')}</Button>
                        <Button size="sm" variant="secondary" onClick={() => handleCancel(r)} loading={busy}>{t('purchasing.grnCancel')}</Button>
                      </>
                    )}
                    {r.status === 'confirmed' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          downloadGoodsReceiptNotePDF({ receipt: r, purchaseOrder: po, vendor, warehouseNames }).catch((err) =>
                            toast.error(err?.message || t('common.error')))
                        }
                      >
                        {t('purchasing.grnPrintNote')}
                      </Button>
                    )}
                    {viId && (
                      <Link
                        to={`/purchasing/vendor_invoice/${viId}`}
                        className="text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                      >
                        {t('purchasing.grnViewInvoice')}
                      </Link>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {showCreate && (
        <CreateReceiptModal
          progress={progress}
          warehouses={receivableWarehouses(warehouses)}
          busy={busy}
          onClose={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}
      {confirmDialog}
    </div>
  )
}

function CreateReceiptModal({ progress, warehouses, busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const open = progress.filter((p) => p.open > 0)
  const defaultWh = (warehouses.find((w) => w.warehouse_type === 'main') || warehouses[0])?.id || ''
  // bulk lines default to everything still open; a serialized line's quantity
  // is the number of serials scanned
  const [qty, setQty] = useState(() => Object.fromEntries(open.filter((p) => !p.serialized).map((p) => [p.line.id, String(p.open)])))
  const [serials, setSerials] = useState({})
  const [wh, setWh] = useState(() => Object.fromEntries(open.map((p) => [p.line.id, defaultWh])))
  const [supplierRef, setSupplierRef] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null) // { key, lineId?, count?, serial? }

  const qtyOf = (p) => (p.serialized ? String(parseSerials(serials[p.line.id]).length) : qty[p.line.id])

  const submit = () => {
    const res = validateReceipt(
      open.map((p) => ({
        lineId: p.line.id,
        open: p.open,
        qty: qtyOf(p),
        warehouseId: wh[p.line.id],
        serialized: p.serialized,
        serialsText: serials[p.line.id],
      }))
    )
    if (res.error) { setError(res); return }
    onSubmit(res.lines, { supplier_ref: supplierRef.trim() || null, notes: notes.trim() || null })
  }

  const errorText = () => {
    const bad = error.lineId && open.find((p) => p.line.id === error.lineId)
    return t(error.error, { product: bad?.line.product_name, open: bad?.open, count: error.count, serial: error.serial })
  }
  const clear = () => setError(null)
  const invalid = (p) => error?.lineId === p.line.id

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('purchasing.grnCreateTitle')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full"
      >
        <div className="px-5 py-4 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('purchasing.grnCreateTitle')}</h2>
        </div>
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {warehouses.length === 0 && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">{t('purchasing.grnNoWarehouse')}</p>
          )}
          <div className="space-y-3">
            {open.map((p) => (
              <div key={p.line.id} className="border border-[#f0f2f6] dark:border-[#1a2230] rounded-lg p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{p.line.product_name}</span>
                  <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.grnOpenCount', { open: p.open })}</span>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  {p.serialized ? (
                    <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                      {t('purchasing.grnSerialQty', { count: Number(qtyOf(p)) })}
                    </div>
                  ) : (
                    <div>
                      <Label htmlFor={`grn-qty-${p.line.id}`}>{t('purchasing.grnQtyReceived')}</Label>
                      <Input
                        id={`grn-qty-${p.line.id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={p.open}
                        step={1}
                        aria-invalid={invalid(p) || undefined}
                        aria-describedby={invalid(p) ? 'grn-error' : undefined}
                        value={qty[p.line.id] ?? ''}
                        onChange={(e) => { clear(); setQty((q) => ({ ...q, [p.line.id]: e.target.value })) }}
                        className={`w-24 text-center ${invalid(p) ? 'border-red-500 dark:border-red-400 ring-1 ring-red-500' : ''}`}
                      />
                    </div>
                  )}
                  <div className="flex-1 min-w-[10rem]">
                    <Label htmlFor={`grn-wh-${p.line.id}`}>{t('purchasing.grnWarehouse')}</Label>
                    <Select
                      id={`grn-wh-${p.line.id}`}
                      value={wh[p.line.id] || ''}
                      onChange={(e) => { clear(); setWh((w) => ({ ...w, [p.line.id]: e.target.value })) }}
                    >
                      <option value="">{t('purchasing.grnChooseWarehouse')}</option>
                      {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </Select>
                  </div>
                </div>
                {p.serialized && (
                  <div>
                    <Label htmlFor={`grn-sn-${p.line.id}`}>{t('purchasing.grnSerials')}</Label>
                    <Textarea
                      id={`grn-sn-${p.line.id}`}
                      rows={3}
                      placeholder={t('purchasing.grnSerialsPlaceholder')}
                      aria-invalid={invalid(p) || undefined}
                      aria-describedby={invalid(p) ? 'grn-error' : undefined}
                      value={serials[p.line.id] ?? ''}
                      onChange={(e) => { clear(); setSerials((s) => ({ ...s, [p.line.id]: e.target.value })) }}
                      className={`font-mono text-xs ${invalid(p) ? 'border-red-500 dark:border-red-400 ring-1 ring-red-500' : ''}`}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="grn-supplier-ref">{t('purchasing.grnSupplierRef')}</Label>
              <Input id="grn-supplier-ref" value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="grn-notes">{t('purchasing.grnNotes')}</Label>
              <Textarea id="grn-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={1} />
            </div>
          </div>

          {error && (
            <p id="grn-error" role="alert" className="text-xs text-red-600 dark:text-red-400">{errorText()}</p>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={submit} loading={busy} disabled={warehouses.length === 0}>{t('purchasing.grnCreate')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
