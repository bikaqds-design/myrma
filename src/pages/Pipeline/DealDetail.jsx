import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { Button, Input } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { ActivityChatter } from '../../components/ActivityChatter'
import { CommentPanel } from '../../components/CommentPanel'
import { EMPTY_DEAL_FORM, EMPTY_LOST_FORM } from './_constants'
import { CreateDealModal, MarkLostModal, ReopenDealModal } from './_modals'
import { ProductSearchInput } from './_shared'

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
  if (prob >= 25) return 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400'
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

const EMPTY_LINE = { product_name: '', qty: 1, unit_price: 0 }

export default function DealDetail({ dealId, currentUserRole, currentUserEmail, currentUserPermissions, onBack }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: deal, isLoading, isError } = useQuery({
    queryKey: ['deal', dealId],
    queryFn: () => db.deals.get(dealId),
    enabled: !!dealId,
  })
  const { data: pipelines = [] } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
  })
  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => db.customers.list(),
    staleTime: 60_000,
  })
  const { data: usersList = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.listAllRoles(),
    staleTime: 5 * 60_000,
  })
  const { data: products = [] } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 60_000,
  })
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

  // Unified tab for right panel: 'note' | 'activity' | 'lines' | 'deal_notes'
  const [tab, setTab] = useState('note')

  // Product lines editor state
  const [lines, setLines] = useState([])
  const [savingLines, setSavingLines] = useState(false)

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

  const saveField = async (field, value) => {
    try {
      await db.deals.update(deal.id, { [field]: value })
      toast.success(t('pipeline.dealUpdated'))
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
    saveField('customer_id', c.id)
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

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['deal', dealId] })
    queryClient.invalidateQueries({ queryKey: ['deals'] })
    queryClient.invalidateQueries({ queryKey: ['activities', 'deal', dealId] })
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
    if (!dealForm.title.trim()) {
      toast.error(t('pipeline.createDealValidation'))
      return
    }
    const hasLines = deal.product_lines.length > 0
    try {
      await db.deals.update(deal.id, {
        title: dealForm.title.trim(),
        value: hasLines ? deal.value : (dealForm.value ? Number(dealForm.value) : null),
        probability: Number(dealForm.probability ?? 0),
        expected_close_date: dealForm.expected_close_date || null,
        assigned_rep: dealForm.assigned_rep || null,
        notes: dealForm.notes || null,
      })
      toast.success(t('pipeline.dealUpdated'))
      setShowEdit(false)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleMarkWon = async () => {
    try {
      await db.deals.markWon(deal.id, currentUserEmail)
      toast.success(t('pipeline.dealMarkedWon'))
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleReopen = async (stageId) => {
    try {
      await db.deals.reopen(deal.id, stageId, currentUserEmail)
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

  const openLinesEditor = () => setLines(deal.product_lines.length > 0 ? deal.product_lines : [{ ...EMPTY_LINE }])
  const updateLine = (i, field, value) => setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)))
  const selectLineProduct = (i, product) =>
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, product_id: product.id, product_name: product.product_name } : l)))
  const addLine = () => setLines((prev) => [...prev, { ...EMPTY_LINE }])
  const removeLine = (i) => setLines((prev) => prev.filter((_, idx) => idx !== i))
  const saveLines = async () => {
    setSavingLines(true)
    try {
      const cleaned = lines
        .filter((l) => l.product_name.trim())
        .map((l) => ({ product_id: l.product_id || '', product_name: l.product_name.trim(), qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0 }))
      const linesValue = cleaned.reduce((s, l) => s + l.qty * l.unit_price, 0)
      await db.deals.update(deal.id, { product_lines: cleaned, value: linesValue || null })
      toast.success(t('pipeline.dealUpdated'))
      setLines([])
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    } finally {
      setSavingLines(false)
    }
  }

  if (isLoading) return <PageSkeleton />
  if (isError || !deal) {
    return (
      <div className="p-6">
        <EmptyState title={t('pipeline.dealNotFound')} description="" action={onBack} actionLabel={t('common.back')} />
      </div>
    )
  }

  const hasProductLines = deal.product_lines.length > 0
  const editingLines = lines.length > 0
  const lineItems = editingLines ? lines : deal.product_lines
  const linesTotal = lineItems.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0)
  const displayValue = hasProductLines ? deal.product_lines.reduce((s, l) => s + (l.qty || 0) * (l.unit_price || 0), 0) : Number(deal.value || 0)

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
                      <span className="text-xs text-gray-400 dark:text-[#4a5568] ml-1">· {c.contact_person}</span>
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
                  className={`text-xl font-bold text-gray-900 dark:text-[#e8ebf0] ${!hasProductLines ? EDITABLE : ''}`}
                  onClick={!hasProductLines && canEditDeal ? () => { setValueInput(String(deal.value ?? '')); setEditingValue(true) } : undefined}
                  title={!hasProductLines && canEditDeal ? t('pipeline.clickToEdit') : undefined}
                >
                  {displayValue > 0 ? `${displayValue.toLocaleString()} ${t('pipeline.currency')}` : `— ${t('pipeline.currency')}`}
                </span>
                {hasProductLines && (
                  <span className="text-xs text-gray-400 dark:text-[#4a5568]">({t('pipeline.valueLocked')})</span>
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
            <span className="px-3 py-0.5 text-sm rounded-full font-medium bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400">
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
                  className="px-3 py-1 text-xs rounded-full font-medium bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/40 transition-colors"
                >
                  ✗ {t('pipeline.markLost')}
                </button>
              )}
              {canDo('edit') && (
                <button
                  onClick={handleMarkWon}
                  className="px-3 py-1 text-xs rounded-full font-medium bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/40 transition-colors"
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
          {/* Tab row: Add Comment | Schedule Activity | Product Lines | Deal Notes */}
          <div className="flex border-b border-[#e6e9ef] dark:border-[#212a38] px-2 overflow-x-auto">
            <button onClick={() => setTab('note')} className={TAB_CLS(tab === 'note')}>
              {t('activityChatter.addComment')}
            </button>
            <button onClick={() => setTab('activity')} className={TAB_CLS(tab === 'activity')}>
              {t('activityChatter.scheduleActivity')}
            </button>
            <button onClick={() => setTab('lines')} className={TAB_CLS(tab === 'lines')}>
              {t('pipeline.productLinesTab')}
              {deal.product_lines.length > 0 && (
                <span className="ml-1.5 text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-[#a5b4fc] px-1.5 py-0.5 rounded-full">
                  {deal.product_lines.length}
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
                controlledTab={tab}
                onControlledTabChange={setTab}
                hideNoteComposer
                hideHistory={tab === 'activity'}
              />
            )}

            {/* Product lines tab */}
            {tab === 'lines' && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('pipeline.productLines')}</h4>
                  {!editingLines && canEditDeal && (
                    <Button variant="secondary" size="sm" onClick={openLinesEditor}>
                      {lineItems.length === 0 ? `+ ${t('pipeline.addLine')}` : t('common.edit')}
                    </Button>
                  )}
                </div>

                {lineItems.length === 0 && !editingLines ? (
                  <p className="text-sm text-gray-400 dark:text-[#4a5568]">{t('pipeline.noProductLines')}</p>
                ) : (
                  <>
                    {/* Column headers */}
                    {(editingLines || lineItems.length > 0) && (
                      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-xs font-medium text-gray-500 dark:text-[#9aa4b2] uppercase mb-2 px-1">
                        <span>{t('pipeline.lineProduct')}</span>
                        <span className="w-14 text-center">{t('pipeline.lineQty')}</span>
                        <span className="w-24 text-center">{t('pipeline.lineUnitPrice')}</span>
                        <span className="w-24 text-right">{t('pipeline.lineSubtotal')}</span>
                      </div>
                    )}

                    <div className="space-y-2">
                      {lineItems.map((l, i) =>
                        editingLines ? (
                          <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
                            <ProductSearchInput
                              value={l.product_name}
                              onChange={(text) => updateLine(i, 'product_name', text)}
                              onSelectProduct={(p) => selectLineProduct(i, p)}
                              products={products}
                              placeholder={t('pipeline.lineProductPlaceholder')}
                              className="flex-1"
                              inputClassName="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-sm bg-white placeholder-gray-400 transition-colors"
                            />
                            <Input type="number" min="1" value={l.qty} onChange={(e) => updateLine(i, 'qty', e.target.value)} className="w-14 text-sm text-center" />
                            <Input type="number" min="0" value={l.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} className="w-24 text-sm" />
                            <button onClick={() => removeLine(i)} className="w-6 h-6 flex items-center justify-center text-red-400 hover:text-red-600 text-base">×</button>
                          </div>
                        ) : (
                          <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center text-sm text-gray-700 dark:text-[#e8ebf0] px-1">
                            <span className="truncate">{l.product_name}</span>
                            <span className="w-14 text-center text-gray-500 dark:text-[#9aa4b2]">× {l.qty}</span>
                            <span className="w-24 text-center text-gray-500 dark:text-[#9aa4b2]">{Number(l.unit_price).toLocaleString()}</span>
                            <span className="w-24 text-right font-medium">{(l.qty * l.unit_price).toLocaleString()}</span>
                          </div>
                        )
                      )}
                    </div>

                    {editingLines && (
                      <div className="flex items-center gap-3 mt-3 pt-2 border-t border-[#e6e9ef] dark:border-[#212a38]">
                        <button onClick={addLine} className="text-sm text-indigo-600 dark:text-[#a5b4fc] hover:underline">
                          + {t('pipeline.addLine')}
                        </button>
                        <div className="ml-auto flex gap-2">
                          <Button variant="secondary" size="sm" onClick={() => setLines([])}>
                            {t('common.cancel')}
                          </Button>
                          <Button size="sm" onClick={saveLines} loading={savingLines}>
                            {t('common.save')}
                          </Button>
                        </div>
                      </div>
                    )}

                    {lineItems.length > 0 && (
                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-[#e6e9ef] dark:border-[#212a38]">
                        <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('common.total')}</span>
                        <span className="text-sm font-bold text-indigo-600 dark:text-[#a5b4fc]">
                          {linesTotal.toLocaleString()} {t('pipeline.currency')}
                        </span>
                      </div>
                    )}
                  </>
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
                  className="w-full px-3 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-xl text-sm bg-[#f8f9fb] dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#4a5568] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
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
          pipeline={pipeline}
          salesReps={salesReps}
          editing={deal}
          hasProductLines={hasProductLines}
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
