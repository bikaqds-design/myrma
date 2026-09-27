import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useProductsById } from '../../lib/useLookups'
import { ModalOverlay, ModalCard, Button, Input, Textarea, Label } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { deliveryProgress, validateDeliveryQuantities } from './_deliveries'
import { downloadDeliveryNotePDF } from '../../lib/deliveryNotePdf'
import { downloadReturnNotePDF } from '../../lib/returnNotePdf'
import ReturnModal from './ReturnModal'
import { returnableByLine } from './_returns'

// Deliveries of one sales order (P-01, 20260894) and invoicing each one
// (P-02, 20260896), and goods coming back from a delivery (P-05, 20260902 /
// 20260903): a return is recorded against a delivery whose invoice is posted,
// confirmed (the goods are back in stock), then credited. Managers and above
// create, confirm and cancel deliveries and returns; the database enforces that
// and every quantity rule — this screen only offers what the rules allow.

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')

const DLV_PILL = {
  draft:     'bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  cancelled: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
}

export default function DeliveriesPanel({ so, customer, isManager, canInvoice, currentUserEmail, onInvoiceCreated }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [returnFor, setReturnFor] = useState(null) // the delivery a return is being recorded for
  const navigate = useNavigate()

  const { data: soLines = EMPTY_ARRAY } = useQuery({
    queryKey: ['sales-order-lines', so.id],
    queryFn: () => db.salesOrders.lines(so.id),
  })
  const { data: deliveries = EMPTY_ARRAY } = useQuery({
    queryKey: ['deliveries', so.id],
    queryFn: () => db.deliveries.listForOrder(so.id),
  })
  const { data: invoices = EMPTY_ARRAY } = useQuery({
    queryKey: ['invoices-by-so', so.id],
    queryFn: () => db.crmInvoices.list({ soId: so.id }),
    staleTime: 30_000,
  })
  const hasConfirmed = deliveries.some((d) => d.status === 'confirmed')
  const { data: returns = EMPTY_ARRAY } = useQuery({
    queryKey: ['customer-returns', so.id],
    queryFn: () => db.customerReturns.listForOrder(so.id),
    enabled: hasConfirmed,
  })
  const returnIds = useMemo(() => returns.map((r) => r.id), [returns])
  const { data: returnNotes = EMPTY_ARRAY } = useQuery({
    queryKey: ['customer-return-credit-notes', ...returnIds],
    queryFn: () => db.customerReturns.creditNotesFor(returnIds),
    enabled: returnIds.length > 0,
  })
  const productsById = useProductsById(soLines.map((l) => l.product_id))

  const progress = useMemo(() => deliveryProgress(soLines, deliveries, productsById), [soLines, deliveries, productsById])
  const openTotal = progress.reduce((s, p) => s + p.open, 0)
  const hasServiceLines = soLines.some((l) => l.product_id && productsById[l.product_id]?.product_type === 'service')
  const invoiceFor = (deliveryId) => invoices.find((i) => i.delivery_id === deliveryId && i.doc_status !== 'cancelled') || null
  const deliveryCode = (deliveryId) => deliveries.find((d) => d.id === deliveryId)?.delivery_code || '—'
  const noteFor = (returnId) => returnNotes.find((n) => n.customer_return_id === returnId) || null
  // Goods come back only from a delivery whose invoice is posted (goods
  // first: the return's credit note credits that invoice), with something left.
  const canReturn = (d, inv) =>
    isManager && d.status === 'confirmed' && inv?.doc_status === 'posted'
    && returnableByLine(d, returns).some((r) => r.left > 0)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['deliveries', so.id] })
    queryClient.invalidateQueries({ queryKey: ['invoices-by-so', so.id] })
    queryClient.invalidateQueries({ queryKey: ['sales-document', 'sales_order', so.id] })
    queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
    queryClient.invalidateQueries({ queryKey: ['inventory'] })
    queryClient.invalidateQueries({ queryKey: ['customer-returns', so.id] })
    queryClient.invalidateQueries({ queryKey: ['customer-return-credit-notes'] })
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
      toast.error(err?.message || t('salesDocuments.createFailed'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const handleConfirm = (d) =>
    confirm({
      title: t('salesDocuments.dlvConfirmTitle'),
      message: t('salesDocuments.dlvConfirmMsg'),
      confirmLabel: t('salesDocuments.dlvConfirm'),
      tone: 'primary', // a normal step, not a destructive one
      onConfirm: () => run(() => db.deliveries.confirm(d.id, currentUserEmail), 'salesDocuments.dlvConfirmedToast'),
    })
  const handleCancel = (d) =>
    confirm({
      title: t('salesDocuments.dlvCancelTitle'),
      message: t('salesDocuments.dlvCancelMsg'),
      confirmLabel: t('salesDocuments.dlvCancel'),
      onConfirm: () => run(() => db.deliveries.cancel(d.id, currentUserEmail), 'salesDocuments.dlvCancelledToast'),
    })
  const handleInvoice = (d) =>
    run(async () => {
      const invoiceId = await db.deliveries.invoice(d.id, currentUserEmail)
      toast.success(t('salesDocuments.dlvInvoicedToast'))
      refresh()
      await onInvoiceCreated?.(invoiceId, d)
    })
  const handleRecordReturn = (lines, fields) =>
    run(async () => {
      await db.customerReturns.create(returnFor.id, lines, fields, currentUserEmail)
      setReturnFor(null)
    }, 'salesDocuments.rtnCreatedToast')
  const handleConfirmReturn = (r) =>
    confirm({
      title: t('salesDocuments.rtnConfirmTitle'),
      message: t('salesDocuments.rtnConfirmMsg'),
      confirmLabel: t('salesDocuments.rtnConfirm'),
      tone: 'primary',
      onConfirm: () => run(() => db.customerReturns.confirm(r.id, currentUserEmail), 'salesDocuments.rtnConfirmedToast'),
    })
  const handleCancelReturn = (r) =>
    confirm({
      title: t('salesDocuments.rtnCancelTitle'),
      message: t('salesDocuments.rtnCancelMsg'),
      confirmLabel: t('salesDocuments.rtnCancel'),
      onConfirm: () => run(() => db.customerReturns.cancel(r.id, currentUserEmail), 'salesDocuments.rtnCancelledToast'),
    })
  const handleCreditNote = (r) =>
    run(async () => {
      const cnId = await db.customerReturns.creditNote(r.id, currentUserEmail)
      toast.success(t('salesDocuments.rtnCreditNoteToast'))
      navigate(`/sales/credit_note/${cnId}`)
    })
  const handleCreate = (lines, notes) =>
    run(async () => {
      await db.deliveries.create(so.id, lines, notes, currentUserEmail)
      setShowCreate(false)
    }, 'salesDocuments.dlvCreatedToast')

  const th = 'px-3 py-2 text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]'
  const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] mb-4 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
        <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.dlvTitle')}</h3>
        {so.status === 'confirmed' && openTotal > 0 && (
          <Button
            size="sm"
            disabled={!isManager || busy}
            onClick={() => setShowCreate(true)}
          >
            {t('salesDocuments.dlvNew')}
          </Button>
        )}
      </div>

      {progress.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
              <th className={`${th} text-start ps-4`}>{t('salesDocuments.fProduct')}</th>
              <th className={`${th} text-center`}>{t('salesDocuments.dlvColOrdered')}</th>
              <th className={`${th} text-center`}>{t('salesDocuments.dlvColDelivered')}</th>
              <th className={`${th} text-center`}>{t('salesDocuments.dlvColOnDraft')}</th>
              <th className={`${th} text-center pe-4`}>{t('salesDocuments.dlvColOpen')}</th>
            </tr>
          </thead>
          <tbody>
            {progress.map((p) => (
              <tr key={p.line.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className={`${td} ps-4 font-medium`}>{p.line.product_name}</td>
                <td className={`${td} text-center`}>{p.ordered}</td>
                <td className={`${td} text-center`}>{p.delivered}</td>
                <td className={`${td} text-center text-[#6c6760] dark:text-[#9aa4b2]`}>{p.onDraft || '—'}</td>
                <td className={`${td} text-center pe-4 font-semibold`}>{p.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="px-4 py-3 space-y-2">
        {!isManager && so.status === 'confirmed' && (
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.dlvManagersOnly')}</p>
        )}
        {hasServiceLines && (
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.dlvServicesNote')}</p>
        )}
        {deliveries.length === 0 ? (
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.dlvNone')}</p>
        ) : (
          <ul className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
            {deliveries.map((d) => {
              const inv = d.status === 'confirmed' ? invoiceFor(d.id) : null
              return (
                <li key={d.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
                        {d.delivery_code || '—'}
                      </span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${DLV_PILL[d.status] || DLV_PILL.draft}`}>
                        {t(`salesDocuments.dlvStatus_${d.status}`)}
                      </span>
                      <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{fmtDate(d.confirmed_at || d.created_at)}</span>
                    </div>
                    <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5 truncate">
                      {(d.delivery_lines || []).map((l) => `${l.qty} × ${l.product_name}`).join(' · ')}
                    </div>
                    {d.notes && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{d.notes}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {d.status === 'draft' && isManager && (
                      <>
                        <Button size="sm" onClick={() => handleConfirm(d)} loading={busy}>
                          {t('salesDocuments.dlvConfirm')}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => handleCancel(d)} loading={busy}>
                          {t('salesDocuments.dlvCancel')}
                        </Button>
                      </>
                    )}
                    {d.status === 'confirmed' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          downloadDeliveryNotePDF({ delivery: d, salesOrder: so, customer }).catch((err) =>
                            toast.error(err?.message || t('salesDocuments.createFailed')))
                        }
                      >
                        {t('salesDocuments.dlvPrintNote')}
                      </Button>
                    )}
                    {d.status === 'confirmed' && inv && (
                      <Link
                        to={`/sales/invoice/${inv.id}`}
                        className="text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                      >
                        {inv.inv_code ? t('salesDocuments.dlvViewInvoice', { code: inv.inv_code }) : t('salesDocuments.dlvInvoiceDraft')}
                      </Link>
                    )}
                    {canReturn(d, inv) && (
                      <Button size="sm" variant="secondary" onClick={() => setReturnFor(d)} disabled={busy}>
                        {t('salesDocuments.rtnRecord')}
                      </Button>
                    )}
                    {d.status === 'confirmed' && !inv && (
                      <Button size="sm" variant="secondary" disabled={!canInvoice} onClick={() => handleInvoice(d)} loading={busy}>
                        {t('salesDocuments.dlvInvoice')}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {returns.length > 0 && (
        <div className="px-4 py-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
          <h4 className="text-xs font-bold uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">{t('salesDocuments.rtnTitle')}</h4>
          <ul className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
            {returns.map((r) => {
              const cn = r.status === 'confirmed' ? noteFor(r.id) : null
              return (
                <li key={r.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{r.return_code || '—'}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${DLV_PILL[r.status] || DLV_PILL.draft}`}>
                        {t(`salesDocuments.rtnStatus_${r.status}`)}
                      </span>
                      <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                        {t('salesDocuments.rtnFromDelivery', { code: deliveryCode(r.delivery_id) })} · {fmtDate(r.confirmed_at || r.created_at)}
                      </span>
                    </div>
                    <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5 truncate">
                      {(r.customer_return_lines || []).map((l) => `${l.qty} × ${l.product_name}`).join(' · ')}
                    </div>
                    {r.reason && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{r.reason}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {r.status === 'draft' && isManager && (
                      <>
                        <Button size="sm" onClick={() => handleConfirmReturn(r)} loading={busy}>{t('salesDocuments.rtnConfirm')}</Button>
                        <Button size="sm" variant="secondary" onClick={() => handleCancelReturn(r)} loading={busy}>{t('salesDocuments.rtnCancel')}</Button>
                      </>
                    )}
                    {r.status === 'confirmed' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          downloadReturnNotePDF({ ret: r, deliveryCode: deliveryCode(r.delivery_id), salesOrder: so, customer }).catch((err) =>
                            toast.error(err?.message || t('salesDocuments.createFailed')))
                        }
                      >
                        {t('salesDocuments.rtnPrintNote')}
                      </Button>
                    )}
                    {cn && (
                      <Link to={`/sales/credit_note/${cn.id}`} className="text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                        {cn.cn_code ? t('salesDocuments.rtnViewCreditNote', { code: cn.cn_code }) : t('salesDocuments.rtnCreditNoteDraft')}
                      </Link>
                    )}
                    {r.status === 'confirmed' && !cn && isManager && (
                      <Button size="sm" variant="secondary" onClick={() => handleCreditNote(r)} loading={busy}>
                        {t('salesDocuments.rtnCreditNote')}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {returnFor && (
        <ReturnModal delivery={returnFor} returns={returns} busy={busy} onClose={() => setReturnFor(null)} onSubmit={handleRecordReturn} />
      )}
      {showCreate && (
        <CreateDeliveryModal progress={progress} busy={busy} onClose={() => setShowCreate(false)} onSubmit={handleCreate} />
      )}
      {confirmDialog}
    </div>
  )
}

function CreateDeliveryModal({ progress, busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const open = progress.filter((p) => p.open > 0)
  const [qty, setQty] = useState(() => Object.fromEntries(open.map((p) => [p.line.id, String(p.open)])))
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null) // { key, lineId? }

  const submit = () => {
    const res = validateDeliveryQuantities(open.map((p) => ({ lineId: p.line.id, open: p.open, qty: qty[p.line.id] })))
    if (res.error) { setError({ key: res.error, lineId: res.lineId }); return }
    onSubmit(res.lines, notes.trim() || null)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('salesDocuments.dlvCreateTitle')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-lg w-full"
      >
        <div className="px-5 py-4 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.dlvCreateTitle')}</h2>
        </div>
        <div className="px-5 py-4 space-y-4">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="py-1.5 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fProduct')}</th>
                <th className="py-1.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.dlvColOpen')}</th>
                <th className="py-1.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.dlvQtyToShip')}</th>
              </tr>
            </thead>
            <tbody>
              {open.map((p) => (
                <tr key={p.line.id} className="border-t border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className="py-2 text-[#211f1b] dark:text-[#e8ebf0]">{p.line.product_name}</td>
                  <td className="py-2 text-center text-[#6c6760] dark:text-[#9aa4b2]">{p.open}</td>
                  <td className="py-2 text-center">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={p.open}
                      step={1}
                      aria-label={`${t('salesDocuments.dlvQtyToShip')} — ${p.line.product_name}`}
                      aria-invalid={error?.lineId === p.line.id || undefined}
                      aria-describedby={error?.lineId === p.line.id ? 'dlv-qty-error' : undefined}
                      value={qty[p.line.id] ?? ''}
                      onChange={(e) => { setError(null); setQty((q) => ({ ...q, [p.line.id]: e.target.value })) }}
                      className={`w-20 text-center ${error?.lineId === p.line.id ? 'border-red-500 dark:border-red-400 ring-1 ring-red-500' : ''}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div>
            <Label htmlFor="dlv-notes">{t('salesDocuments.dlvNotes')}</Label>
            <Textarea id="dlv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>

          {error && (
            <p id="dlv-qty-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
              {(() => {
                const bad = error.lineId && open.find((p) => p.line.id === error.lineId)
                return bad ? t(error.key, { product: bad.line.product_name, open: bad.open }) : t(error.key)
              })()}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={submit} loading={busy}>{t('salesDocuments.dlvCreate')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
