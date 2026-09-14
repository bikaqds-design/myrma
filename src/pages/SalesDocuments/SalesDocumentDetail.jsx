import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { canDo } from '../../lib/permissions'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useCustomer } from '../../lib/useLookups'
import { PageHeader, Spinner, Button } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { downloadQuotationPDF } from '../../lib/quotationPdf'
import { downloadSOPDF } from '../../lib/salesOrderPdf'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { useConfirm } from '../../hooks/useConfirm'
import {
  DocumentFormModal,
  RecordPaymentModal,
  VoidModal,
} from './_modals'

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_PILL = {
  converted: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300',
  draft:     'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  sent:      'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  accepted:  'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  posted:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  delivered: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  issued:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  applied:   'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  paid:      'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partial:   'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  expired:   'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  declined:  'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  voided:    'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  reversed:  'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#a4acb7]',
  unpaid:    'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
}
const statusPillCls = (s) => STATUS_PILL[s] ?? STATUS_PILL.draft

const DOC_TYPE_LABEL_KEY = {
  quotation:   'salesDocuments.typeQuotation',
  sales_order: 'salesDocuments.typeSalesOrder',
  invoice:     'salesDocuments.typeInvoice',
  credit_note: 'salesDocuments.typeCreditNote',
}

// Quotations show approval-term labels (mirrors the deal Quotation tab).
const QT_APPROVAL_KEY = {
  draft:     'pipeline.qtApprovalDraft',
  sent:      'pipeline.qtApprovalPending',
  accepted:  'pipeline.qtApprovalApproved',
  declined:  'pipeline.qtApprovalRejected',
  expired:   'salesDocuments.st_expired',
  cancelled: 'salesDocuments.st_cancelled',
  converted: 'salesDocuments.st_converted',
}

// Fetch + normalise per document type so the page renders all four from one shape.
const ADAPTERS = {
  quotation: {
    fetch: (id) => db.quotations.get(id),
    norm: (r) => ({
      code: r.qt_code,
      status: r.status,
      dateKey: 'salesDocuments.fValidityUntil',
      dateVal: r.validity_until,
    }),
  },
  sales_order: {
    fetch: (id) => db.salesOrders.get(id),
    norm: (r) => ({
      code: r.so_code,
      status: r.status,
      dateKey: 'salesDocuments.fDeliveryDate',
      dateVal: r.delivery_date,
    }),
  },
  invoice: {
    fetch: (id) => db.crmInvoices.get(id),
    norm: (r) => ({
      code: r.inv_code,
      status: r.doc_status,
      paymentStatus: r.payment_status,
      dateKey: 'salesDocuments.fDueDate',
      dateVal: r.due_date,
    }),
  },
  credit_note: {
    fetch: (id) => db.creditNotes.get(id),
    norm: (r) => ({
      code: r.cn_code,
      status: r.status,
      reason: r.reason,
      dateKey: null,
      dateVal: r.issued_at,
    }),
  },
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SalesDocumentDetail({
  docType,
  docId,
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onBack,
}) {
  /**
   * Who may change a document, as opposed to which states are changeable.
   *
   * This page took currentUserRole and never used it — the prop was renamed to
   * `_currentUserRole` to silence the linter. Every Edit and action button was
   * gated on document status alone, so anyone who could open a document was
   * offered Edit, including an accountant, whose whole point is that they
   * settle cash without touching the paperwork. The database refuses them, so
   * the button was an error waiting to be clicked.
   */
  const canEditDoc   = canDo(currentUserRole, currentUserPermissions, 'sales', 'edit')
  const canCancelDoc = canDo(currentUserRole, currentUserPermissions, 'sales', 'cancel')
  const canPostDoc   = canDo(currentUserRole, currentUserPermissions, 'sales', 'post')
  // Recording a payment against an invoice is a cash action, not a sales one —
  // it is the accountant's job and not a rep's, so it follows the accounting
  // module rather than `sales`.
  const canTakePayment = canDo(currentUserRole, currentUserPermissions, 'accounting', 'record_payment')

  const { t } = useTranslation()
  const { confirm, confirmDialog } = useConfirm()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const adapter = ADAPTERS[docType]

  const isQuotation  = docType === 'quotation'
  const isSO         = docType === 'sales_order'
  const isInvoice    = docType === 'invoice'
  const isCreditNote = docType === 'credit_note'

  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [showVoidModal, setShowVoidModal] = useState(false)
  const [showPaymentModal, setShowPaymentModal] = useState(false)

  // ── Data ──────────────────────────────────────────────────────────────────

  const { data: doc, isLoading, isError } = useQuery({
    queryKey: ['sales-document', docType, docId],
    queryFn: () => adapter.fetch(docId),
    enabled: !!adapter && !!docId,
  })
  const { data: usersList = EMPTY_ARRAY } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.directory(),
    staleTime: 5 * 60_000,
    enabled: isQuotation || isSO || isInvoice,
  })
  const salesReps = useMemo(
    () => usersList.filter((u) => ['sales_rep', 'manager', 'admin', 'super_admin'].includes(u.role)),
    [usersList]
  )
  // The document's customer, by id — not searched for in the whole customer
  // list, which the Data API caps at 1 000 rows. (BUG-066.)
  const customer = useCustomer(doc?.customer_id)

  // Linked-from queries — fetch the source document (lazy, only when relevant).
  const { data: linkedQuotation } = useQuery({
    queryKey: ['sales-document', 'quotation', doc?.quotation_id],
    queryFn: () => db.quotations.get(doc.quotation_id),
    enabled: isSO && !!doc?.quotation_id,
    staleTime: 5 * 60_000,
  })
  const { data: linkedSO } = useQuery({
    queryKey: ['sales-document', 'sales_order', doc?.so_id],
    queryFn: () => db.salesOrders.get(doc.so_id),
    enabled: isInvoice && !!doc?.so_id,
    staleTime: 5 * 60_000,
  })
  // For SO detail: check if an invoice has already been created from this SO.
  const { data: linkedInvoices = EMPTY_ARRAY } = useQuery({
    queryKey: ['invoices-by-so', doc?.id],
    queryFn: () => db.crmInvoices.list({ soId: doc.id }),
    enabled: isSO && !!doc?.id,
    staleTime: 30_000,
  })
  const linkedInvoiceFromSO = linkedInvoices.find((inv) => inv.doc_status !== 'cancelled') ?? null
  const soIsInvoiced = isSO && !!linkedInvoiceFromSO

  // ── Helpers ───────────────────────────────────────────────────────────────

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['sales-document', docType, docId] })
    queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
  }

  const runAction = async (fn) => {
    setBusy(true)
    try { await fn(); refresh() }
    catch (err) { console.error(err); toast.error(err?.message || t('salesDocuments.createFailed')) }
    finally { setBusy(false) }
  }

  // ── Quotation lifecycle ────────────────────────────────────────────────────

  const createApprovalActivity = () => {
    const customerName = customer?.company_name || customer?.contact_person || '—'
    const relatedType = doc.deal_id ? 'deal' : 'customer'
    const relatedId = doc.deal_id || doc.customer_id
    return db.activities.create({
      related_type: relatedType,
      related_id: relatedId,
      type: 'approval',
      title: `approval|quotation|${doc.id}|${doc.qt_code}|${doc.total ?? 0}|${customerName}`,
      due_date: doc.validity_until || new Date().toISOString(),
      assigned_rep: doc.assigned_rep || null,
      outcome_notes: null,
      created_by: currentUserEmail,
    }).catch((err) => { console.error('approval activity failed', err); toast.error(t('pipeline.approvalActivityFailed')) })
  }

  const logQt = (kind) => {
    const relatedType = doc.deal_id ? 'deal' : 'customer'
    const relatedId = doc.deal_id || doc.customer_id
    db.activities.logSystem(relatedType, relatedId, `${kind}|${doc.qt_code}`, currentUserEmail).catch(() => {})
  }

  const handleSendForApproval = () => runAction(async () => {
    await db.quotations.markSent(doc.id)
    logQt('quotation_sent')
    createApprovalActivity()
    toast.success(t('salesDocuments.statusUpdated'))
  })
  const handleCancelQt = () => runAction(async () => {
    await db.quotations.cancel(doc.id)
    logQt('quotation_cancelled')
    toast.success(t('salesDocuments.statusUpdated'))
  })
  const handleReopenForApproval = () => runAction(async () => {
    await db.quotations.markSent(doc.id)
    logQt('quotation_reopened')
    createApprovalActivity()
    toast.success(t('salesDocuments.statusUpdated'))
  })
  const handleConvertToSO = () => {
    const freeLines = db.quotations.freeFormLines(doc)
    if (freeLines.length > 0) { toast.error(t('pipeline.quotationFreeFormError', { count: freeLines.length })); return }
    runAction(async () => {
      await db.quotations.convertToSalesOrder(doc.id, currentUserEmail)
      logQt('quotation_converted')
      toast.success(t('salesDocuments.statusUpdated'))
    })
  }
  const handleDownloadPDF = () =>
    downloadQuotationPDF({
      quotation: doc,
      customer,
      relatedType: doc.deal_id ? 'deal' : 'customer',
      relatedId: doc.deal_id || doc.customer_id,
    })

  // ── Sales Order lifecycle ─────────────────────────────────────────────────

  const createSOApprovalActivity = () => {
    const customerName = customer?.company_name || customer?.contact_person || '—'
    return db.activities.create({
      related_type: 'customer',
      related_id: doc.customer_id,
      type: 'approval',
      title: `approval|sales_order|${doc.id}|${doc.so_code}|${doc.total ?? 0}|${customerName}`,
      due_date: doc.delivery_date || new Date().toISOString(),
      assigned_rep: doc.assigned_rep || null,
      outcome_notes: null,
      created_by: currentUserEmail,
    }).catch((err) => { console.error('SO approval activity failed', err); toast.error(t('pipeline.approvalActivityFailed')) })
  }

  const logSO = (kind) =>
    db.activities.logSystem('customer', doc.customer_id, `${kind}|${doc.so_code}`, currentUserEmail).catch(() => {})

  const handleSOSendForApproval = () => runAction(async () => {
    await db.salesOrders.markSent(doc.id)
    logSO('so_sent_for_approval')
    createSOApprovalActivity()
    toast.success(t('salesDocuments.statusUpdated'))
  })

  const handleSOReopen = () => runAction(async () => {
    await db.salesOrders.markSent(doc.id)
    logSO('so_reopened_for_approval')
    createSOApprovalActivity()
    toast.success(t('salesDocuments.statusUpdated'))
  })

  const handleCancelSO = () => {
    confirm({
      title: t('salesDocuments.cancelSOTitle'),
      message: t('salesDocuments.cancelSOConfirm'),
      confirmLabel: t('common.confirm'),
      onConfirm: () =>
        runAction(async () => {
          await db.salesOrders.cancel(doc.id, currentUserEmail)
          toast.success(t('salesDocuments.st_cancelled'))
        }),
    })
  }
  // Invoice approval mirrors the QT/SO approval pattern — raised the moment a
  // draft invoice exists so a manager sees it on the Activities approval pool.
  // Uses the SO's own code/total/customer (the invoice has no inv_code yet —
  // that's assigned only on post()).
  const createInvoiceApprovalActivity = (invoiceId) => {
    const customerName = customer?.company_name || customer?.contact_person || '—'
    return db.activities.create({
      related_type: 'customer',
      related_id: doc.customer_id,
      type: 'approval',
      title: `approval|invoice|${invoiceId}|${doc.so_code}|${doc.total ?? 0}|${customerName}`,
      due_date: new Date().toISOString(),
      assigned_rep: doc.assigned_rep || null,
      outcome_notes: null,
      created_by: currentUserEmail,
    }).catch((err) => { console.error('invoice approval activity failed', err); toast.error(t('pipeline.approvalActivityFailed')) })
  }
  const handleConvertToInvoice = () => runAction(async () => {
    const invoiceId = await db.salesOrders.convertToInvoice(doc.id, currentUserEmail)
    await createInvoiceApprovalActivity(invoiceId)
    toast.success(t('salesDocuments.convertedToInvoiceToast'))
    navigate(`/sales/invoice/${invoiceId}`)
  })
  const handleDownloadSOPDF = () =>
    downloadSOPDF({
      salesOrder: doc,
      customer,
      relatedType: 'customer',
      relatedId: doc.customer_id,
    })

  // ── Invoice lifecycle ─────────────────────────────────────────────────────

  // Routed through payments.record() — there is no direct write to amount_paid —
  // so every payment made from the invoice page also lands in the payments
  // ledger — otherwise the Accounting page / customer statement would be
  // incomplete for payments recorded here.
  const handleRecordPayment = (amount, method) => {
    setShowPaymentModal(false)
    runAction(async () => {
      await db.payments.record({
        customer_id: doc.customer_id,
        amount,
        method,
        created_by: currentUserEmail,
        allocations: [{ invoice_id: doc.id, amount }],
      })
      toast.success(t('salesDocuments.paymentRecorded'))
    })
  }
  const handleVoidInvoice = (reason) => {
    setShowVoidModal(false)
    runAction(async () => {
      await db.crmInvoices.void_(doc.id, reason, currentUserEmail)
      toast.success(t('salesDocuments.voidedToast'))
    })
  }
  // ── Credit Note lifecycle ─────────────────────────────────────────────────

  const handleIssueCN = () => runAction(async () => {
    // Second of the two call sites that issued the note and closed the ticket
    // as separate writes (BUG-048). The close now happens inside the RPC, in
    // the same transaction, so the pair cannot come apart.
    const cnCode = await db.creditNotes.issue(doc.id, currentUserEmail, !!doc.ticket_id)
    if (doc.ticket_id) {
      await db.ticketActivity.log(doc.ticket_id, 'credit_note_created', `${cnCode} issued — ${doc.reason}`, currentUserEmail)
      toast.success(t('salesDocuments.cnFromTicketToast', { code: cnCode }))
    } else {
      toast.success(t('salesDocuments.issuedToast', { code: cnCode }))
    }
  })
  const handleVoidCN = (reason) => {
    setShowVoidModal(false)
    runAction(async () => {
      await db.creditNotes.void_(doc.id, reason, currentUserEmail)
      toast.success(t('salesDocuments.voidedToast'))
    })
  }

  // ── Archive / restore ─────────────────────────────────────────────────────

  const handleArchiveToggle = async () => {
    setBusy(true)
    try {
      await db.salesDocuments.setArchived(docType, doc.id, !doc.archived, currentUserEmail)
      toast.success(t(doc.archived ? 'salesDocuments.restoredToast' : 'salesDocuments.archivedToast'))
      refresh()
    } catch (err) {
      console.error('archive toggle failed', err)
      toast.error(t('salesDocuments.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  // ── Formatters ────────────────────────────────────────────────────────────

  const statusLabel = (s) => {
    const key = `salesDocuments.st_${s}`
    const label = t(key)
    return label === key ? s : label
  }
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')
  const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })

  // ── Guards ────────────────────────────────────────────────────────────────

  if (!adapter) {
    return <div className="p-6"><EmptyState title={t('salesDocuments.noDocuments')} description="" action={onBack} actionLabel={t('common.back')} /></div>
  }
  if (isLoading) {
    return <div className="flex justify-center py-20"><Spinner /></div>
  }
  if (isError || !doc) {
    return <div className="p-6"><EmptyState title={t('salesDocuments.noDocuments')} description="" action={onBack} actionLabel={t('common.back')} /></div>
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const n = adapter.norm(doc)
  const lines = doc.line_items || []
  const customerName = customer ? (customer.company_name || customer.contact_person || '—') : '—'
  const qtIsConverted = isQuotation && n.status === 'converted'

  const lineNet = (l) => {
    const base = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
    const net = base - base * ((Number(l.discount_pct) || 0) / 100)
    return net + net * ((Number(l.tax_pct) || 0) / 100)
  }

  // Linked-from source document chip
  const linkedFrom = (() => {
    if (isSO && linkedQuotation) {
      return { label: t(DOC_TYPE_LABEL_KEY.quotation), code: linkedQuotation.qt_code, path: `/sales/quotation/${linkedQuotation.id}` }
    }
    if (isInvoice && linkedSO) {
      return { label: t(DOC_TYPE_LABEL_KEY.sales_order), code: linkedSO.so_code, path: `/sales/sales_order/${linkedSO.id}` }
    }
    if (isCreditNote && doc.source_invoice_id) {
      return { label: t(DOC_TYPE_LABEL_KEY.invoice), code: doc.source_invoice_number || '—', path: `/sales/invoice/${doc.source_invoice_id}` }
    }
    return null
  })()

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="w-full px-4 py-6 max-w-4xl mx-auto">
      <PageHeader
        title={n.code || t(DOC_TYPE_LABEL_KEY[docType])}
        subtitle={t(DOC_TYPE_LABEL_KEY[docType])}
        onBack={onBack}
        backLabel={t('common.back')}
      >
        <div className="flex items-center gap-2 flex-wrap justify-end">

          {/* ── Quotation actions ── */}
          {isQuotation && !doc.archived && (
            <>
              {/* 'accepted' locks the QT: once approved it must not change, or the
                  approved figures and the resulting SO could diverge. */}
              {!qtIsConverted && !['cancelled', 'expired', 'declined', 'accepted'].includes(n.status) && (
                <Button variant="secondary" size="sm" disabled={!canEditDoc} onClick={() => setEditing(true)}>
                  {t('salesDocuments.edit')}
                </Button>
              )}
              {!qtIsConverted && n.status === 'draft' && (
                <Button disabled={!canEditDoc} variant="secondary" size="sm" onClick={handleSendForApproval} loading={busy}>
                  {t('pipeline.sendForApproval')}
                </Button>
              )}
              {!qtIsConverted && n.status === 'sent' && (
                <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] italic self-center">
                  {t('salesDocuments.awaitingApproval')}
                </span>
              )}
              {!qtIsConverted && n.status === 'accepted' && (
                <Button disabled={!canEditDoc} size="sm" onClick={handleConvertToSO} loading={busy}>
                  {t('salesDocuments.convertToSO')}
                </Button>
              )}
              {/* Download PDF: show when approved or after conversion (reference copy) */}
              {(n.status === 'accepted' || qtIsConverted) && (
                <Button variant="secondary" size="sm" onClick={handleDownloadPDF}>
                  {t('salesDocuments.downloadPDF')}
                </Button>
              )}
              {!qtIsConverted && ['cancelled', 'declined'].includes(n.status) && (
                <Button disabled={!canEditDoc} variant="secondary" size="sm" onClick={handleReopenForApproval} loading={busy}>
                  {t('pipeline.reopenForApproval')}
                </Button>
              )}
              {!qtIsConverted && ['draft', 'sent', 'accepted'].includes(n.status) && (
                <Button disabled={!canCancelDoc} variant="danger" size="sm" onClick={handleCancelQt} loading={busy}>
                  {t('common.cancel')}
                </Button>
              )}
            </>
          )}

          {/* ── Sales Order actions ── */}
          {isSO && !doc.archived && (
            <>
              {!soIsInvoiced && n.status === 'draft' && (
                <Button variant="secondary" size="sm" disabled={!canEditDoc} onClick={() => setEditing(true)}>
                  {t('salesDocuments.edit')}
                </Button>
              )}
              {!soIsInvoiced && n.status === 'draft' && (
                <Button disabled={!canEditDoc} variant="secondary" size="sm" onClick={handleSOSendForApproval} loading={busy}>
                  {t('pipeline.sendForApproval')}
                </Button>
              )}
              {!soIsInvoiced && n.status === 'sent' && (
                <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] italic self-center">
                  {t('salesDocuments.awaitingApproval')}
                </span>
              )}
              {/* Download PDF: show once approved (auto-reserved+delivered) or after invoiced (reference copy) */}
              {(['accepted', 'confirmed', 'delivered'].includes(n.status) || soIsInvoiced) && (
                <Button variant="secondary" size="sm" onClick={handleDownloadSOPDF}>
                  {t('salesDocuments.downloadPDF')}
                </Button>
              )}
              {!soIsInvoiced && ['confirmed', 'delivered'].includes(n.status) && (
                <Button disabled={!canPostDoc} size="sm" onClick={handleConvertToInvoice} loading={busy}>
                  {t('salesDocuments.convertToInvoice')}
                </Button>
              )}
              {!soIsInvoiced && ['declined', 'cancelled'].includes(n.status) && (
                <Button disabled={!canEditDoc} variant="secondary" size="sm" onClick={handleSOReopen} loading={busy}>
                  {t('pipeline.reopenForApproval')}
                </Button>
              )}
              {!soIsInvoiced && ['draft', 'sent', 'accepted', 'confirmed', 'delivered'].includes(n.status) && (
                <Button disabled={!canCancelDoc} variant="danger" size="sm" onClick={handleCancelSO} loading={busy}>
                  {t('common.cancel')}
                </Button>
              )}
            </>
          )}

          {/* ── Invoice actions ── */}
          {isInvoice && !doc.archived && (
            <>
              {n.status === 'draft' && (
                <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] italic self-center">
                  {t('salesDocuments.awaitingApproval')}
                </span>
              )}
              {n.status === 'posted' && (
                <Button disabled={!canTakePayment} variant="secondary" size="sm" onClick={() => setShowPaymentModal(true)}>
                  {t('salesDocuments.recordPayment')}
                </Button>
              )}
              {n.status === 'posted' && (
                <Button disabled={!canCancelDoc} variant="danger" size="sm" onClick={() => setShowVoidModal(true)}>
                  {t('salesDocuments.voidInvoice')}
                </Button>
              )}
            </>
          )}

          {/* ── Credit Note actions ── */}
          {isCreditNote && !doc.archived && (
            <>
              {n.status === 'draft' && (
                <Button disabled={!canPostDoc} size="sm" onClick={handleIssueCN} loading={busy}>
                  {t('salesDocuments.issueCN')}
                </Button>
              )}
              {['draft', 'issued'].includes(n.status) && (
                <Button disabled={!canCancelDoc} variant="danger" size="sm" onClick={() => setShowVoidModal(true)}>
                  {t('salesDocuments.voidCN')}
                </Button>
              )}
            </>
          )}

          {/* Archive / restore — hidden for locked (converted/invoiced) documents */}
          {!qtIsConverted && !soIsInvoiced && (
            <Button disabled={!canEditDoc} variant="secondary" size="sm" onClick={handleArchiveToggle} loading={busy}>
              {doc.archived ? t('salesDocuments.restore') : t('salesDocuments.archive')}
            </Button>
          )}
        </div>
      </PageHeader>

      {/* ── Modals ── */}
      {editing && (
        <DocumentFormModal
          docType={docType}
          initial={doc}
          salesReps={salesReps}
          currentUserEmail={currentUserEmail}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh() }}
        />
      )}
      {showPaymentModal && (
        <RecordPaymentModal
          invoice={doc}
          onClose={() => setShowPaymentModal(false)}
          onConfirm={handleRecordPayment}
        />
      )}
      {showVoidModal && (
        <VoidModal
          requireReason={isInvoice}
          onClose={() => setShowVoidModal(false)}
          onConfirm={isInvoice ? handleVoidInvoice : handleVoidCN}
        />
      )}
      {/* ── Header card ── */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px] mb-4">
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="font-mono text-sm font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded">
            {n.code || '—'}
          </span>
          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(n.status)}`}>
            {isQuotation && QT_APPROVAL_KEY[n.status] ? t(QT_APPROVAL_KEY[n.status]) : statusLabel(n.status)}
          </span>
          {n.paymentStatus && (
            <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(n.paymentStatus)}`}>
              {statusLabel(n.paymentStatus)}
            </span>
          )}
          {doc.archived && (
            <span className="px-2 py-0.5 text-xs rounded-full font-medium bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              {t('salesDocuments.archivedBadge')}
            </span>
          )}
          {/* Linked-from trail */}
          {linkedFrom && (
            <button
              onClick={() => navigate(linkedFrom.path)}
              className="inline-flex items-center gap-1 text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#4338ca] dark:hover:text-[#a5b4fc] transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              {t('salesDocuments.linkedFrom')}: {linkedFrom.label}
              <span className="font-mono">{linkedFrom.code}</span>
            </button>
          )}
          {/* Converted-to trail: SO → Invoice */}
          {soIsInvoiced && linkedInvoiceFromSO && (
            <button
              onClick={() => navigate(`/sales/invoice/${linkedInvoiceFromSO.id}`)}
              className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
              {t('salesDocuments.viewInvoice')}: <span className="font-mono">{linkedInvoiceFromSO.inv_code || t('salesDocuments.st_draft')}</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <Field label={t('salesDocuments.fCustomer')} value={customerName} />
          {customer?.customer_code && <Field label={t('salesDocuments.colCode')} value={customer.customer_code} mono />}
          <Field label={t('salesDocuments.fRep')} value={doc.assigned_rep || t('salesDocuments.unassigned')} />
          {n.dateKey && <Field label={t(n.dateKey)} value={fmtDate(n.dateVal)} />}
          {doc.payment_terms && <Field label={t('salesDocuments.fPaymentTerms')} value={doc.payment_terms} />}
          {doc.reference_po && <Field label={t('salesDocuments.fReference')} value={doc.reference_po} />}
          {n.reason && <Field label={t('salesDocuments.cnReason')} value={n.reason} />}
          <Field label={t('salesDocuments.colCreated')} value={fmtDate(doc.created_at)} />
          {/* Invoice-specific: show paid/remaining if posted */}
          {isInvoice && n.status === 'posted' && (
            <>
              <Field label={t('salesDocuments.amountPaid')} value={fmtMoney(doc.amount_paid)} />
              <Field label={t('salesDocuments.remainingBalance')} value={fmtMoney((doc.total ?? 0) - (doc.amount_paid ?? 0))} />
            </>
          )}
        </div>
      </div>

      {/* ── Line items ── */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
              <th className="px-4 py-2.5 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fProduct')}</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fQty')}</th>
              <th className="px-3 py-2.5 text-end text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fUnitPrice')}</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fDiscount')}</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fTax')}</th>
              <th className="px-4 py-2.5 text-end text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fLineTotal')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                  {t('salesDocuments.errNoLines')}
                </td>
              </tr>
            ) : lines.map((l, i) => (
              <tr key={i} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{l.product_name}</div>
                  {l.description && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{l.description}</div>}
                </td>
                <td className="px-3 py-2.5 text-center text-[#211f1b] dark:text-[#e8ebf0]">{l.qty}</td>
                <td className="px-3 py-2.5 text-end text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(l.unit_price)}</td>
                <td className="px-3 py-2.5 text-center text-[#6c6760] dark:text-[#9aa4b2]">{l.discount_pct ? l.discount_pct + '%' : '—'}</td>
                <td className="px-3 py-2.5 text-center text-[#6c6760] dark:text-[#9aa4b2]">{l.tax_pct ? l.tax_pct + '%' : '—'}</td>
                <td className="px-4 py-2.5 text-end font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(lineNet(l))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-end p-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
          <div className="w-full sm:w-64 space-y-1 text-sm">
            <TotalRow label={t('salesDocuments.subtotal')} value={fmtMoney(doc.subtotal)} />
            {Number(doc.discount_amount) > 0 && (
              <TotalRow label={t('salesDocuments.totalDiscount')} value={'-' + fmtMoney(doc.discount_amount)} muted />
            )}
            {Number(doc.tax_amount) > 0 && (
              <TotalRow label={t('salesDocuments.totalTax')} value={fmtMoney(doc.tax_amount)} muted />
            )}
            <div className="flex items-center justify-between pt-2 mt-1 border-t border-[#e6e9ef] dark:border-[#212a38]">
              <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.grandTotal')}</span>
              <span className="font-bold text-indigo-600 dark:text-[#a5b4fc]">{fmtMoney(doc.total)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Notes ── */}
      {doc.notes && (
        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
          <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1.5">{t('salesDocuments.fNotes')}</div>
          <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0] whitespace-pre-wrap leading-relaxed">{doc.notes}</p>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}

// ── Field + TotalRow helpers ──────────────────────────────────────────────────

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
