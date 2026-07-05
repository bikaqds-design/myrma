import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PO_STATUS_FLOW, VI_STATUS_FLOW } from '../../lib/constants'
import { PageHeader, Spinner, Button, Label, Select, Input } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { ActivityChatter } from '../../components/ActivityChatter'
import Modal from '../../components/Modal'
import { downloadPOPDF } from '../../lib/purchaseOrderPdf'
import { CreatePurchaseOrderModal, VendorInvoiceFormModal, RecordVendorPaymentModal } from './_modals'

const STATUS_PILL = {
  draft: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  sent: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  pending_confirmation: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  pending_approval: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  approved: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partially_received: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  partially_completed: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  received: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  completed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  paid: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partial: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  unpaid: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  reversed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  expired: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#4a5568]',
}
const statusPillCls = (s) => STATUS_PILL[s] ?? STATUS_PILL.draft

const DOC_LABEL_KEY = {
  purchase_order: 'purchasing.docType_purchase_order',
  vendor_invoice: 'purchasing.docType_vendor_invoice',
}

const ADAPTERS = {
  purchase_order: {
    fetch: (id) => db.purchaseOrders.get(id),
    code: (r) => r.po_code,
    flow: PO_STATUS_FLOW,
  },
  vendor_invoice: {
    fetch: (id) => db.vendorInvoices.get(id),
    code: (r) => r.vi_code,
    flow: VI_STATUS_FLOW,
  },
}

function statusLabel(s, t) {
  const key = `purchasing.st_${s}`
  const label = t(key)
  return label === key ? s : label
}

function Field({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-0.5">{label}</div>
      <div className={`font-medium text-[#211f1b] dark:text-[#e8ebf0] ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  )
}

function TotalRow({ label, value, muted }) {
  const cls = muted ? 'text-[#6c6760] dark:text-[#9aa4b2]' : 'text-[#211f1b] dark:text-[#e8ebf0]'
  return (
    <div className="flex items-center justify-between">
      <span className={cls}>{label}</span>
      <span className={cls}>{value}</span>
    </div>
  )
}

// Read-only progress stepper — status transitions happen via the explicit
// lifecycle buttons below, not by clicking a step (unlike the Deal stage
// pills, skipping a purchasing step would bypass the approval/receive guards).
function StatusStepper({ flow, current, t }) {
  const currentIdx = flow.indexOf(current)
  const isTerminalOther = currentIdx === -1 // cancelled / expired
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {flow.map((s, idx) => {
        const done = !isTerminalOther && idx < currentIdx
        const active = !isTerminalOther && idx === currentIdx
        return (
          <React.Fragment key={s}>
            <span
              className={`px-3 py-1 text-xs rounded-full font-medium ${
                active
                  ? 'bg-[#4338ca] text-white dark:bg-[#a5b4fc] dark:text-[#0b0f17]'
                  : done
                  ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                  : 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#4a5568]'
              }`}
            >
              {statusLabel(s, t)}
            </span>
            {idx < flow.length - 1 && <span className="text-gray-300 dark:text-[#212a38]">→</span>}
          </React.Fragment>
        )
      })}
      {isTerminalOther && (
        <span className={`px-3 py-1 text-xs rounded-full font-medium ${statusPillCls(current)}`}>
          {statusLabel(current, t)}
        </span>
      )}
    </div>
  )
}

// ─── Purchase Document Detail — PO / Vendor Invoice lifecycle ──────────────────
export default function PurchaseDocumentDetail({ docType, docId, currentUserEmail, currentUserRole, onBack }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const adapter = ADAPTERS[docType]

  const isPO = docType === 'purchase_order'
  const isVI = docType === 'vendor_invoice'

  const [busy, setBusy] = useState(false)
  const [showReceive, setShowReceive] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showPayment, setShowPayment] = useState(false)

  const { data: doc, isLoading, isError } = useQuery({
    queryKey: ['purchase-document', docType, docId],
    queryFn: () => adapter.fetch(docId),
    enabled: !!adapter && !!docId,
  })

  const { data: vendor } = useQuery({
    queryKey: ['brand-vendor', doc?.vendor_id],
    queryFn: () => db.brands.list().then((rows) => rows.find((r) => r.id === doc.vendor_id)),
    enabled: !!doc?.vendor_id,
  })

  const { data: linkedPO } = useQuery({
    queryKey: ['purchase-document', 'purchase_order', doc?.purchase_order_id],
    queryFn: () => db.purchaseOrders.get(doc.purchase_order_id),
    enabled: isVI && !!doc?.purchase_order_id,
  })

  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => db.warehouses.list().then((r) => (r.missing ? [] : r.data)),
    enabled: isVI,
  })
  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 60_000,
    enabled: isVI,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['purchase-document', docType, docId] })
    queryClient.invalidateQueries({ queryKey: ['purchase-documents'] })
  }

  const runAction = async (fn) => {
    setBusy(true)
    try { await fn(); refresh() }
    catch (err) { console.error(err); toast.error(err?.message || t('common.error')) }
    finally { setBusy(false) }
  }

  const logPO = (kind) => db.activities.logSystem('purchase_order', doc.id, `${kind}|${doc.po_code}`, currentUserEmail).catch(() => {})
  const logVI = (kind) => db.activities.logSystem('vendor_invoice', doc.id, `${kind}|${doc.vi_code || doc.id}`, currentUserEmail).catch(() => {})

  // ── Purchase Order actions ────────────────────────────────────────────────
  const handlePOSend = () => runAction(async () => { await db.purchaseOrders.markSent(doc.id); logPO('po_sent'); toast.success(t('purchasing.statusUpdated')) })
  const handlePOPendingConfirmation = () => runAction(async () => { await db.purchaseOrders.markPendingConfirmation(doc.id); logPO('po_pending_confirmation'); toast.success(t('purchasing.statusUpdated')) })
  const handlePOConfirm = () => runAction(async () => { await db.purchaseOrders.markConfirmed(doc.id); logPO('po_confirmed'); toast.success(t('purchasing.statusUpdated')) })
  const handlePOExpire = () => runAction(async () => { await db.purchaseOrders.markExpired(doc.id); logPO('po_expired'); toast.success(t('purchasing.statusUpdated')) })
  const handlePOCancel = () => {
    if (!window.confirm(t('purchasing.cancelConfirm'))) return
    runAction(async () => { await db.purchaseOrders.cancel(doc.id); logPO('po_cancelled'); toast.success(t('purchasing.statusUpdated')) })
  }
  const handleConvertToVI = () => runAction(async () => {
    const vi = await db.purchaseOrders.convertToVendorInvoice(doc.id, currentUserEmail)
    logPO('po_converted_to_vi')
    toast.success(t('purchasing.viCreated'))
    navigate(`/purchasing/vendor_invoice/${vi.id}`)
  })
  const handleDownloadPOPDF = () => downloadPOPDF({ purchaseOrder: doc, vendor })

  // ── Vendor Invoice actions ─────────────────────────────────────────────────
  const createApprovalActivity = () => {
    const vendorName = vendor?.brand_name || '—'
    const code = doc.vi_code || linkedPO?.po_code || '—'
    return db.activities.create({
      related_type: 'vendor_invoice',
      related_id: doc.id,
      type: 'approval',
      title: `approval|vendor_invoice|${doc.id}|${code}|${doc.total ?? 0}|${vendorName}`,
      due_date: doc.due_date || new Date().toISOString(),
      assigned_rep: null,
      outcome_notes: null,
      created_by: currentUserEmail,
    }).catch((err) => { console.error('VI approval activity failed', err); toast.error(t('purchasing.approvalActivityFailed')) })
  }
  const handleSubmitForApproval = () => runAction(async () => {
    await db.vendorInvoices.submitForApproval(doc.id)
    logVI('vi_submitted_for_approval')
    await createApprovalActivity()
    toast.success(t('purchasing.statusUpdated'))
  })
  const handleVICancel = () => {
    if (!window.confirm(t('purchasing.cancelConfirm'))) return
    runAction(async () => { await db.vendorInvoices.cancel(doc.id); logVI('vi_cancelled'); toast.success(t('purchasing.statusUpdated')) })
  }

  // ── Archive / restore ─────────────────────────────────────────────────────
  const handleArchiveToggle = () => runAction(async () => {
    await db.purchaseDocuments.setArchived(docType, doc.id, !doc.archived, currentUserEmail)
    toast.success(t(doc.archived ? 'purchasing.restoredToast' : 'purchasing.archivedToast'))
  })

  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')
  const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })

  if (!adapter) {
    return <div className="p-6"><EmptyState title={t('purchasing.noDocumentsYet')} description="" action={onBack} actionLabel={t('common.back')} /></div>
  }
  if (isLoading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (isError || !doc) {
    return <div className="p-6"><EmptyState title={t('purchasing.noDocumentsYet')} description="" action={onBack} actionLabel={t('common.back')} /></div>
  }

  const code = adapter.code(doc) || t('purchasing.pendingCode')
  const lines = doc.line_items || []
  const lineNet = (l) => {
    const base = (Number(l.qty_ordered) || 0) * (Number(l.unit_cost) || 0)
    const net = base - base * ((Number(l.discount_pct) || 0) / 100)
    return net + net * ((Number(l.tax_pct) || 0) / 100)
  }
  const canEditPO = isPO && doc.status === 'draft'
  const canEditVI = isVI && doc.status === 'draft'

  return (
    <div className="w-full px-4 py-6 max-w-4xl mx-auto">
      <PageHeader title={`${code}`} subtitle={t(DOC_LABEL_KEY[docType])} onBack={onBack} backLabel={t('common.back')}>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {isPO && !doc.archived && (
            <>
              {canEditPO && (
                <Button variant="secondary" size="sm" onClick={() => setShowEdit(true)}>{t('salesDocuments.edit')}</Button>
              )}
              {doc.status === 'draft' && (
                <Button variant="secondary" size="sm" onClick={handlePOSend} loading={busy}>{t('purchasing.markSent')}</Button>
              )}
              {doc.status === 'sent' && (
                <Button variant="secondary" size="sm" onClick={handlePOPendingConfirmation} loading={busy}>{t('purchasing.markPendingConfirmation')}</Button>
              )}
              {['sent', 'pending_confirmation'].includes(doc.status) && (
                <Button variant="primary" size="sm" onClick={handlePOConfirm} loading={busy}>{t('purchasing.markConfirmed')}</Button>
              )}
              {doc.status !== 'draft' && (
                <Button variant="secondary" size="sm" onClick={handleDownloadPOPDF}>{t('purchasing.downloadPDF')}</Button>
              )}
              {['confirmed', 'partially_completed'].includes(doc.status) && (
                <Button size="sm" onClick={handleConvertToVI} loading={busy}>{t('purchasing.createVendorInvoice')}</Button>
              )}
              {['draft', 'sent', 'pending_confirmation'].includes(doc.status) && (
                <Button variant="secondary" size="sm" onClick={handlePOExpire} loading={busy}>{t('purchasing.markExpired')}</Button>
              )}
              {['draft', 'sent', 'pending_confirmation', 'confirmed'].includes(doc.status) && (
                <Button variant="danger" size="sm" onClick={handlePOCancel} loading={busy}>{t('common.cancel')}</Button>
              )}
            </>
          )}

          {isVI && !doc.archived && (
            <>
              {canEditVI && (
                <Button variant="secondary" size="sm" onClick={() => setShowEdit(true)}>{t('salesDocuments.edit')}</Button>
              )}
              {doc.status === 'draft' && (
                <Button variant="secondary" size="sm" onClick={handleSubmitForApproval} loading={busy}>{t('purchasing.submitForApproval')}</Button>
              )}
              {doc.status === 'pending_approval' && (
                <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] italic self-center">{t('purchasing.awaitingApproval')}</span>
              )}
              {['approved', 'partially_received'].includes(doc.status) && (
                <Button size="sm" onClick={() => setShowReceive(true)}>{t('purchasing.confirmAndReceive')}</Button>
              )}
              {['approved', 'partially_received', 'received'].includes(doc.status) && (
                <Button variant="secondary" size="sm" onClick={() => setShowPayment(true)}>{t('purchasing.recordPayment')}</Button>
              )}
              {['draft', 'pending_approval', 'approved'].includes(doc.status) && (
                <Button variant="danger" size="sm" onClick={handleVICancel} loading={busy}>{t('common.cancel')}</Button>
              )}
            </>
          )}

          <Button variant="secondary" size="sm" onClick={handleArchiveToggle} loading={busy}>
            {doc.archived ? t('purchasing.restore') : t('purchasing.archive')}
          </Button>
        </div>
      </PageHeader>

      {showEdit && isPO && (
        <CreatePurchaseOrderModal
          mode="edit"
          initial={doc}
          vendors={vendor ? [vendor] : []}
          onClose={() => setShowEdit(false)}
          userEmail={currentUserEmail}
          onSuccess={() => { setShowEdit(false); refresh() }}
        />
      )}
      {showEdit && isVI && (
        <VendorInvoiceFormModal
          mode="edit"
          initial={doc}
          vendors={vendor ? [vendor] : []}
          onClose={() => setShowEdit(false)}
          userEmail={currentUserEmail}
          onSuccess={() => { setShowEdit(false); refresh() }}
        />
      )}
      {showReceive && (
        <ReceiveVendorInvoiceModal
          vi={doc}
          warehouses={warehouses}
          products={products}
          onClose={() => setShowReceive(false)}
          userEmail={currentUserEmail}
          onSuccess={refresh}
        />
      )}
      {showPayment && (
        <RecordVendorPaymentModal
          vendors={vendor ? [vendor] : []}
          vendorId={doc.vendor_id}
          initialInvoiceId={doc.id}
          currentUserEmail={currentUserEmail}
          onClose={() => setShowPayment(false)}
          onRecorded={() => { setShowPayment(false); refresh() }}
        />
      )}

      {/* Header card */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px] mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="font-mono text-sm font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded">
            {code}
          </span>
          {doc.archived && (
            <span className="px-2 py-0.5 text-xs rounded-full font-medium bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
              {t('purchasing.archivedBadge')}
            </span>
          )}
          {isVI && doc.payment_status && (
            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(doc.payment_status)}`}>
              {statusLabel(doc.payment_status, t)}
            </span>
          )}
          {isVI && linkedPO && (
            <button
              onClick={() => navigate(`/purchasing/purchase_order/${linkedPO.id}`)}
              className="inline-flex items-center gap-1 text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#4338ca] dark:hover:text-[#a5b4fc] transition-colors"
            >
              {t('purchasing.linkedFromPO')}: <span className="font-mono">{linkedPO.po_code}</span>
            </button>
          )}
        </div>

        <div className="mb-4">
          <StatusStepper flow={adapter.flow} current={doc.status} t={t} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <Field label={t('purchasing.vendor')} value={vendor?.brand_name || '—'} />
          {vendor?.contact_person && <Field label={t('purchasing.contactPerson')} value={vendor.contact_person} />}
          {isPO && <Field label={t('purchasing.issueDate')} value={fmtDate(doc.issue_date)} />}
          {isPO && <Field label={t('purchasing.expectedDeliveryDate')} value={fmtDate(doc.expected_delivery_date)} />}
          {isVI && <Field label={t('purchasing.invoiceDate')} value={fmtDate(doc.invoice_date)} />}
          {isVI && <Field label={t('purchasing.dueDate')} value={fmtDate(doc.due_date)} />}
          {doc.currency && <Field label={t('purchasing.currency')} value={doc.currency} />}
          {doc.payment_terms && <Field label={t('purchasing.paymentTerms')} value={doc.payment_terms} />}
          {isPO && doc.delivery_terms && <Field label={t('purchasing.deliveryTerms')} value={doc.delivery_terms} />}
          <Field label={t('purchasing.colCreated')} value={fmtDate(doc.created_at)} />
          {isVI && ['approved', 'partially_received', 'received'].includes(doc.status) && (
            <>
              <Field label={t('purchasing.amountPaid')} value={fmtMoney(doc.amount_paid)} />
              <Field label={t('purchasing.remainingBalance')} value={fmtMoney((doc.total ?? 0) - (doc.amount_paid ?? 0))} />
            </>
          )}
        </div>

        {isPO && (doc.shipping_address || doc.billing_address) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 pt-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
            {doc.shipping_address && <Field label={t('purchasing.shippingAddress')} value={doc.shipping_address} />}
            {doc.billing_address && <Field label={t('purchasing.billingAddress')} value={doc.billing_address} />}
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
              <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.colProduct')}</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.qtyOrdered')}</th>
              {isVI && <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.qtyReceived')}</th>}
              <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.unitCost')}</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fDiscount')}</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fTax')}</th>
              <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fLineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{l.product_name}</div>
                  {l.description && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{l.description}</div>}
                </td>
                <td className="px-3 py-2.5 text-center text-[#211f1b] dark:text-[#e8ebf0]">{l.qty_ordered}</td>
                {isVI && <td className="px-3 py-2.5 text-center text-[#211f1b] dark:text-[#e8ebf0]">{l.qty_received || 0}</td>}
                <td className="px-3 py-2.5 text-right text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(l.unit_cost)}</td>
                <td className="px-3 py-2.5 text-center text-[#6c6760] dark:text-[#9aa4b2]">{l.discount_pct ? l.discount_pct + '%' : '—'}</td>
                <td className="px-3 py-2.5 text-center text-[#6c6760] dark:text-[#9aa4b2]">{l.tax_pct ? l.tax_pct + '%' : '—'}</td>
                <td className="px-4 py-2.5 text-right font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(lineNet(l))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end p-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
          <div className="w-full sm:w-64 space-y-1 text-sm">
            <TotalRow label={t('salesDocuments.subtotal')} value={fmtMoney(doc.subtotal)} />
            {Number(doc.discount_amount) > 0 && <TotalRow label={t('salesDocuments.totalDiscount')} value={'-' + fmtMoney(doc.discount_amount)} muted />}
            {Number(doc.tax_amount) > 0 && <TotalRow label={t('salesDocuments.totalTax')} value={fmtMoney(doc.tax_amount)} muted />}
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-[#e6e9ef] dark:border-[#212a38]">
              <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.grandTotal')}</span>
              <span className="font-bold text-indigo-600 dark:text-[#a5b4fc]">{fmtMoney(doc.total)}</span>
            </div>
          </div>
        </div>
      </div>

      {(doc.notes || (isPO && doc.terms_conditions)) && (
        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px] mb-4 space-y-3">
          {doc.notes && (
            <div>
              <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1.5">{t('purchasing.notes')}</div>
              <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0] whitespace-pre-wrap leading-relaxed">{doc.notes}</p>
            </div>
          )}
          {isPO && doc.terms_conditions && (
            <div>
              <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1.5">{t('purchasing.termsConditions')}</div>
              <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0] whitespace-pre-wrap leading-relaxed">{doc.terms_conditions}</p>
            </div>
          )}
        </div>
      )}

      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden">
        <ActivityChatter relatedType={docType} relatedId={doc.id} currentUserEmail={currentUserEmail} canEdit currentUserRole={currentUserRole} />
      </div>
    </div>
  )
}

// ─── Receive Vendor Invoice — dual-mode confirmation & receipt ─────────────────
function ReceiveVendorInvoiceModal({ vi, warehouses, products, onClose, userEmail, onSuccess }) {
  const { t } = useTranslation()
  const [warehouseId, setWarehouseId] = useState('')
  const [entries, setEntries] = useState({})
  const [saving, setSaving] = useState(false)

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
        const serials = (entry.serialsText || '').split('\n').map((s) => s.trim()).filter(Boolean)
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
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
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
                    onChange={(e) => setEntries({ ...entries, [line.index]: { qty: e.target.value } })}
                    className="w-full"
                  />
                ) : (
                  <textarea
                    placeholder={t('inventory.serialNumbersPlaceholder')}
                    rows={3}
                    onChange={(e) => setEntries({ ...entries, [line.index]: { serialsText: e.target.value } })}
                    className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] font-mono"
                  />
                )}
              </div>
            )
          })
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSubmit} loading={saving} disabled={saving || pendingLines.length === 0}>
            {t('purchasing.receiveSubmit')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
