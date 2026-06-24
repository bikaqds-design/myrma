import React, { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader, Button } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { DEAL_ROTTING_THRESHOLD_DAYS } from '../../lib/constants'
import { EMPTY_DEAL_FORM, EMPTY_LOST_FORM } from './_constants'
import { CreateDealModal, MarkLostModal } from './_modals'

const ROTTING_MS = DEAL_ROTTING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000

function isRotting(deal) {
  if (!deal.updated_at) return false
  return Date.now() - new Date(deal.updated_at).getTime() > ROTTING_MS
}

// Worst-case rollup across a deal's open activities — overdue beats today
// beats planned beats none. Mirrors Odoo's mail.activity_mixin precedence.
function dealActivityState(dealActivities) {
  let state = null
  const now = Date.now()
  const todayEnd = new Date().setHours(23, 59, 59, 999)
  for (const a of dealActivities) {
    if (!a.due_date) continue
    const due = new Date(a.due_date).getTime()
    if (due < now) return 'overdue'
    if (due <= todayEnd) state = state === 'overdue' ? state : 'today'
    else if (!state) state = 'planned'
  }
  return state
}

function nextDue(dealActivities) {
  const withDue = dealActivities.filter((a) => a.due_date).sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
  return withDue[0]?.due_date ?? null
}

function initials(email) {
  if (!email) return '?'
  return email[0].toUpperCase()
}

const REP_COLORS = ['bg-indigo-500', 'bg-teal-500', 'bg-amber-500', 'bg-pink-500', 'bg-sky-500', 'bg-emerald-500']
function repColor(email) {
  if (!email) return 'bg-gray-400'
  let hash = 0
  for (let i = 0; i < email.length; i++) hash = (hash * 31 + email.charCodeAt(i)) >>> 0
  return REP_COLORS[hash % REP_COLORS.length]
}

export default function Pipeline({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: pipelines = [], isLoading: pipelinesLoading } = useQuery({
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
  const salesReps = usersList.filter((u) => u.role === 'sales_rep' || u.role === 'manager')
  const customerMap = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers])

  const [activePipelineId, setActivePipelineId] = useState(null)
  const pipelineId = activePipelineId || pipelines[0]?.id

  // Deliberately not filtered to status:'open' — Won/Lost deals must still
  // render in their own terminal columns (the Won/Lost columns exist
  // specifically to hold them), not vanish from the board.
  const { data: deals = [], isLoading: dealsLoading } = useQuery({
    queryKey: ['deals', pipelineId],
    queryFn: () => db.deals.list({ pipelineId }),
    enabled: !!pipelineId,
  })

  const dealIds = useMemo(() => deals.map((d) => d.id), [deals])
  const { data: openActivities = [] } = useQuery({
    queryKey: ['activities', 'deal', 'bulk', dealIds],
    queryFn: () => db.activities.listForRelated('deal', dealIds),
    enabled: dealIds.length > 0,
  })
  const activitiesByDeal = useMemo(() => {
    const map = {}
    for (const a of openActivities) {
      if (!map[a.related_id]) map[a.related_id] = []
      map[a.related_id].push(a)
    }
    return map
  }, [openActivities])

  const [showCreate, setShowCreate] = useState(false)
  const [dealForm, setDealForm] = useState(EMPTY_DEAL_FORM)
  const [losingDeal, setLosingDeal] = useState(null)
  const [lostForm, setLostForm] = useState(EMPTY_LOST_FORM)

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.deals?.[action] === true
  }

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['deals'] })
  }

  const activePipeline = pipelines.find((p) => p.id === pipelineId)
  const stages = activePipeline ? [...activePipeline.stages].sort((a, b) => a.order - b.order) : []

  const dealsByStage = {}
  for (const s of stages) dealsByStage[s.id] = []
  for (const d of deals) {
    if (dealsByStage[d.stage]) dealsByStage[d.stage].push(d)
  }

  const handleOpenCreate = () => {
    const firstStage = stages[0]
    setDealForm({ ...EMPTY_DEAL_FORM, pipeline_id: pipelineId, stage: firstStage ? firstStage.id : '' })
    setShowCreate(true)
  }

  const handleSaveDeal = async () => {
    if (!dealForm.title.trim() || !dealForm.customer_id || !dealForm.pipeline_id || !dealForm.stage) {
      toast.error(t('pipeline.createDealValidation'))
      return
    }
    try {
      await db.deals.create({
        title: dealForm.title.trim(),
        customer_id: dealForm.customer_id,
        contact_id: null,
        pipeline_id: dealForm.pipeline_id,
        stage: dealForm.stage,
        value: dealForm.value ? Number(dealForm.value) : null,
        probability: 0,
        expected_close_date: dealForm.expected_close_date || null,
        assigned_rep: dealForm.assigned_rep || null,
        product_lines: [],
        lost_reason: null,
        notes: dealForm.notes || null,
        created_by: currentUserEmail,
        updated_at: null,
      })
      toast.success(t('pipeline.dealCreated'))
      setShowCreate(false)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleConfirmLost = async () => {
    if (!lostForm.reason.trim() || !losingDeal) return
    try {
      await db.deals.markLost(losingDeal.id, lostForm.reason.trim(), currentUserEmail)
      toast.success(t('pipeline.dealMarkedLost'))
      setLosingDeal(null)
      setLostForm(EMPTY_LOST_FORM)
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    }
  }

  const handleDragEnd = async (result) => {
    const { source, destination, draggableId } = result
    if (!destination || destination.droppableId === source.droppableId) return
    const destStage = stages.find((s) => s.id === destination.droppableId)
    const deal = deals.find((d) => d.id === draggableId)
    // Closed deals are not draggable (isDragDisabled below), but guard here too.
    if (!destStage || !deal || deal.status !== 'open') return

    if (destStage.is_lost) {
      setLosingDeal(deal)
      setLostForm(EMPTY_LOST_FORM)
      return
    }

    // Optimistic move so the card doesn't snap back while the request is in
    // flight — update in place rather than removing, since Won deals must
    // stay visible (now in the Won column), not disappear from the board.
    queryClient.setQueryData(['deals', pipelineId], (prev = []) =>
      prev.map((d) => (d.id === draggableId ? { ...d, stage: destStage.id, status: destStage.is_won ? 'won' : d.status } : d))
    )

    try {
      if (destStage.is_won) {
        await db.deals.markWon(draggableId, currentUserEmail)
        toast.success(t('pipeline.dealMarkedWon'))
      } else {
        await db.deals.moveStage(draggableId, destStage.id, currentUserEmail)
      }
      refresh()
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
      refresh()
    }
  }

  if (pipelinesLoading) return <PageSkeleton />

  return (
    <div className="p-4 lg:p-6">
      <PageHeader title={t('pipeline.title')} subtitle={t('pipeline.subtitle')}>
        {canDo('create') && <Button onClick={handleOpenCreate}>{t('pipeline.createDeal')}</Button>}
      </PageHeader>

      {/* Pipeline tabs */}
      <div className="flex gap-2 mt-4 mb-4 border-b border-gray-200 dark:border-[#212a38]">
        {pipelines.map((p) => (
          <button
            key={p.id}
            onClick={() => setActivePipelineId(p.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              p.id === pipelineId
                ? 'border-indigo-600 text-indigo-600 dark:border-[#a5b4fc] dark:text-[#a5b4fc]'
                : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:hover:text-[#e8ebf0]'
            }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      {dealsLoading ? (
        <PageSkeleton />
      ) : stages.length === 0 ? (
        <EmptyState title={t('pipeline.noStages')} description={t('pipeline.noStagesHint')} />
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          {/* Grid, not flex+overflow-x-auto: columns share the available width and
              shrink to fit (minmax(0, 1fr)) so every stage is visible on one screen
              with no horizontal scrollbar, instead of fixed-width scrolling columns. */}
          <div className="grid gap-3 pb-4" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
            {stages.map((stage) => {
              const stageDeals = dealsByStage[stage.id] || []
              const totalValue = stageDeals.reduce((sum, d) => sum + (Number(d.value) || 0), 0)
              const buckets = { overdue: 0, today: 0, planned: 0 }
              for (const d of stageDeals) {
                const state = dealActivityState(activitiesByDeal[d.id] || [])
                if (state) buckets[state] += Number(d.value) || 0
              }
              const pct = (n) => (totalValue > 0 ? (n / totalValue) * 100 : 0)

              return (
                <div key={stage.id} className="min-w-0">
                  <div className="flex items-center justify-between mb-2 px-1">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] truncate" title={stage.name}>
                      {stage.name} <span className="text-gray-400 dark:text-[#4a5568] font-normal">({stageDeals.length})</span>
                    </h3>
                  </div>

                  {totalValue > 0 && (
                    <div className="flex h-1.5 rounded-full overflow-hidden mb-2 bg-gray-100 dark:bg-[#0f1520]">
                      {buckets.overdue > 0 && <div className="bg-red-500" style={{ width: `${pct(buckets.overdue)}%` }} />}
                      {buckets.today > 0 && <div className="bg-amber-500" style={{ width: `${pct(buckets.today)}%` }} />}
                      {buckets.planned > 0 && <div className="bg-emerald-500" style={{ width: `${pct(buckets.planned)}%` }} />}
                    </div>
                  )}

                  <Droppable droppableId={stage.id}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`space-y-2 min-h-[120px] rounded-lg p-1 transition-colors ${
                          snapshot.isDraggingOver ? 'bg-indigo-50 dark:bg-indigo-900/10' : ''
                        } ${stage.is_won ? 'border border-dashed border-green-300 dark:border-green-900/40' : ''} ${
                          stage.is_lost ? 'border border-dashed border-red-300 dark:border-red-900/40' : ''
                        }`}
                      >
                        {stageDeals.map((deal, index) => {
                          const customer = customerMap[deal.customer_id]
                          const dealActs = activitiesByDeal[deal.id] || []
                          const state = dealActivityState(dealActs)
                          const due = nextDue(dealActs)
                          const rotting = isRotting(deal)
                          const closed = deal.status !== 'open'
                          return (
                            <Draggable key={deal.id} draggableId={deal.id} index={index} isDragDisabled={closed}>
                              {(dragProvided, dragSnapshot) => (
                                <div
                                  ref={dragProvided.innerRef}
                                  {...dragProvided.draggableProps}
                                  {...dragProvided.dragHandleProps}
                                  onClick={() => navigate(`/pipeline/${deal.id}`)}
                                  className={`bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-xl p-3 cursor-pointer hover:shadow-md transition-shadow ${
                                    dragSnapshot.isDragging ? 'shadow-lg' : ''
                                  } ${closed ? 'opacity-70' : ''}`}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <p className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] line-clamp-2">{deal.title}</p>
                                    {rotting && !closed && (
                                      <span title={t('pipeline.rotting')} className="text-amber-500 flex-shrink-0">
                                        🥀
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5 truncate">
                                    {customer?.company_name || customer?.contact_person || '—'}
                                  </p>
                                  {deal.value != null && (
                                    <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] mt-1">
                                      {Number(deal.value).toLocaleString()} {t('pipeline.currency')}
                                    </p>
                                  )}
                                  <div className="flex items-center justify-between mt-2">
                                    <div>
                                      {due && (
                                        <span
                                          className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                                            state === 'overdue'
                                              ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                                              : state === 'today'
                                                ? 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                                                : 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'
                                          }`}
                                        >
                                          {new Date(due).toLocaleDateString()}
                                        </span>
                                      )}
                                    </div>
                                    {deal.assigned_rep && (
                                      <span
                                        title={deal.assigned_rep}
                                        className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 ${repColor(deal.assigned_rep)}`}
                                      >
                                        {initials(deal.assigned_rep)}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </Draggable>
                          )
                        })}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </div>
              )
            })}
          </div>
        </DragDropContext>
      )}

      {showCreate && (
        <CreateDealModal
          form={dealForm}
          setForm={setDealForm}
          customers={customers}
          pipelines={pipelines}
          salesReps={salesReps}
          onSave={handleSaveDeal}
          onClose={() => setShowCreate(false)}
        />
      )}

      {losingDeal && (
        <MarkLostModal
          deal={losingDeal}
          form={lostForm}
          setForm={setLostForm}
          onConfirm={handleConfirmLost}
          onClose={() => setLosingDeal(null)}
        />
      )}
    </div>
  )
}
