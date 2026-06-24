import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { Button, Input } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { ActivityChatter } from '../../components/ActivityChatter'
import { EMPTY_DEAL_FORM, EMPTY_LOST_FORM } from './_constants'
import { CreateDealModal, MarkLostModal } from './_modals'
import { ProductSearchInput } from './_shared'

const CARD = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]'

function Detail({ label, value }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase">{label}</div>
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
  const salesReps = usersList.filter((u) => u.role === 'sales_rep' || u.role === 'manager')
  const customer = useMemo(() => customers.find((c) => c.id === deal?.customer_id), [customers, deal])
  const pipeline = useMemo(() => pipelines.find((p) => p.id === deal?.pipeline_id), [pipelines, deal])
  const stages = pipeline ? [...pipeline.stages].sort((a, b) => a.order - b.order) : []

  const [showEdit, setShowEdit] = useState(false)
  const [dealForm, setDealForm] = useState(EMPTY_DEAL_FORM)
  const [showLost, setShowLost] = useState(false)
  const [lostForm, setLostForm] = useState(EMPTY_LOST_FORM)
  const [lines, setLines] = useState([])
  const [savingLines, setSavingLines] = useState(false)

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.deals?.[action] === true
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
    try {
      await db.deals.update(deal.id, {
        title: dealForm.title.trim(),
        value: dealForm.value ? Number(dealForm.value) : null,
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
      await db.deals.update(deal.id, { product_lines: cleaned })
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

  const editingLines = lines.length > 0
  const lineItems = editingLines ? lines : deal.product_lines
  const linesTotal = lineItems.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0)

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="text-sm text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 flex items-center gap-1">
          ← {t('common.back')}
        </button>
        <div className="flex items-center gap-2">
          {canEditDeal && (
            <Button variant="secondary" size="sm" onClick={handleOpenEdit}>
              {t('common.edit')}
            </Button>
          )}
          {!isClosed && canDo('edit') && (
            <Button variant="danger" size="sm" onClick={() => setShowLost(true)}>
              {t('pipeline.markLost')}
            </Button>
          )}
          {!isClosed && canDo('edit') && (
            <Button variant="success" size="sm" onClick={handleMarkWon}>
              {t('pipeline.markWon')}
            </Button>
          )}
        </div>
      </div>

      <div className={`${CARD} mb-4`}>
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-[#e8ebf0]">{deal.title}</h1>
            <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">
              {customer?.company_name || customer?.contact_person || '—'}
              {deal.value != null && ` · ${Number(deal.value).toLocaleString()} ${t('pipeline.currency')}`}
            </p>
          </div>
          {deal.status === 'won' && (
            <span className="px-3 py-1 text-sm rounded-full font-medium bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400">
              {t('pipeline.won')}
            </span>
          )}
          {deal.status === 'lost' && (
            <span className="px-3 py-1 text-sm rounded-full font-medium bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400">
              {t('pipeline.lost')}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          {isClosed ? (
            <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
              {deal.status === 'lost' && deal.lost_reason ? `${t('pipeline.lostReason')}: ${deal.lost_reason}` : t('pipeline.dealClosed')}
            </span>
          ) : (
            stages
              .filter((s) => !s.is_won && !s.is_lost)
              .map((s) => {
                const active = deal.stage === s.id
                return (
                  <button
                    key={s.id}
                    disabled={!canDo('edit') || active}
                    onClick={() => handleStageChange(s.id)}
                    className={`px-3 py-1 text-xs rounded-full font-medium transition-all ${
                      active
                        ? 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400 ring-2 ring-offset-1 ring-indigo-400 dark:ring-offset-[#121823]'
                        : `bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] opacity-50 hover:opacity-100 ${canDo('edit') ? 'cursor-pointer' : 'cursor-default'}`
                    }`}
                  >
                    {s.name}
                  </button>
                )
              })
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`${CARD} lg:col-span-1 space-y-4`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('pipeline.dealInfo')}</h3>
          <Detail label={t('pipeline.customer')} value={customer?.company_name || customer?.contact_person} />
          <Detail label={t('leadModal.pipeline')} value={pipeline?.name} />
          <Detail label={t('pipeline.expectedCloseDate')} value={deal.expected_close_date ? new Date(deal.expected_close_date).toLocaleDateString() : null} />
          <Detail label={t('leads.colAssignedRep')} value={deal.assigned_rep} />
          <Detail label={t('common.createdAt')} value={deal.created_at ? new Date(deal.created_at).toLocaleString() : null} />
          <Detail label={t('common.createdBy')} value={deal.created_by} />
          {deal.notes && (
            <div>
              <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase">{t('common.notes')}</div>
              <p className="text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 whitespace-pre-wrap">{deal.notes}</p>
            </div>
          )}

          {/* Product lines */}
          <div className="pt-2 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold uppercase text-gray-500 dark:text-[#9aa4b2]">{t('pipeline.productLines')}</h4>
              {!editingLines && canEditDeal && (
                <button onClick={openLinesEditor} className="text-xs text-indigo-600 dark:text-[#a5b4fc] hover:underline">
                  {t('common.edit')}
                </button>
              )}
            </div>
            {lineItems.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-[#4a5568]">{t('pipeline.noProductLines')}</p>
            ) : (
              <div className="space-y-2">
                {lineItems.map((l, i) =>
                  editingLines ? (
                    <div key={i} className="flex items-center gap-1">
                      <ProductSearchInput
                        value={l.product_name}
                        onChange={(text) => updateLine(i, 'product_name', text)}
                        onSelectProduct={(p) => selectLineProduct(i, p)}
                        products={products}
                        placeholder={t('pipeline.lineProductPlaceholder')}
                        className="flex-1"
                        inputClassName="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none text-xs bg-white placeholder-gray-400 transition-colors"
                      />
                      <Input type="number" min="1" value={l.qty} onChange={(e) => updateLine(i, 'qty', e.target.value)} className="text-xs w-14" />
                      <Input type="number" min="0" value={l.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} className="text-xs w-20" />
                      <button onClick={() => removeLine(i)} className="text-red-500 text-xs px-1">×</button>
                    </div>
                  ) : (
                    <div key={i} className="flex items-center justify-between text-xs text-gray-700 dark:text-[#e8ebf0]">
                      <span>{l.product_name} × {l.qty}</span>
                      <span>{(l.qty * l.unit_price).toLocaleString()}</span>
                    </div>
                  )
                )}
              </div>
            )}
            {editingLines && (
              <div className="flex items-center justify-between mt-2">
                <button onClick={addLine} className="text-xs text-indigo-600 dark:text-[#a5b4fc] hover:underline">
                  + {t('pipeline.addLine')}
                </button>
                <Button size="sm" onClick={saveLines} loading={savingLines}>
                  {t('common.save')}
                </Button>
              </div>
            )}
            {lineItems.length > 0 && (
              <p className="text-xs font-medium text-gray-900 dark:text-[#e8ebf0] mt-2">
                {t('common.total')}: {linesTotal.toLocaleString()} {t('pipeline.currency')}
              </p>
            )}
          </div>
        </div>

        <div className={`${CARD} lg:col-span-2`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] mb-3">{t('pipeline.activity')}</h3>
          <ActivityChatter
            relatedType="deal"
            relatedId={deal.id}
            currentUserEmail={currentUserEmail}
            salesReps={salesReps}
            canEdit={canDo('edit') || canDo('create')}
          />
        </div>
      </div>

      {showEdit && (
        <CreateDealModal
          form={dealForm}
          setForm={setDealForm}
          customers={customers}
          pipelines={pipelines}
          salesReps={salesReps}
          editing={deal}
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
    </div>
  )
}
