import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { Button, Input, Spinner } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { ActivityChatter } from '../../components/ActivityChatter'
import { CommentPanel } from '../../components/CommentPanel'
import { EMPTY_DEAL_FORM, EMPTY_LOST_FORM } from './_constants'
import { CreateDealModal, MarkLostModal, ReopenDealModal } from './_modals'
import { ProductSearchInput } from './_shared'
import { useURLTab } from '../../hooks/useURLTab'
import { downloadQuotationPDF } from '../../lib/quotationPdf'
import { dealValueFor, canMarkDealWon } from '../../lib/dealValue'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

const CARD = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]'

// One color set per stage position (wraps if > 5 active stages)
const STAGE_COLORS = [
  { active: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300', inactive: 'bg-blue-50 dark:bg-blue-900/10 text-blue-400 dark:text-blue-500', ring: 'ring-blue-400 dark:ring-blue-400' },
  { active: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300', inactive: 'bg-indigo-50 dark:bg-indigo-900/10 text-indigo-400 dark:text-indigo-500', ring: 'ring-indigo-400 dark:ring-indigo-400' },
  { active: 'bg-violet-100 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300', inactive: 'bg-violet-50 dark:bg-violet-900/10 text-violet-400 dark:text-violet-500', ring: 'ring-violet-400 dark:ring-violet-400' },
  { active: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300', inactive: 'bg-amber-50 dark:bg-amber-900/10 text-amber-400 dark:text-amber-500', ring: 'ring-amber-400 dark:ring-amber-400' },
  { active: 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300', inactive: 'bg-orange-50 dark:bg-orange-900/10 text-orange-400 dark:text-orange-500', ring: 'ring-orange-400 dark:ring-orange-400' },
]

function probColor(prob) {
  if (prob >= 75) return 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'
  if (prob >= 50) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
  if (prob >= 25) return 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300'
  return 'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#9aa4b2]'
}

function Detail({ label, value }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{label}</div>
      <div className="text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5">{value ?? '—'}</div>
    </div>
  )
}

const EMPTY_QT_LINE = { product_id: null, product_name: '', qty: 1, unit_price: 0, discount_pct: null, tax_pct: null }

function qtStatusCls(status) {
  const map = {
    draft:     'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#9aa4b2]',
    sent:      'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
    accepted:  'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400',
    declined:  'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-300',
    expired:   'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
    cancelled: 'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#a4acb7]',
    converted: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-300',
  }
  return map[status] ?? map.draft
}

// Quotations move through an internal approval cycle, not a customer-facing
// one — surface the status in approval terms (Pending Approval / Approved /
// Rejected) rather than sent/accepted/declined.
function qtApprovalLabelKey(status) {
  const map = {
    draft:     'pipeline.qtApprovalDraft',
    sent:      'pipeline.qtApprovalPending',
    accepted:  'pipeline.qtApprovalApproved',
    declined:  'pipeline.qtApprovalRejected',
    expired:   'salesDocs.statusExpired',
    cancelled: 'salesDocs.statusCancelled',
    converted: 'salesDocuments.st_converted',
  }
  return map[status] ?? 'pipeline.qtApprovalDraft'
}

export default function DealDetail({ dealId, currentUserRole, currentUserEmail, currentUserPermissions, onBack }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: deal, isLoading, isError } = useQuery({
    queryKey: ['deal', dealId],
    queryFn: () => db.deals.get(dealId),
    enabled: !!dealId,
  })
  const { data: pipelines = EMPTY_ARRAY } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
  })
  const { data: customers = EMPTY_ARRAY } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })
  const { data: usersList = EMPTY_ARRAY } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.directory(),
    staleTime: 5 * 60_000,
  })
  const { data: products = EMPTY_ARRAY } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 60_000,
  })
  // A deal can hold any number of quotations, each independent: each converts to
  // its own SO, and approving one does not affect the others.
  const { data: quotations = EMPTY_ARRAY, isLoading: quotationLoading } = useQuery({
    queryKey: ['quotations', 'deal', dealId],
    queryFn: () => db.quotations.list({ dealId }),
    enabled: !!dealId,
  })
  const convertedQtIds = useMemo(
    () => quotations.filter((q) => q.status === 'converted').map((q) => q.id),
    [quotations]
  )
  // One lookup for every converted QT, keyed back to its quotation for navigation.
  const { data: convertedSOs = EMPTY_ARRAY } = useQuery({
    queryKey: ['sos-by-quotations', convertedQtIds],
    queryFn: () => db.salesOrders.list({ quotationIds: convertedQtIds }),
    enabled: convertedQtIds.length > 0,
    staleTime: 60_000,
  })
  const soByQuotationId = useMemo(() => {
    const m = {}
    for (const so of convertedSOs) if (!m[so.quotation_id]) m[so.quotation_id] = so
    return m
  }, [convertedSOs])
  const salesReps = usersList.filter((u) =>
    u.role === 'sales_rep' || u.role === 'manager' || u.role === 'admin' || u.role === 'super_admin'
  )
  const customer = useMemo(() => customers.find((c) => c.id === deal?.customer_id), [customers, deal])
  const pipeline = useMemo(() => pipelines.find((p) => p.id === deal?.pipeline_id), [pipelines, deal])
  const stages = pipeline ? [...pipeline.stages].sort((a, b) => a.order - b.order) : []
  const activeStages = stages.filter((s) => !s.is_won && !s.is_lost)

  const [showEdit, setShowEdit] = useState(false)
  const [dealForm, setDealForm] = useState(EMPTY_DEAL_FORM)
  const [showLost, setShowLost] = useState(false)
  const [lostForm, setLostForm] = useState(EMPTY_LOST_FORM)
  const [showReopen, setShowReopen] = useState(false)

  // Contacts are customer-scoped, so this follows the customer currently chosen in
  // the edit form (which can now be changed) rather than the deal's saved customer.
  const { data: dealContacts = EMPTY_ARRAY } = useQuery({
    queryKey: ['contacts', dealForm.customer_id],
    queryFn: () => db.contacts.list(dealForm.customer_id),
    enabled: showEdit && !!dealForm.customer_id,
    staleTime: 60_000,
  })

  // Inline value edit (only when no product lines)
  const [editingValue, setEditingValue] = useState(false)
  const [valueInput, setValueInput] = useState('')

  // Inline title edit
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')

  // Inline customer edit (type-ahead)
  const [editingCustomer, setEditingCustomer] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const customerDropdownRef = useRef(null)

  // Inline close date edit
  const [editingCloseDate, setEditingCloseDate] = useState(false)
  const [closeDateInput, setCloseDateInput] = useState('')

  // Inline probability edit
  const [editingProbability, setEditingProbability] = useState(false)
  const [probabilityInput, setProbabilityInput] = useState('')

  // Inline rep edit
  const [editingRep, setEditingRep] = useState(false)
  const [repInput, setRepInput] = useState('')

  // Deal notes tab
  const [notesInput, setNotesInput] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  // Unified tab for right panel: 'note' | 'activity' | 'quotation' | 'deal_notes'
  const [tab, setTab] = useURLTab('tab', 'note')

  // Quotation editor state
  // Which quotation the editor is working on: null = closed, '' = creating a new
  // one, otherwise the id of the quotation being edited.
  const [editingQtId, setEditingQtId] = useState(null)
  const [qtLines, setQtLines] = useState([])
  const [qtValidity, setQtValidity] = useState('')
  const [qtPaymentTerms, setQtPaymentTerms] = useState('')
  const [qtNotes, setQtNotes] = useState('')
  const [savingQuotation, setSavingQuotation] = useState(false)
  // Id of the quotation currently converting, so only that row shows a spinner.
  const [convertingSOId, setConvertingSOId] = useState(null)

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.deals?.[action] === true
  }

  // Sync notesInput when deal loads/refreshes
  useEffect(() => {
    setNotesInput(deal?.notes ?? '')
  }, [deal?.notes])

  // Close customer dropdown on outside click
  useEffect(() => {
    if (!editingCustomer) return
    const handler = (e) => {
      if (customerDropdownRef.current && !customerDropdownRef.current.contains(e.target)) {
        setEditingCustomer(false)
        setCustomerSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [editingCustomer])

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.toLowerCase()
    return customers
      .filter((c) =>
        !q || c.company_name?.toLowerCase().includes(q) || c.contact_person?.toLowerCase().includes(q)
      )
      .slice(0, 10)
  }, [customers, customerSearch])

  // Mirrors LeadDetails' FIELD_KEY_MAP so the deal log records field edits, not
  // just stage/quotation events. ActivityChatter renders 'field_updated|key|value'
  // by running the middle segment through t(), so these must be i18n keys.
  const DEAL_FIELD_KEY_MAP = {
    title:               'pipeline.dealTitle',
    customer_id:         'pipeline.customer',
    contact_id:          'customers.contactPerson',
    value:               'leadModal.dealValue',
    expected_close_date: 'pipeline.expectedCloseDate',
    probability:         'pipeline.probability',
    assigned_rep:        'leadModal.assignRep',
  }

  // displayValue lets callers log something human-readable where the stored value
  // is an id (customer_id logs the company name, not a uuid).
  const saveField = async (field, value, displayValue) => {
    try {
      await db.deals.update(deal.id, { [field]: value })
      toast.success(t('pipeline.dealUpdated'))
      const fieldKey = DEAL_FIELD_KEY_MAP[field]
      if (fieldKey) {
        const shown = displayValue ?? value
        logEvent(`field_updated|${fieldKey}|${shown || '—'}`)
      }
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleSaveTitle = () => {
    if (!titleInput.trim()) { toast.error(t('pipeline.createDealValidation')); return }
    saveField('title', titleInput.trim())
    setEditingTitle(false)
  }

  const handleSelectCustomer = (c) => {
    saveField('customer_id', c.id, c.company_name || c.contact_person)
    setEditingCustomer(false)
    setCustomerSearch('')
  }

  const handleSaveCloseDate = () => {
    saveField('expected_close_date', closeDateInput || null)
    setEditingCloseDate(false)
  }

  const handleSaveProbability = () => {
    const val = Math.min(100, Math.max(0, Number(probabilityInput) || 0))
    saveField('probability', val)
    setEditingProbability(false)
  }

  const handleSaveRep = () => {
    saveField('assigned_rep', repInput || null)
    setEditingRep(false)
  }

  const handleSaveNotes = async () => {
    setSavingNotes(true)
    try {
      await db.deals.update(deal.id, { notes: notesInput || null })
      toast.success(t('pipeline.dealUpdated'))
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    } finally {
      setSavingNotes(false)
    }
  }

  // ── Deal Log write tracking ───────────────────────────────────────────────
  // Activity-log writes are fire-and-forget on purpose: a failed log must never
  // fail the user's save. But refresh() used to invalidate immediately, so the
  // refetch raced those INSERTs and usually won — the Deal Log then showed a
  // stale feed until the page was reloaded, and nothing invalidated again once
  // the writes landed. Found three times in manual QA on 2026-08-05
  // (WAREHOUSE_R1_TEST_CHECKLIST.md §B/§C): quotation submitted for approval,
  // and deal field edits, both missing from the log until a manual reload.
  //
  // logEvent keeps each in-flight write so refresh() can await them before
  // refetching. Failures are still swallowed — awaiting a settled rejection is
  // enough to know the refetch will see whatever did land.
  const pendingLogs = useRef([])

  const logEvent = (message) => {
    const p = db.activities.logSystem('deal', deal.id, message, currentUserEmail).catch(() => {})
    pendingLogs.current.push(p)
    return p
  }

  const refresh = async () => {
    const inFlight = pendingLogs.current
    pendingLogs.current = []
    if (inFlight.length) await Promise.allSettled(inFlight)
    queryClient.invalidateQueries({ queryKey: ['deal', dealId] })
    queryClient.invalidateQueries({ queryKey: ['deals'] })
    queryClient.invalidateQueries({ queryKey: ['activities', 'deal', dealId] })
    queryClient.invalidateQueries({ queryKey: ['quotations', 'deal', dealId] })
    queryClient.invalidateQueries({ queryKey: ['sos-by-quotations'] })
  }

  const isClosed = deal?.status !== 'open'
  const canEditDeal = canDo('edit') && !isClosed

  const handleStageChange = async (stageId) => {
    if (!deal || deal.stage === stageId) return
    try {
      await db.deals.moveStage(deal.id, stageId, currentUserEmail)
      toast.success(t('pipeline.stageUpdated'))
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  // Opens CreateDealModal in edit mode — a single dialog for the fields that are
  // otherwise separate inline edits. Stage is hidden in edit mode (it has its own
  // control with move-stage logging), so the modal's editable set is exactly what
  // handleSaveEdit persists. contact_id/pipeline_id ride along in form state but
  // are not rendered — changing pipeline would orphan stage, which needs a remap.
  const handleOpenEdit = () => {
    setDealForm({
      title: deal.title || '',
      customer_id: deal.customer_id,
      customer_label: customer?.company_name || customer?.contact_person || '',
      contact_id: deal.contact_id || '',
      pipeline_id: deal.pipeline_id,
      stage: deal.stage,
      value: deal.value ?? '',
      probability: deal.probability ?? 0,
      expected_close_date: deal.expected_close_date || '',
      assigned_rep: deal.assigned_rep || '',
      notes: deal.notes || '',
    })
    setShowEdit(true)
  }

  const handleSaveEdit = async () => {
    if (!dealForm.title.trim() || !dealForm.customer_id) {
      toast.error(t('pipeline.createDealValidation'))
      return
    }
    // Moving pipeline requires a destination stage — movePipeline rejects a stage
    // that isn't in the target pipeline, so catch it here with a clearer message.
    if (dealForm.pipeline_id !== deal.pipeline_id && !dealForm.stage) {
      toast.error(t('pipeline.pipelineChangeStageHint'))
      return
    }
    const patch = {
      title: dealForm.title.trim(),
      customer_id: dealForm.customer_id,
      contact_id: dealForm.contact_id || null,
      // With quotations present the value is derived from them, never typed in.
      value: quotations.length > 0 ? deal.value : (dealForm.value ? Number(dealForm.value) : null),
      probability: Number(dealForm.probability ?? 0),
      expected_close_date: dealForm.expected_close_date || null,
      assigned_rep: dealForm.assigned_rep || null,
      notes: dealForm.notes || null,
    }
    try {
      await db.deals.update(deal.id, patch)
      // A pipeline move rewrites pipeline_id + stage together and logs the move —
      // deals.update() can't do it safely, since the old stage doesn't exist in the
      // destination pipeline.
      if (dealForm.pipeline_id && dealForm.pipeline_id !== deal.pipeline_id) {
        await db.deals.movePipeline(deal.id, dealForm.pipeline_id, dealForm.stage, currentUserEmail)
      }
      toast.success(t('pipeline.dealUpdated'))
      // Log only the fields that actually changed, so a no-op save adds no noise.
      for (const [field, fieldKey] of Object.entries(DEAL_FIELD_KEY_MAP)) {
        if (patch[field] === undefined || patch[field] === deal[field]) continue
        const shown =
          field === 'customer_id' ? dealForm.customer_label
          : field === 'contact_id' ? dealContacts.find((c) => c.id === patch[field])?.full_name
          : patch[field]
        logEvent(`field_updated|${fieldKey}|${shown || '—'}`)
      }
      setShowEdit(false)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  // Archive replaces the old "Cancel" action: nothing is deleted or status-flipped,
  // the QT just moves to the Archive tab on /sales. Uses the same setArchived call
  // that page uses, so the two stay in sync by construction.
  const handleToggleArchiveQuotation = async (qt) => {
    const nowArchived = !qt.archived
    try {
      await db.salesDocuments.setArchived('quotation', qt.id, nowArchived, currentUserEmail)
      toast.success(t(nowArchived ? 'salesDocuments.archivedToast' : 'salesDocuments.restoredToast'))
      // Archiving removes a quotation from the deal's value; restoring adds it back.
      await syncDealValue(quotations.map((q) => (q.id === qt.id ? { ...q, archived: nowArchived } : q)))
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleMarkWon = async () => {
    // A deal with quotations can only be won once at least one is converted to a
    // Sales Order — otherwise its "actual" value would be 0 and the win wouldn't
    // be backed by a real order. Deals with no quotations are unaffected.
    if (!canMarkDealWon(quotations)) {
      toast.error(t('pipeline.wonNeedsConvertedQuotation'))
      return
    }
    try {
      await db.deals.markWon(deal.id, currentUserEmail)
      // Value flips from forecast to actual now that the deal is closed.
      await syncDealValue(quotations, 'won')
      toast.success(t('pipeline.dealMarkedWon'))
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleReopen = async (stageId) => {
    try {
      await db.deals.reopen(deal.id, stageId, currentUserEmail)
      // Back to forecast: the value climbs again to include pending quotations.
      await syncDealValue(quotations, 'open')
      toast.success(t('pipeline.dealReopened'))
      setShowReopen(false)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleConfirmLost = async () => {
    if (!lostForm.reason.trim()) return
    try {
      await db.deals.markLost(deal.id, lostForm.reason.trim(), currentUserEmail)
      // Closed: value drops to whatever actually converted (often nothing).
      await syncDealValue(quotations, 'lost')
      toast.success(t('pipeline.dealMarkedLost'))
      setShowLost(false)
      setLostForm(EMPTY_LOST_FORM)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleSaveInlineValue = async () => {
    try {
      await db.deals.update(deal.id, { value: valueInput !== '' ? Number(valueInput) : null })
      toast.success(t('pipeline.dealUpdated'))
      setEditingValue(false)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  // Value rules live in src/lib/dealValue.ts (pure + unit-tested) — see that file
  // for the forecast-vs-actual contract.
  //
  // dealStatus is passed explicitly because callers often need the value for the
  // status the deal is ABOUT to have (marking won, reopening), not its current one.
  const syncDealValue = async (list, dealStatus = deal.status) => {
    // Deals with no quotations carry a hand-typed value — never overwrite it.
    if (list.length === 0) return
    const total = dealValueFor(list, dealStatus)
    await db.deals.update(deal.id, { value: total || null })
  }

  // Pass a quotation to edit it, or nothing to start a new one on this deal.
  const openQuotationEditor = (qt) => {
    if (qt) {
      setQtLines(qt.line_items.length > 0 ? qt.line_items : [{ ...EMPTY_QT_LINE }])
      setQtValidity(qt.validity_until ?? '')
      setQtPaymentTerms(qt.payment_terms ?? '')
      setQtNotes(qt.notes ?? '')
      setEditingQtId(qt.id)
    } else {
      setQtLines([{ ...EMPTY_QT_LINE }])
      setQtValidity('')
      setQtPaymentTerms('')
      setQtNotes('')
      setEditingQtId('')
    }
  }
  const closeQuotationEditor = () => setEditingQtId(null)

  const updateQtLine = (i, field, val) =>
    setQtLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)))
  const selectQtProduct = (i, product) =>
    setQtLines((prev) =>
      prev.map((l, idx) =>
        idx === i
          ? { ...l, product_id: product.id, product_name: product.product_name, unit_price: product.unit_price ?? l.unit_price }
          : l
      )
    )
  const addQtLine = () => setQtLines((prev) => [...prev, { ...EMPTY_QT_LINE }])
  const removeQtLine = (i) => setQtLines((prev) => prev.filter((_, idx) => idx !== i))

  const saveQuotation = async () => {
    const isNew = !editingQtId
    setSavingQuotation(true)
    try {
      const cleanedLines = qtLines.filter((l) => l.product_name.trim())
      const fields = {
        line_items: cleanedLines,
        validity_until: qtValidity || null,
        payment_terms: qtPaymentTerms || null,
        notes: qtNotes || null,
      }
      let saved
      if (isNew) {
        saved = await db.quotations.create({
          ...fields,
          customer_id: deal.customer_id,
          deal_id: deal.id,
          assigned_rep: deal.assigned_rep,
          created_by: currentUserEmail,
        })
        toast.success(t('salesDocs.successCreated'))
        logEvent(`quotation_created|${saved.qt_code}`)
      } else {
        saved = await db.quotations.update(editingQtId, fields)
        toast.success(t('salesDocs.successUpdated'))
      }
      // Deal value = sum of every open quotation, so replace this one's contribution
      // with its new total (the cached list still holds the pre-save figure).
      await syncDealValue(
        isNew
          ? [...quotations, saved]
          : quotations.map((q) => (q.id === saved.id ? saved : q))
      )
      closeQuotationEditor()
      refresh()
    } catch {
      toast.error(t('salesDocs.errorSaveFailed'))
    } finally {
      setSavingQuotation(false)
    }
  }

  const ACTION_LOG_KIND = {
    markSent: 'quotation_sent',
    markAccepted: 'quotation_accepted',
    markDeclined: 'quotation_declined',
    cancel: 'quotation_cancelled',
    reopen: 'quotation_reopened',
  }

  // The status each action lands the quotation on, so the deal value can be
  // recomputed without waiting for the list to refetch. Declining or cancelling
  // drops that quotation out of the forecast entirely.
  const ACTION_RESULT_STATUS = {
    markSent: 'sent',
    markAccepted: 'accepted',
    markDeclined: 'declined',
    cancel: 'cancelled',
    reopen: 'draft',
  }

  const withQtStatus = (qtId, status) =>
    quotations.map((q) => (q.id === qtId ? { ...q, status } : q))

  // Raise the approval-pool activity that surfaces in the Activities page.
  // Format: approval|docType|docId|code|total|customer — parsed there to render
  // the Source badge and dispatch the approve/reject action to this quotation.
  const createApprovalActivity = (qt) => {
    const customerName = customer?.company_name || customer?.contact_person || '—'
    return db.activities.create({
      related_type: 'deal',
      related_id: deal.id,
      type: 'approval',
      title: `approval|quotation|${qt.id}|${qt.qt_code}|${qt.total ?? 0}|${customerName}`,
      // Always set a due_date — listAllPlanned() filters out null-due_date rows,
      // so a null here would hide the approval from the Activities page.
      due_date: qt.validity_until || new Date().toISOString(),
      assigned_rep: qt.assigned_rep || null,
      outcome_notes: null,
      created_by: currentUserEmail,
    }).catch((err) => {
      console.error('Failed to create approval activity', err)
      toast.error(t('pipeline.approvalActivityFailed'))
    })
  }

  const handleQuotationStatus = async (action, qt) => {
    if (!qt) return
    try {
      await db.quotations[action](qt.id)
      toast.success(t('pipeline.quotationStatusUpdated'))
      const kind = ACTION_LOG_KIND[action]
      if (kind) {
        logEvent(`${kind}|${qt.qt_code}`)
      }
      const nextStatus = ACTION_RESULT_STATUS[action]
      if (nextStatus) await syncDealValue(withQtStatus(qt.id, nextStatus))
      if (action === 'markSent') createApprovalActivity(qt)
      refresh()
    } catch {
      toast.error(t('salesDocs.errorSaveFailed'))
    }
  }

  // Reopen a declined/cancelled quotation straight back into the approval queue:
  // flip it to 'sent' and raise a fresh approval activity.
  const handleReopenForApproval = async (qt) => {
    if (!qt) return
    try {
      await db.quotations.markSent(qt.id)
      logEvent(`quotation_reopened|${qt.qt_code}`)
      // Reopening a dead quotation puts its value back into the forecast.
      await syncDealValue(withQtStatus(qt.id, 'sent'))
      createApprovalActivity(qt)
      toast.success(t('pipeline.quotationStatusUpdated'))
      refresh()
    } catch {
      toast.error(t('salesDocs.errorSaveFailed'))
    }
  }

  const handleConvertToSO = async (qt) => {
    if (!qt) return
    const freeLines = db.quotations.freeFormLines(qt)
    if (freeLines.length > 0) {
      toast.error(t('pipeline.quotationFreeFormError', { count: freeLines.length }))
      return
    }
    setConvertingSOId(qt.id)
    try {
      await db.quotations.convertToSalesOrder(qt.id, currentUserEmail)
      toast.success(t('salesDocs.successConverted'))
      logEvent(`quotation_converted|${qt.qt_code}`)
      // No change while the deal is open (converted still counts as live), but it
      // does change what the deal would be worth once closed.
      await syncDealValue(withQtStatus(qt.id, 'converted'))
      refresh()
    } catch {
      toast.error(t('salesDocs.errorConvertFailed'))
    } finally {
      setConvertingSOId(null)
    }
  }

  // The approval activity encodes its target as approval|quotation|<id>|... — with
  // several quotations per deal the activity is the only thing that says which one.
  // Falls back to the sole quotation for legacy activities raised before this.
  const quotationForActivity = (activity) => {
    const id = activity?.title?.split('|')[2]
    return quotations.find((q) => q.id === id) ?? (quotations.length === 1 ? quotations[0] : null)
  }

  const resolveApproval = async (activityId, activity, action, logKind) => {
    const qt = quotationForActivity(activity)
    if (!qt) {
      toast.error(t('salesDocs.errorSaveFailed'))
      return
    }
    try {
      await db.quotations[action](qt.id)
      await db.activities.complete(activityId, `${logKind === 'quotation_accepted' ? 'Approved' : 'Rejected'} by ${currentUserEmail}`)
      logEvent(`${logKind}|${qt.qt_code}`)
      // Rejecting drops this quotation out of the deal's forecast.
      await syncDealValue(withQtStatus(qt.id, ACTION_RESULT_STATUS[action]))
      toast.success(t('pipeline.quotationStatusUpdated'))
      refresh()
    } catch {
      toast.error(t('salesDocs.errorSaveFailed'))
    }
  }

  const handleApproveQuotation = (activityId, activity) =>
    resolveApproval(activityId, activity, 'markAccepted', 'quotation_accepted')
  const handleRejectQuotation = (activityId, activity) =>
    resolveApproval(activityId, activity, 'markDeclined', 'quotation_declined')

  const handleDownloadPDF = (qt) =>
    downloadQuotationPDF({ quotation: qt, customer, relatedType: 'deal', relatedId: deal.id })

  if (isLoading) return <PageSkeleton />
  if (isError || !deal) {
    return (
      <div className="p-6">
        <EmptyState title={t('pipeline.dealNotFound')} description="" action={onBack} actionLabel={t('common.back')} />
      </div>
    )
  }

  const hasQuotation = quotations.length > 0
  const canApprove = ['manager', 'admin', 'super_admin'].includes(currentUserRole)
  const displayValue = hasQuotation ? dealValueFor(quotations, deal.status) : Number(deal.value || 0)
  // A deal with quotations needs at least one converted to a Sales Order before it
  // can be won; deals with no quotations at all are unaffected.
  const canMarkWon = canMarkDealWon(quotations)

  const qtEditTotal = qtLines.reduce((sum, l) => {
    const base = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
    const disc = base * ((Number(l.discount_pct) || 0) / 100)
    const net = base - disc
    return sum + net + net * ((Number(l.tax_pct) || 0) / 100)
  }, 0)

  // One editor, reused for "new quotation" and "edit existing" — only ever one is
  // open at a time (editingQtId), so a single node is enough.
  const quotationEditorNode = (
    <div>
      <div className="grid grid-cols-[1fr_40px_80px_50px_50px_24px] gap-1.5 text-xs font-medium text-gray-500 dark:text-[#9aa4b2] uppercase mb-1.5 px-1">
        <span>{t('salesDocs.lineProduct')}</span>
        <span className="text-center">{t('salesDocs.lineQty')}</span>
        <span className="text-right">{t('salesDocs.lineUnitPrice')}</span>
        <span className="text-center">{t('salesDocs.lineDiscount')}</span>
        <span className="text-center">{t('salesDocs.lineTax')}</span>
        <span />
      </div>
      <div className="space-y-1.5">
        {qtLines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_40px_80px_50px_50px_24px] gap-1.5 items-center">
            <ProductSearchInput
              value={l.product_name}
              onChange={(text) => updateQtLine(i, 'product_name', text)}
              onSelectProduct={(p) => selectQtProduct(i, p)}
              products={products}
              placeholder={t('pipeline.lineProductPlaceholder')}
              className="flex-1"
              inputClassName="w-full px-2 py-1.5 border border-gray-300 dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm bg-white placeholder-gray-400 transition-colors"
            />
            <Input type="number" min="1" value={l.qty} onChange={(e) => updateQtLine(i, 'qty', e.target.value)} className="w-10 text-sm text-center !px-1" />
            <Input type="number" min="0" value={l.unit_price} onChange={(e) => updateQtLine(i, 'unit_price', e.target.value)} className="w-20 text-sm text-right !px-1.5" />
            <Input type="number" min="0" max="100" value={l.discount_pct ?? ''} onChange={(e) => updateQtLine(i, 'discount_pct', e.target.value !== '' ? Number(e.target.value) : null)} placeholder="0" className="w-12 text-sm text-center !px-1" />
            <Input type="number" min="0" max="100" value={l.tax_pct ?? ''} onChange={(e) => updateQtLine(i, 'tax_pct', e.target.value !== '' ? Number(e.target.value) : null)} placeholder="0" className="w-12 text-sm text-center !px-1" />
            <button onClick={() => removeQtLine(i)} className="w-6 h-6 flex items-center justify-center text-red-400 hover:text-red-600 text-base">×</button>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3">
        <div>
          <label className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-1 block">{t('salesDocs.validityUntil')}</label>
          <Input type="date" value={qtValidity} onChange={(e) => setQtValidity(e.target.value)} className="w-full text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-1 block">{t('salesDocs.paymentTerms')}</label>
          <Input value={qtPaymentTerms} onChange={(e) => setQtPaymentTerms(e.target.value)} placeholder="e.g. Net 30" className="w-full text-sm" />
        </div>
      </div>

      <div className="mt-3">
        <label className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-1 block">{t('pipeline.quotationNotes')}</label>
        <textarea
          value={qtNotes}
          onChange={(e) => setQtNotes(e.target.value)}
          placeholder={t('pipeline.quotationNotesPlaceholder')}
          rows={4}
          className="w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-xl text-sm bg-[#f8f9fb] dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#a4acb7] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
        />
      </div>

      <div className="flex items-center justify-between mt-3 pt-2 border-t border-[#e6e9ef] dark:border-[#212a38]">
        <div className="flex items-center gap-3">
          {/* No literal "+" here: unlike pipeline.addLine / salesDocuments.addLine,
              the salesDocs.addLine string already carries one, so prefixing a
              second rendered "+ + Add Line". */}
          <button onClick={addQtLine} className="text-sm text-indigo-600 dark:text-[#a5b4fc] hover:underline">
            {t('salesDocs.addLine')}
          </button>
          <span className="text-xs text-gray-400 dark:text-[#a4acb7]">
            {t('salesDocs.grandTotal')}: {qtEditTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })} {t('pipeline.currency')}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={closeQuotationEditor}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={saveQuotation} loading={savingQuotation}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )

  const TAB_CLS = (active) =>
    `px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
      active
        ? 'border-indigo-600 text-indigo-600 dark:border-[#a5b4fc] dark:text-[#a5b4fc]'
        : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:hover:text-[#e8ebf0]'
    }`

  const EDITABLE = canEditDeal
    ? 'cursor-pointer rounded px-1 -mx-1 border-b-2 border-dashed border-transparent hover:border-indigo-300 dark:hover:border-[#a5b4fc] hover:bg-indigo-50/60 dark:hover:bg-indigo-900/10 transition-all'
    : ''

  return (
    <div className="w-full px-4 py-6">
      {/* Top bar: back + secondary actions */}
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="text-sm text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 flex items-center gap-1">
          ← {t('common.back')}
        </button>
        <div className="flex items-center gap-2">
          {canEditDeal && (
            <Button variant="secondary" size="sm" onClick={handleOpenEdit}>
              {t('pipeline.editDeal')}
            </Button>
          )}
          {isClosed && canDo('edit') && (
            <Button variant="secondary" size="sm" onClick={() => setShowReopen(true)}>
              {t('pipeline.reopenDeal')}
            </Button>
          )}
        </div>
      </div>

      {/* Header card */}
      <div className={`${CARD} mb-4`}>
        {/* Title — inline editable */}
        {editingTitle ? (
          <div className="flex items-center gap-2">
            <input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              className="text-2xl font-bold w-full bg-transparent border-b-2 border-indigo-500 focus:outline-none text-gray-900 dark:text-[#e8ebf0]"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTitle(); if (e.key === 'Escape') setEditingTitle(false) }}
            />
            <button onClick={handleSaveTitle} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
            <button onClick={() => setEditingTitle(false)} className="text-xs text-gray-400 hover:underline">{t('common.cancel')}</button>
          </div>
        ) : (
          <>
            <h1
              className={`text-2xl font-bold text-gray-900 dark:text-[#e8ebf0] leading-tight ${EDITABLE}`}
              onClick={canEditDeal ? () => { setTitleInput(deal.title || ''); setEditingTitle(true) } : undefined}
              title={canEditDeal ? t('pipeline.clickToEdit') : undefined}
            >
              {deal.title}
            </h1>
            {deal.deal_code && (
              <span className="inline-block mt-1 text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded">
                {deal.deal_code}
              </span>
            )}
          </>
        )}

        {/* Customer — inline type-ahead */}
        {editingCustomer ? (
          <div ref={customerDropdownRef} className="relative mt-1 max-w-xs">
            <input
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              placeholder={t('pipeline.searchCustomer')}
              className="w-full text-sm pl-3 pr-7 py-1.5 border border-indigo-500 rounded-lg dark:bg-[#0f1520] dark:text-[#e8ebf0] dark:border-indigo-400 focus:outline-none"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Escape') { setEditingCustomer(false); setCustomerSearch('') } }}
            />
            <button
              onClick={() => { setEditingCustomer(false); setCustomerSearch('') }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-[#e8ebf0] text-base leading-none"
            >×</button>
            {filteredCustomers.length > 0 && (
              <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                {filteredCustomers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => handleSelectCustomer(c)}
                    className="w-full px-3 py-2 text-sm text-left hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0"
                  >
                    {c.company_name || c.contact_person}
                    {c.company_name && c.contact_person && (
                      <span className="text-xs text-gray-400 dark:text-[#a4acb7] ml-1">· {c.contact_person}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p
            className={`text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5 ${EDITABLE}`}
            onClick={canEditDeal ? () => { setCustomerSearch(''); setEditingCustomer(true) } : undefined}
            title={canEditDeal ? t('pipeline.clickToEdit') : undefined}
          >
            {customer?.company_name || customer?.contact_person || '—'}
          </p>
        )}

        {/* Value · Close Date · Probability row */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
          {/* Value */}
          <div className="flex items-center gap-2">
            {editingValue ? (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  value={valueInput}
                  onChange={(e) => setValueInput(e.target.value)}
                  className="w-36 text-base font-semibold"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveInlineValue(); if (e.key === 'Escape') setEditingValue(false) }}
                />
                <button onClick={handleSaveInlineValue} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline">{t('common.save')}</button>
                <button onClick={() => setEditingValue(false)} className="text-xs text-gray-400 hover:underline">{t('common.cancel')}</button>
              </div>
            ) : (
              <>
                <span
                  className={`text-xl font-bold text-gray-900 dark:text-[#e8ebf0] ${!hasQuotation ? EDITABLE : ''}`}
                  onClick={!hasQuotation && canEditDeal ? () => { setValueInput(String(deal.value ?? '')); setEditingValue(true) } : undefined}
                  title={!hasQuotation && canEditDeal ? t('pipeline.clickToEdit') : undefined}
                >
                  {displayValue > 0 ? `${displayValue.toLocaleString()} ${t('pipeline.currency')}` : `— ${t('pipeline.currency')}`}
                </span>
                {hasQuotation && (
                  <span className="text-xs text-gray-400 dark:text-[#a4acb7]">({t('pipeline.valueLocked')})</span>
                )}
              </>
            )}
          </div>

          {/* Expected close date — inline editable */}
          {editingCloseDate ? (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={closeDateInput}
                onChange={(e) => setCloseDateInput(e.target.value)}
                className="text-sm border border-indigo-500 rounded px-2 py-0.5 dark:bg-[#0f1520] dark:text-[#e8ebf0] dark:border-indigo-400 focus:outline-none"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCloseDate(); if (e.key === 'Escape') setEditingCloseDate(false) }}
              />
              <button onClick={handleSaveCloseDate} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline">{t('common.save')}</button>
              <button onClick={() => setEditingCloseDate(false)} className="text-xs text-gray-400 hover:underline">{t('common.cancel')}</button>
            </div>
          ) : (
            <div
              className={`flex items-center gap-1 text-sm text-gray-600 dark:text-[#9aa4b2] ${EDITABLE}`}
              onClick={canEditDeal ? () => { setCloseDateInput(deal.expected_close_date || ''); setEditingCloseDate(true) } : undefined}
              title={canEditDeal ? t('pipeline.clickToEdit') : undefined}
            >
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>
                {deal.expected_close_date
                  ? `${t('pipeline.closeDate')}: ${new Date(deal.expected_close_date).toLocaleDateString()}`
                  : t('pipeline.setCloseDate')}
              </span>
            </div>
          )}

          {/* Probability — inline editable */}
          {deal.probability != null && (
            editingProbability ? (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0" max="100"
                  value={probabilityInput}
                  onChange={(e) => setProbabilityInput(e.target.value)}
                  className="w-16 text-sm border border-indigo-500 rounded px-2 py-0.5 text-center dark:bg-[#0f1520] dark:text-[#e8ebf0] dark:border-indigo-400 focus:outline-none"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveProbability(); if (e.key === 'Escape') setEditingProbability(false) }}
                />
                <span className="text-sm text-gray-500">%</span>
                <button onClick={handleSaveProbability} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline">{t('common.save')}</button>
                <button onClick={() => setEditingProbability(false)} className="text-xs text-gray-400 hover:underline">{t('common.cancel')}</button>
              </div>
            ) : (
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${probColor(deal.probability)} ${canEditDeal ? 'cursor-pointer hover:ring-2 hover:ring-indigo-300 dark:hover:ring-[#a5b4fc] hover:ring-offset-1 dark:hover:ring-offset-[#121823] transition-all' : ''}`}
                onClick={canEditDeal ? () => { setProbabilityInput(String(deal.probability ?? 0)); setEditingProbability(true) } : undefined}
                title={canEditDeal ? t('pipeline.clickToEdit') : undefined}
              >
                {deal.probability}% {t('pipeline.probability')}
              </span>
            )
          )}

          {/* Won/Lost badge for closed deals */}
          {deal.status === 'won' && (
            <span className="px-3 py-0.5 text-sm rounded-full font-medium bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400">
              ✓ {t('pipeline.won')}
            </span>
          )}
          {deal.status === 'lost' && (
            <span className="px-3 py-0.5 text-sm rounded-full font-medium bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300">
              ✗ {t('pipeline.lost')}
            </span>
          )}
        </div>

        {/* Stage progress + Won/Lost inline */}
        <div className="flex flex-wrap items-center gap-1.5 mt-4">
          {isClosed ? (
            <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
              {deal.status === 'lost' && deal.lost_reason ? `${t('pipeline.lostReason')}: ${deal.lost_reason}` : t('pipeline.dealClosed')}
            </span>
          ) : (
            <>
              {activeStages.map((s, idx) => {
                const colors = STAGE_COLORS[idx % STAGE_COLORS.length]
                const active = deal.stage === s.id
                return (
                  <button
                    key={s.id}
                    disabled={!canDo('edit') || active}
                    onClick={() => handleStageChange(s.id)}
                    className={`px-3 py-1 text-xs rounded-full font-medium transition-all ${
                      active
                        ? `${colors.active} ring-2 ring-offset-1 ${colors.ring} dark:ring-offset-[#121823]`
                        : `${colors.inactive} ${canDo('edit') ? 'hover:opacity-90 cursor-pointer' : 'cursor-default opacity-60'}`
                    }`}
                  >
                    {s.name}
                  </button>
                )
              })}
              {/* Separator */}
              <span className="text-gray-300 dark:text-[#212a38] mx-1 select-none">|</span>
              {canDo('edit') && (
                <button
                  onClick={() => setShowLost(true)}
                  className="px-3 py-1 text-xs rounded-full font-medium bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/40 transition-colors"
                >
                  ✗ {t('pipeline.markLost')}
                </button>
              )}
              {canDo('edit') && (
                <button
                  onClick={handleMarkWon}
                  disabled={!canMarkWon}
                  title={!canMarkWon ? t('pipeline.wonNeedsConvertedQuotation') : undefined}
                  className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                    canMarkWon
                      ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/40'
                      : 'bg-gray-100 dark:bg-[#1a2230] text-gray-400 dark:text-[#a4acb7] cursor-not-allowed'
                  }`}
                >
                  ✓ {t('pipeline.markWon')}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Main 3-column grid: info(25%) | tabs(50%) | comments(25%) */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
        {/* Left: Deal Info */}
        <div className={`${CARD} lg:col-span-1 space-y-4`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('pipeline.dealInfo')}</h3>
          <Detail label={t('pipeline.customer')} value={customer?.company_name || customer?.contact_person} />
          <Detail label={t('leadModal.pipeline')} value={pipeline?.name} />
          <Detail label={t('pipeline.expectedCloseDate')} value={deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString() : null} />
          {deal.probability != null && (
            <div>
              <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('pipeline.probability')}</div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-1.5 bg-gray-200 dark:bg-[#212a38] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 dark:bg-[#a5b4fc] rounded-full transition-all"
                    style={{ width: `${deal.probability}%` }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{deal.probability}%</span>
              </div>
            </div>
          )}

          {/* Assigned Rep — inline editable */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leads.colAssignedRep')}</div>
            {editingRep ? (
              <div className="flex items-center gap-2 mt-1">
                <select
                  value={repInput}
                  onChange={(e) => setRepInput(e.target.value)}
                  className="text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none flex-1 min-w-0"
                >
                  <option value="">{t('common.unassigned')}</option>
                  {salesReps.map((r) => (
                    <option key={r.user_email} value={r.user_email}>{r.user_email}</option>
                  ))}
                </select>
                <button onClick={handleSaveRep} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingRep(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 inline-block ${EDITABLE}`}
                onClick={canEditDeal ? () => { setRepInput(deal.assigned_rep || ''); setEditingRep(true) } : undefined}
                title={canEditDeal ? t('pipeline.clickToEdit') : undefined}
              >
                {deal.assigned_rep || '—'}
              </span>
            )}
          </div>

          <Detail label={t('common.createdAt')} value={deal.created_at ? new Date(deal.created_at).toLocaleString() : null} />
          <Detail label={t('common.createdBy')} value={deal.created_by} />
        </div>

        {/* Center: unified tab bar */}
        <div className={`${CARD} lg:col-span-2 !p-0 overflow-hidden`}>
          {/* Tab row: Add Comment | Schedule Activity | Quotation | Deal Notes */}
          <div className="flex border-b border-[#e6e9ef] dark:border-[#212a38] px-2 overflow-x-auto">
            <button onClick={() => setTab('note')} className={TAB_CLS(tab === 'note')}>
              {t('activityChatter.addComment')}
            </button>
            <button onClick={() => setTab('activity')} className={TAB_CLS(tab === 'activity')}>
              {t('activityChatter.scheduleActivity')}
            </button>
            <button onClick={() => setTab('quotation')} className={TAB_CLS(tab === 'quotation')}>
              {t('pipeline.quotationTab')}
              {/* A single QT still shows its code; several show the count instead. */}
              {hasQuotation && (
                <span className="ml-1.5 text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-[#a5b4fc] px-1.5 py-0.5 rounded-full">
                  {quotations.length === 1 ? quotations[0].qt_code : quotations.length}
                </span>
              )}
            </button>
            <button onClick={() => setTab('deal_notes')} className={TAB_CLS(tab === 'deal_notes')}>
              {t('pipeline.dealNotesTab')}
            </button>
          </div>

          <div className="p-[18px]">
            {/* Deal Log: full history, no note composer (moved to comment panel) */}
            {/* Schedule Activity: form + planned only, no history */}
            {(tab === 'note' || tab === 'activity') && (
              <ActivityChatter
                relatedType="deal"
                relatedId={deal.id}
                currentUserEmail={currentUserEmail}
                salesReps={salesReps}
                canEdit={canDo('edit') || canDo('create')}
                currentUserPermissions={currentUserPermissions}
                controlledTab={tab}
                onControlledTabChange={setTab}
                hideNoteComposer
                hideHistory={tab === 'activity'}
                currentUserRole={currentUserRole}
                onApproveActivity={handleApproveQuotation}
                onRejectActivity={handleRejectQuotation}
              />
            )}

            {/* Quotation tab — a deal can hold any number of quotations, each
                independent: its own approval, its own conversion to a Sales Order. */}
            {tab === 'quotation' && (
              <div>
                {quotationLoading ? (
                  <div className="flex justify-center py-6"><Spinner /></div>
                ) : (
                  <div className="space-y-3">
                    {canEditDeal && editingQtId === null && (
                      <div className="flex justify-end">
                        <Button size="sm" onClick={() => openQuotationEditor()}>
                          + {t('pipeline.createQuotation')}
                        </Button>
                      </div>
                    )}

                    {/* Editor for a brand-new quotation sits above the existing list */}
                    {editingQtId === '' && (
                      <div className="border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3">
                        {quotationEditorNode}
                      </div>
                    )}

                    {quotations.length === 0 && editingQtId === null && (
                      <div className="py-6 text-center">
                        <p className="text-sm text-gray-400 dark:text-[#a4acb7]">{t('pipeline.noQuotation')}</p>
                      </div>
                    )}

                    {quotations.map((qt) => {
                      const convertedSO = soByQuotationId[qt.id] ?? null
                      if (editingQtId === qt.id) {
                        return (
                          <div key={qt.id} className="border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3">
                            {quotationEditorNode}
                          </div>
                        )
                      }
                      return (
                        <div key={qt.id} className="border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded">
                                {qt.qt_code}
                              </span>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${qtStatusCls(qt.status)}`}>
                                {t(qtApprovalLabelKey(qt.status))}
                              </span>
                              {qt.archived && (
                                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#9aa4b2]">
                                  {t('salesDocuments.archivedBadge')}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-indigo-600 dark:text-[#a5b4fc]">
                                {(qt.total ?? 0).toLocaleString()} {t('pipeline.currency')}
                              </span>
                              {qt.status === 'accepted' && canApprove && (
                                <Button variant="secondary" size="sm" onClick={() => handleDownloadPDF(qt)}>
                                  {t('salesDocs.downloadPDF')}
                                </Button>
                              )}
                              {/* 'accepted' locks the QT: once approved it must not change,
                                  or the approved figures and the SO could diverge. */}
                              {canEditDeal && editingQtId === null && !['cancelled', 'expired', 'declined', 'converted', 'accepted'].includes(qt.status) && (
                                <Button variant="secondary" size="sm" onClick={() => openQuotationEditor(qt)}>
                                  {t('common.edit')}
                                </Button>
                              )}
                            </div>
                          </div>

                          {(qt.validity_until || qt.payment_terms) && (
                            <div className="flex flex-wrap gap-3 mb-3 text-xs text-gray-500 dark:text-[#9aa4b2]">
                              {qt.validity_until && (
                                <span>{t('salesDocs.validityUntil')}: {new Date(qt.validity_until).toLocaleDateString()}</span>
                              )}
                              {qt.payment_terms && (
                                <span>{t('salesDocs.paymentTerms')}: {qt.payment_terms}</span>
                              )}
                            </div>
                          )}

                          {qt.line_items.length === 0 ? (
                            <p className="text-sm text-gray-400 dark:text-[#a4acb7]">{t('pipeline.noProductLines')}</p>
                          ) : (
                            <>
                              <div className="grid grid-cols-[1fr_40px_80px_50px_50px_70px] gap-1.5 text-xs font-medium text-gray-500 dark:text-[#9aa4b2] uppercase mb-1.5 px-1">
                                <span>{t('salesDocs.lineProduct')}</span>
                                <span className="text-center">{t('salesDocs.lineQty')}</span>
                                <span className="text-right">{t('salesDocs.lineUnitPrice')}</span>
                                <span className="text-center">{t('salesDocs.lineDiscount')}</span>
                                <span className="text-center">{t('salesDocs.lineTax')}</span>
                                <span className="text-right">{t('salesDocs.lineSubtotal')}</span>
                              </div>
                              <div className="space-y-1.5">
                                {qt.line_items.map((l, i) => {
                                  const base = l.qty * l.unit_price
                                  const disc = base * ((l.discount_pct || 0) / 100)
                                  const net = base - disc
                                  const tax = net * ((l.tax_pct || 0) / 100)
                                  return (
                                    <div key={i} className="grid grid-cols-[1fr_40px_80px_50px_50px_70px] gap-1.5 items-center text-sm text-gray-700 dark:text-[#e8ebf0] px-1">
                                      <span className="truncate">{l.product_name}</span>
                                      <span className="text-center text-gray-500 dark:text-[#9aa4b2]">{l.qty}</span>
                                      <span className="text-right text-gray-500 dark:text-[#9aa4b2]">{Number(l.unit_price).toLocaleString()}</span>
                                      <span className="text-center text-gray-400 dark:text-[#a4acb7] text-xs">{l.discount_pct ? `${l.discount_pct}%` : '—'}</span>
                                      <span className="text-center text-gray-400 dark:text-[#a4acb7] text-xs">{l.tax_pct ? `${l.tax_pct}%` : '—'}</span>
                                      <span className="text-right font-medium">{(net + tax).toLocaleString()}</span>
                                    </div>
                                  )
                                })}
                              </div>
                              <div className="mt-2 pt-2 border-t border-[#e6e9ef] dark:border-[#212a38] space-y-0.5 text-xs text-gray-500 dark:text-[#9aa4b2]">
                                {qt.discount_amount > 0 && (
                                  <div className="flex justify-between">
                                    <span>{t('salesDocs.totalDiscount')}</span>
                                    <span>-{qt.discount_amount.toLocaleString()}</span>
                                  </div>
                                )}
                                {qt.tax_amount > 0 && (
                                  <div className="flex justify-between">
                                    <span>{t('salesDocs.totalTax')}</span>
                                    <span>+{qt.tax_amount.toLocaleString()}</span>
                                  </div>
                                )}
                                <div className="flex justify-between pt-1 text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
                                  <span>{t('salesDocs.grandTotal')}</span>
                                  <span className="text-indigo-600 dark:text-[#a5b4fc]">{(qt.total ?? 0).toLocaleString()} {t('pipeline.currency')}</span>
                                </div>
                              </div>
                            </>
                          )}

                          {qt.notes && (
                            <div className="mt-3 pt-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
                              <p className="text-xs font-medium text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide mb-1">
                                {t('pipeline.quotationNotes')}
                              </p>
                              <p className="text-sm text-gray-700 dark:text-[#e8ebf0] whitespace-pre-wrap leading-relaxed">
                                {qt.notes}
                              </p>
                            </div>
                          )}

                          {qt.status !== 'expired' && (
                            <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
                              {qt.status === 'converted' ? (
                                // Locked — this QT became an SO. Navigation only.
                                <>
                                  {convertedSO && (
                                    <button
                                      onClick={() => navigate(`/sales/sales_order/${convertedSO.id}`)}
                                      className="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-[#a5b4fc] hover:underline"
                                    >
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                                      </svg>
                                      {t('salesDocuments.qtViewSO')}: <span className="font-mono ml-0.5">{convertedSO.so_code}</span>
                                    </button>
                                  )}
                                  {/* No PDF button here: handleDownloadPDF emits the QUOTATION pdf,
                                      which is the wrong document once the QT is converted. Use the
                                      "View SO" link above and export the SO from its own page. */}
                                </>
                              ) : (
                                <>
                                  {qt.status === 'draft' && canEditDeal && (
                                    <Button variant="secondary" size="sm" onClick={() => handleQuotationStatus('markSent', qt)}>
                                      {t('pipeline.sendForApproval')}
                                    </Button>
                                  )}
                                  {qt.status === 'sent' && (
                                    <span className="text-xs text-gray-500 dark:text-[#9aa4b2] self-center italic">
                                      {t('pipeline.qtAwaitingApproval')}
                                    </span>
                                  )}
                                  {canEditDeal && (
                                    <Button variant="secondary" size="sm" onClick={() => handleToggleArchiveQuotation(qt)}>
                                      {t(qt.archived ? 'salesDocuments.restore' : 'salesDocuments.archive')}
                                    </Button>
                                  )}
                                  {qt.status === 'accepted' && (
                                    <Button size="sm" onClick={() => handleConvertToSO(qt)} loading={convertingSOId === qt.id}>
                                      {t('salesDocs.convertToSO')}
                                    </Button>
                                  )}
                                  {['cancelled', 'declined'].includes(qt.status) && canEditDeal && (
                                    <Button variant="secondary" size="sm" onClick={() => handleReopenForApproval(qt)}>
                                      {t('pipeline.reopenForApproval')}
                                    </Button>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Deal Notes tab */}
            {tab === 'deal_notes' && (
              <div className="space-y-3">
                <textarea
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  placeholder={t('pipeline.dealNotesPlaceholder')}
                  rows={10}
                  className="w-full px-3 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-xl text-sm bg-[#f8f9fb] dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#a4acb7] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSaveNotes} loading={savingNotes} disabled={!canEditDeal}>
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: comment panel — same 1-col width as Deal Info */}
        <div className="lg:col-span-1 h-full">
          <CommentPanel
            relatedType="deal"
            relatedId={deal.id}
            currentUserEmail={currentUserEmail}
            canEdit={canDo('edit') || canDo('create')}
          />
        </div>
      </div>

      {showEdit && (
        <CreateDealModal
          form={dealForm}
          setForm={setDealForm}
          customers={customers}
          contacts={dealContacts}
          pipeline={pipeline}
          pipelines={pipelines}
          salesReps={salesReps}
          editing={deal}
          hasProductLines={hasQuotation}
          onSave={handleSaveEdit}
          onClose={() => setShowEdit(false)}
        />
      )}

      {showLost && (
        <MarkLostModal
          deal={deal}
          form={lostForm}
          setForm={setLostForm}
          onConfirm={handleConfirmLost}
          onClose={() => setShowLost(false)}
        />
      )}

      {showReopen && (
        <ReopenDealModal
          deal={deal}
          stages={stages}
          onConfirm={handleReopen}
          onClose={() => setShowReopen(false)}
        />
      )}
    </div>
  )
}
