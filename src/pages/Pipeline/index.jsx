import React, { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueries, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ownershipScope } from '../../lib/permissions'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import { db } from '../../api/supabaseClient'
import { useDebouncedValue } from '../../lib/useDebouncedValue'
import { safeStorage } from '../../lib/safeStorage'
import { stageTotals, stageActivityValues, activityTypeStats } from '../../lib/pipelineBuckets'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader, Button } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import { DEAL_ROTTING_THRESHOLD_DAYS, ACTIVITY_TYPE_SCHEDULABLE } from '../../lib/constants'
import { useURLTab } from '../../hooks/useURLTab'
import { EMPTY_DEAL_FORM, EMPTY_LOST_FORM } from './_constants'
import { CreateDealModal, MarkLostModal } from './_modals'
import PipelineListView from './PipelineListView'
import PipelineGraphView from './PipelineGraphView'
import PipelinePivotView from './PipelinePivotView'
import PipelineActivityView from './PipelineActivityView'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

/** Cards each Kanban column shows before "Show more". */
const KANBAN_PAGE = 50

// ─── XLSX Export ──────────────────────────────────────────────────────────────

// `deals` are rows from v_deals_list, loaded when the export is chosen, so they
// carry the customer's name; the export no longer depends on which customers
// happen to be loaded for the screen. (BUG-066.)
function exportDealsXlsx(deals, stages, t, label = 'pipeline-deals') {
  if (!deals.length) {
    toast(t('pipeline.exportEmpty'))
    return
  }

  const ROTTING_MS = DEAL_ROTTING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  const stageNameMap = Object.fromEntries(stages.map((s) => [s.id, s.name]))

  const HEADERS = [
    t('pipeline.exportColStage'),
    t('pipeline.exportColTitle'),
    t('pipeline.exportColCompany'),
    t('pipeline.exportColValue'),
    t('pipeline.exportColStatus'),
    t('pipeline.exportColProbability'),
    t('pipeline.exportColRep'),
    t('pipeline.exportColCloseDate'),
    t('pipeline.exportColRotting'),
    t('pipeline.exportColWonLostDate'),
    t('pipeline.exportColLostReason'),
    t('pipeline.exportColCreatedAt'),
    t('pipeline.exportColCreatedBy'),
    t('pipeline.exportColNotes'),
  ]

  // Build deal rows in stage order
  const dataRows = []
  for (const stage of stages) {
    for (const deal of deals.filter((d) => d.stage === stage.id)) {
      const rotting =
        deal.status === 'open' && deal.updated_at
          ? Date.now() - new Date(deal.updated_at).getTime() > ROTTING_MS
          : false
      const wonLostDate = deal.won_at
        ? new Date(deal.won_at).toLocaleDateString()
        : deal.lost_at
          ? new Date(deal.lost_at).toLocaleDateString()
          : ''
      dataRows.push([
        stageNameMap[deal.stage] || deal.stage,
        deal.title,
        deal.customer_name || '',
        Number(deal.value) || 0,
        deal.status,
        deal.probability ?? 0,
        deal.assigned_rep || '',
        deal.expected_close_date
          ? new Date(deal.expected_close_date).toLocaleDateString()
          : '',
        rotting ? t('common.yes') : t('common.no'),
        wonLostDate,
        deal.lost_reason || '',
        deal.created_at ? new Date(deal.created_at).toLocaleDateString() : '',
        deal.created_by || '',
        deal.notes || '',
      ])
    }
  }

  const aoa = [HEADERS, ...dataRows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  // Bold header row + AutoFilter (the dropdown arrows on every column)
  HEADERS.forEach((_, ci) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c: ci })
    if (ws[addr]) ws[addr].s = { font: { bold: true } }
  })
  ws['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(HEADERS.length - 1)}1` }

  // Column widths
  ws['!cols'] = [
    { wch: 20 }, { wch: 40 }, { wch: 28 }, { wch: 16 },
    { wch: 10 }, { wch: 14 }, { wch: 28 }, { wch: 16 },
    { wch: 10 }, { wch: 16 }, { wch: 30 }, { wch: 14 },
    { wch: 28 }, { wch: 40 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, t('pipeline.title'))
  XLSX.writeFile(wb, `${label}-${new Date().toISOString().slice(0, 10)}.xlsx`)
  toast.success(t('pipeline.exportSuccess', { count: dataRows.length }))
}

const ROTTING_MS = DEAL_ROTTING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000

function isRotting(deal) {
  if (!deal.updated_at) return false
  return Date.now() - new Date(deal.updated_at).getTime() > ROTTING_MS
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

// ─── View-switcher icons ─────────────────────────────────────────────────────

function KanbanIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <rect x="1" y="1" width="4" height="14" rx="1" />
      <rect x="6" y="1" width="4" height="10" rx="1" />
      <rect x="11" y="1" width="4" height="12" rx="1" />
    </svg>
  )
}
function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M2 4h12v1.5H2V4zm0 3.5h12V9H2V7.5zm0 3.5h12v1.5H2V11z" />
    </svg>
  )
}
function GraphIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <rect x="1" y="7" width="3" height="8" rx="1" />
      <rect x="6" y="4" width="3" height="11" rx="1" />
      <rect x="11" y="1" width="3" height="14" rx="1" />
    </svg>
  )
}
function PivotIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M1 1h6v6H1V1zm0 8h6v6H1V9zm8-8h6v6H9V1zm0 8h6v6H9V9z" />
    </svg>
  )
}
function ActivityIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
      <path d="M3.5 0a.5.5 0 01.5.5V1h8V.5a.5.5 0 011 0V1h1a2 2 0 012 2v11a2 2 0 01-2 2H2a2 2 0 01-2-2V3a2 2 0 012-2h1V.5a.5.5 0 01.5-.5zM1 4v10a1 1 0 001 1h12a1 1 0 001-1V4H1z" />
      <path d="M6.5 7a.5.5 0 000 1h4a.5.5 0 000-1h-4zm0 2.5a.5.5 0 000 1h4a.5.5 0 000-1h-4zm0 2.5a.5.5 0 000 1h2a.5.5 0 000-1h-2z" />
    </svg>
  )
}

const VIEWS = [
  { key: 'list', Icon: ListIcon },
  { key: 'kanban', Icon: KanbanIcon },
  { key: 'graph', Icon: GraphIcon },
  { key: 'pivot', Icon: PivotIcon },
  { key: 'activity', Icon: ActivityIcon },
]

// ─── Main component ───────────────────────────────────────────────────────────

function MultiCheckFilter({ label, selected, onChange, options }) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef(null)
  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])
  const toggle = (value) => {
    const next = new Set(selected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange(next)
  }
  const isActive = selected.size > 0
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
          isActive
            ? 'border-[#4338ca] text-[#4338ca] bg-indigo-50 dark:bg-indigo-900/20 dark:border-[#a5b4fc] dark:text-[#a5b4fc]'
            : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]'
        }`}
      >
        {label}
        {isActive && (
          <span className="w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center">
            {selected.size}
          </span>
        )}
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full mt-1 start-0 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-xl shadow-lg z-20 py-1.5 min-w-[160px]">
          {options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(opt.value)}
                onChange={() => toggle(opt.value)}
                className="accent-[#4338ca] dark:accent-[#a5b4fc]"
              />
              <span className="text-sm text-[#211f1b] dark:text-[#e8ebf0]">{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Pipeline({ currentUserRole, currentUserEmail, currentUserPermissions , scopeEmail}) {
  const { t } = useTranslation()
  const ownScope = ownershipScope(currentUserRole, currentUserPermissions, 'deals', scopeEmail ?? currentUserEmail)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [activeView, setActiveView] = useURLTab('view', 'list')

  const { data: pipelines = EMPTY_ARRAY, isLoading: pipelinesLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
  })
  const { data: usersList = EMPTY_ARRAY } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.directory(),
    staleTime: 5 * 60_000,
  })
  const salesReps = usersList.filter((u) => u.role === 'sales_rep' || u.role === 'manager')

  // Which pipeline the board is showing. Kept in the URL (?pipeline=<id>) so the
  // choice survives a reload and can be shared, matching how `view` works above.
  //
  // This used to be hardcoded to `pipelines[0]`, with no switcher anywhere in
  // List / Kanban / Graph / Pivot / Filters. The Edit Deal dialog will happily
  // move a deal to another pipeline, so a moved deal simply vanished — invisible
  // to the board and to its own search — and the only route back was
  // Customers → <customer> → Deals. Found in manual QA 2026-08-05
  // (docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md §B).
  //
  // Falls back to the first pipeline when the param is absent or names a
  // pipeline that no longer exists, so a stale bookmark degrades to a working
  // board rather than an empty one.
  const [pipelineParam, setPipelineParam] = useURLTab('pipeline', '')
  const pipelineId =
    pipelines.find((p) => p.id === pipelineParam)?.id ?? pipelines[0]?.id ?? null

  const [showCreate, setShowCreate] = useState(false)
  const [dealForm, setDealForm] = useState(EMPTY_DEAL_FORM)
  const [pendingDealCode, setPendingDealCode] = useState('')
  const [losingDeal, setLosingDeal] = useState(null)
  const [lostForm, setLostForm] = useState(EMPTY_LOST_FORM)

  const [searchQuery, setSearchQuery] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterStages, setFilterStages] = useState(new Set())
  const [filterReps, setFilterReps] = useState(new Set())
  const [showExportDropdown, setShowExportDropdown] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selectedDeals, setSelectedDeals] = useState(new Set())

  const activeFilterCount = filterStages.size + filterReps.size

  // ── Data ──────────────────────────────────────────────────────────────────
  // Every view reads from the database with the search, filters and sort
  // applied there: the list a page at a time, the Kanban a column at a time,
  // the Activity view a page of open deals at a time, and every count, total,
  // chart and pivot from grouped sums. This page used to load every deal in the
  // pipeline (and every open activity on them) and do all of that in the
  // browser — which the Data API caps at 1 000 rows. (BUG-066.)
  //
  // Deliberately not filtered to status:'open' — Won/Lost deals must still
  // render in their own terminal columns, not vanish from the board. A rep sees
  // only deals assigned to them; RLS enforces it, and the owner filter keeps
  // the counts consistent with it.
  const debouncedSearch = useDebouncedValue(searchQuery)
  const filters = useMemo(
    () => ({
      pipelineId,
      search: debouncedSearch,
      stages: [...filterStages],
      reps: [...filterReps],
      ownerEmail: ownScope || null,
    }),
    [pipelineId, debouncedSearch, filterStages, filterReps, ownScope]
  )
  const hasPipeline = !!pipelineId

  const { data: pipelineCount = 0 } = useQuery({
    queryKey: ['deals', 'pipeline-count', pipelineId, ownScope || null],
    queryFn: () => db.deals.countInPipeline(pipelineId, ownScope || null),
    enabled: hasPipeline,
  })
  const { data: allReps = EMPTY_ARRAY } = useQuery({
    queryKey: ['deals', 'reps', pipelineId],
    queryFn: () => db.deals.repsInPipeline(pipelineId),
    enabled: hasPipeline,
  })
  const { data: buckets = EMPTY_ARRAY } = useQuery({
    queryKey: ['deals', 'buckets', filters],
    queryFn: () => db.deals.buckets(filters),
    placeholderData: keepPreviousData,
    enabled: hasPipeline,
  })
  const totalsByStage = useMemo(() => stageTotals(buckets), [buckets])
  const matchingCount = useMemo(() => buckets.reduce((n, b) => n + b.deal_count, 0), [buckets])
  const matchingValue = useMemo(() => buckets.reduce((n, b) => n + b.value_sum, 0), [buckets])

  // List
  const [listSort, setListSort] = useState({ key: 'created_at', direction: 'desc' })
  const [listPage, setListPage] = useState(1)
  const [listPerPage, setListPerPage] = useState(() => safeStorage.get('pipelineListPerPage', 25))
  useEffect(() => safeStorage.set('pipelineListPerPage', listPerPage), [listPerPage])
  const { data: listResult } = useQuery({
    queryKey: ['deals', 'page', filters, listSort, listPage, listPerPage],
    queryFn: () => db.deals.listPage(filters, listSort, listPage, listPerPage),
    placeholderData: keepPreviousData,
    enabled: hasPipeline && activeView === 'list',
  })
  const listDeals = listResult?.data ?? EMPTY_ARRAY
  const listCount = listResult?.count ?? 0
  const handleListSort = (key) =>
    setListSort((prev) =>
      prev.key === key ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' }
    )

  // Activity view: open deals, a page at a time, with those deals' open activities
  const [activityPage, setActivityPage] = useState(1)
  const [activityPerPage, setActivityPerPage] = useState(() => safeStorage.get('pipelineActivityPerPage', 25))
  useEffect(() => safeStorage.set('pipelineActivityPerPage', activityPerPage), [activityPerPage])
  const { data: activityResult } = useQuery({
    queryKey: ['deals', 'activity-page', filters, activityPage, activityPerPage],
    queryFn: () => db.deals.listPage({ ...filters, openOnly: true }, undefined, activityPage, activityPerPage),
    placeholderData: keepPreviousData,
    enabled: hasPipeline && activeView === 'activity',
  })
  const activityDeals = activityResult?.data ?? EMPTY_ARRAY
  const activityDealIds = useMemo(() => activityDeals.map((d) => d.id), [activityDeals])
  const { data: pageActivities = EMPTY_ARRAY } = useQuery({
    queryKey: ['activities', 'deal', 'open', activityDealIds],
    queryFn: () => db.activities.listForRelated('deal', activityDealIds),
    enabled: activeView === 'activity' && activityDealIds.length > 0,
  })
  const activitiesByDeal = useMemo(() => {
    const map = {}
    for (const a of pageActivities) (map[a.related_id] ??= []).push(a)
    return map
  }, [pageActivities])
  const { data: activityTypeRows = EMPTY_ARRAY } = useQuery({
    queryKey: ['deals', 'activity-types', filters],
    queryFn: () => db.deals.activityTypeCounts(filters),
    placeholderData: keepPreviousData,
    enabled: hasPipeline && activeView === 'activity',
  })
  const activityColStats = useMemo(
    () => activityTypeStats(activityTypeRows, ACTIVITY_TYPE_SCHEDULABLE),
    [activityTypeRows]
  )

  // A filter change starts every view from its beginning, and a selection
  // belongs to the page it was made on (bulk actions act on what is shown).
  const [columnLimits, setColumnLimits] = useState({})
  useEffect(() => {
    setListPage(1)
    setActivityPage(1)
    setColumnLimits({})
  }, [filters])
  useEffect(() => setSelectedDeals(new Set()), [filters, listSort, listPage, listPerPage, activeView])

  // The last page can empty under the user (a delete, a narrower filter): step back.
  useEffect(() => {
    if (!listResult) return
    const pages = Math.ceil(listResult.count / listPerPage)
    if (pages >= 1 && listPage > pages) setListPage(pages)
  }, [listResult, listPage, listPerPage])
  useEffect(() => {
    if (!activityResult) return
    const pages = Math.ceil(activityResult.count / activityPerPage)
    if (pages >= 1 && activityPage > pages) setActivityPage(pages)
  }, [activityResult, activityPage, activityPerPage])

  React.useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.export-dropdown-pipeline')) setShowExportDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.deals?.[action] === true
  }

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['deals'] })
  }

  const handleMoveStage = async (dealId, stageId) => {
    try {
      await db.deals.moveStage(dealId, stageId, currentUserEmail)
      refresh()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const handleBulkMoveStage = async (ids, stageId) => {
    try {
      await db.deals.bulkMoveStage(ids, stageId)
      refresh()
      toast.success(t('pipeline.bulkStageChanged', { count: ids.length }))
    } catch (e) {
      toast.error(e.message)
      refresh() // part of the selection may have moved (BUG-074)
    }
  }

  const handleBulkDelete = async (ids) => {
    try {
      await db.deals.bulkDelete(ids)
      refresh()
      toast.success(t('pipeline.bulkDeleted', { count: ids.length }))
    } catch (e) {
      toast.error(e.message)
      refresh() // part of the selection may have been deleted (BUG-074)
    }
  }

  const activePipeline = pipelines.find((p) => p.id === pipelineId)
  const stages = activePipeline ? [...activePipeline.stages].sort((a, b) => a.order - b.order) : EMPTY_ARRAY

  // Kanban: each column is its own read — its newest cards and its true count,
  // with "Show more" for the rest. A column the stage filter excludes is empty
  // without asking.
  const kanbanQueries = useQueries({
    queries: stages.map((stage) => {
      const limit = columnLimits[stage.id] ?? KANBAN_PAGE
      const excluded = filters.stages.length > 0 && !filters.stages.includes(stage.id)
      return {
        queryKey: ['deals', 'kanban', filters, stage.id, limit],
        queryFn: () => db.deals.listColumn(stage.id, filters, limit),
        placeholderData: keepPreviousData,
        enabled: hasPipeline && activeView === 'kanban' && !excluded,
      }
    }),
  })
  const dealsByStage = {}
  const countByStage = {}
  stages.forEach((stage, i) => {
    dealsByStage[stage.id] = kanbanQueries[i]?.data?.data ?? EMPTY_ARRAY
    countByStage[stage.id] = kanbanQueries[i]?.data?.count ?? 0
  })
  const dealsLoading = activeView === 'kanban' && kanbanQueries.some((q) => q.isLoading)
  const { data: activityValueRows = EMPTY_ARRAY } = useQuery({
    queryKey: ['deals', 'activity-values', filters],
    queryFn: () => db.deals.activityValues(filters),
    placeholderData: keepPreviousData,
    enabled: hasPipeline && activeView === 'kanban',
  })
  const activityValuesByStage = useMemo(() => stageActivityValues(activityValueRows), [activityValueRows])

  // The rows a card action or a menu can refer to: what is on screen.
  const visibleDeals =
    activeView === 'kanban' ? stages.flatMap((s) => dealsByStage[s.id]) : activeView === 'activity' ? activityDeals : listDeals

  const loadExportRows = (scope) =>
    scope === 'selected'
      ? db.deals.getMany([...selectedDeals])
      : db.deals.listAllMatching(scope === 'filtered' ? filters : { pipelineId, ownerEmail: ownScope || null })

  const handleExport = async (scope) => {
    setShowExportDropdown(false)
    setExporting(true)
    try {
      const rows = await loadExportRows(scope)
      exportDealsXlsx(rows, stages, t, `pipeline-${scope}`)
    } catch (error) {
      toast.error(t('pipeline.failedSave', { error: error.message }))
    } finally {
      setExporting(false)
    }
  }

  const handleOpenCreate = (stageId = null) => {
    const id = typeof stageId === 'string' ? stageId : null
    const targetStage = id || stages.find((s) => !s.is_won && !s.is_lost)?.id || ''
    setPendingDealCode(`OPP-${Math.floor(10000000 + Math.random() * 90000000)}`)
    // Open on the stage's own default rather than a flat 0. Each stage carries a
    // probability_default that nothing was reading, so every deal created in the
    // app started at 0% no matter which column it was created in.
    const stageDefault = stages.find((s) => s.id === targetStage)?.probability_default
    setDealForm({
      ...EMPTY_DEAL_FORM,
      pipeline_id: pipelineId,
      stage: targetStage,
      probability: stageDefault ?? 0,
    })
    setShowCreate(true)
  }

  const handleSaveDeal = async () => {
    if (!dealForm.title.trim() || !dealForm.customer_id || !dealForm.pipeline_id || !dealForm.stage) {
      toast.error(t('pipeline.createDealValidation'))
      return
    }
    try {
      await db.deals.create({
        deal_code: pendingDealCode,
        title: dealForm.title.trim(),
        customer_id: dealForm.customer_id,
        contact_id: null,
        pipeline_id: dealForm.pipeline_id,
        stage: dealForm.stage,
        value: dealForm.value ? Number(dealForm.value) : null,
        // Was the literal 0, which discarded the slider the modal renders above
        // it — whatever the user set, the deal was created at 0%.
        probability: Number(dealForm.probability) || 0,
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
    const deal = visibleDeals.find((d) => d.id === draggableId)
    // Closed deals are not draggable (isDragDisabled below), but guard here too.
    if (!destStage || !deal || deal.status !== 'open') return

    if (destStage.is_lost) {
      setLosingDeal(deal)
      setLostForm(EMPTY_LOST_FORM)
      return
    }

    // Optimistic move so the card doesn't snap back while the request is in
    // flight: out of its column, into the destination's (Won deals stay
    // visible, now in the Won column), with both counts adjusted.
    await queryClient.cancelQueries({ queryKey: ['deals', 'kanban'] })
    const moved = { ...deal, stage: destStage.id, status: destStage.is_won ? 'won' : deal.status }
    for (const [key, data] of queryClient.getQueriesData({ queryKey: ['deals', 'kanban'] })) {
      if (!data) continue
      if (key[3] === deal.stage) {
        queryClient.setQueryData(key, { data: data.data.filter((d) => d.id !== deal.id), count: Math.max(0, data.count - 1) })
      } else if (key[3] === destStage.id) {
        queryClient.setQueryData(key, { data: [moved, ...data.data], count: data.count + 1 })
      }
    }

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
        {/* Pipeline switcher — only meaningful with more than one pipeline.
            Without it a deal moved to another pipeline is unreachable. */}
        {pipelines.length > 1 && (
          <select
            value={pipelineId ?? ''}
            onChange={(e) => setPipelineParam(e.target.value)}
            aria-label={t('pipeline.selectPipeline')}
            className="px-3 py-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#121823] text-sm text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {/* View switcher */}
        <div className="flex gap-1 bg-[#f4f6f9] dark:bg-[#0f1520] rounded-lg p-1">
          {VIEWS.map(({ key, Icon }) => (
            <button
              key={key}
              onClick={() => setActiveView(key)}
              title={t(`pipeline.view_${key}`)}
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${
                activeView === key
                  ? 'bg-white dark:bg-[#121823] text-[#4338ca] dark:text-[#a5b4fc] shadow-sm'
                  : 'text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
              }`}
            >
              <Icon />
            </button>
          ))}
        </div>
        {/* Export dropdown */}
        {pipelineCount > 0 && (
          <div className="relative export-dropdown-pipeline">
            <button
              disabled={exporting}
              onClick={(e) => { e.stopPropagation(); setShowExportDropdown(!showExportDropdown) }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] transition-colors"
            >
              <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {t('pipeline.export')}
              <svg className={`w-3.5 h-3.5 transition-transform ${showExportDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showExportDropdown && (
              <div className="absolute end-0 mt-2 w-64 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] z-20 py-1.5">
                {/* Export All */}
                <button
                  onClick={() => handleExport('all')}
                  className="w-full px-4 py-2.5 text-start hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] flex items-center gap-3"
                >
                  <svg className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <div>
                    <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t('pipeline.exportAll')}</div>
                    <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('pipeline.exportAllDesc', { count: pipelineCount })}</div>
                  </div>
                </button>
                {/* Export Filtered — only when filters/search are active */}
                {matchingCount !== pipelineCount && (
                  <button
                    onClick={() => handleExport('filtered')}
                    className="w-full px-4 py-2.5 text-start hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] flex items-center gap-3 border-t border-[#f0f2f6] dark:border-[#1a2230]"
                  >
                    <svg className="w-4 h-4 text-indigo-500 dark:text-[#a5b4fc] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
                    </svg>
                    <div>
                      <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t('pipeline.exportFiltered')}</div>
                      <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('pipeline.exportFilteredDesc', { count: matchingCount })}</div>
                    </div>
                  </button>
                )}
                {/* Export Selected — only when rows are checked */}
                {selectedDeals.size > 0 && (
                  <button
                    onClick={() => handleExport('selected')}
                    className="w-full px-4 py-2.5 text-start hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] flex items-center gap-3 border-t border-[#f0f2f6] dark:border-[#1a2230]"
                  >
                    <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <div>
                      <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t('pipeline.exportSelected')}</div>
                      <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('pipeline.exportSelectedDesc', { count: selectedDeals.size })}</div>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {canDo('create') && <Button onClick={() => handleOpenCreate()}>{t('pipeline.createDeal')}</Button>}
      </PageHeader>

      {/* Search & filter toolbar */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3 mb-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('pipeline.searchPlaceholder')}
            aria-label={t('pipeline.searchPlaceholder')}
            className="w-full ps-9 pe-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
          className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'border-[#4338ca] text-[#4338ca] bg-indigo-50 dark:bg-indigo-900/20 dark:border-[#a5b4fc] dark:text-[#a5b4fc]'
              : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
          </svg>
          {t('common.filters')}
          {activeFilterCount > 0 && (
            <span className="w-4 h-4 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs rounded-full flex items-center justify-center">
              {activeFilterCount}
            </span>
          )}
        </button>
        {(searchQuery || activeFilterCount > 0) && (
          <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.filteredCount', { count: matchingCount, total: pipelineCount })}
          </span>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="bg-[#f8f9fb] dark:bg-[#0f1520] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4 mb-4 flex flex-wrap gap-3 items-center">
          <MultiCheckFilter
            label={t('pipeline.allStages')}
            selected={filterStages}
            onChange={setFilterStages}
            options={stages.map((s) => ({ value: s.id, label: s.name }))}
          />
          <MultiCheckFilter
            label={t('pipeline.allReps')}
            selected={filterReps}
            onChange={setFilterReps}
            options={allReps.map((r) => ({ value: r, label: r }))}
          />
          {activeFilterCount > 0 && (
            <button
              onClick={() => { setFilterStages(new Set()); setFilterReps(new Set()) }}
              className="text-sm text-red-500 dark:text-red-400 hover:underline"
            >
              {t('common.clear')}
            </button>
          )}
        </div>
      )}

      {activeView === 'list' && (
        <PipelineListView
          deals={listDeals}
          totalCount={listCount}
          totalValue={matchingValue}
          sort={listSort}
          onSortChange={handleListSort}
          currentPage={listPage}
          itemsPerPage={listPerPage}
          onPageChange={setListPage}
          onItemsPerPageChange={(n) => {
            setListPerPage(n)
            setListPage(1)
          }}
          stages={stages}
          selectedDeals={selectedDeals}
          onSelectedChange={setSelectedDeals}
          onMoveStage={handleMoveStage}
          onBulkMoveStage={handleBulkMoveStage}
          onBulkDelete={handleBulkDelete}
          isAdmin={currentUserRole === 'super_admin' || currentUserRole === 'admin'}
        />
      )}
      {activeView === 'graph' && (
        <PipelineGraphView buckets={buckets} stages={stages} />
      )}
      {activeView === 'pivot' && (
        <PipelinePivotView buckets={buckets} stages={stages} />
      )}
      {activeView === 'activity' && (
        <PipelineActivityView
          deals={activityDeals}
          totalCount={activityResult?.count ?? 0}
          currentPage={activityPage}
          itemsPerPage={activityPerPage}
          onPageChange={setActivityPage}
          onItemsPerPageChange={setActivityPerPage}
          stages={stages}
          activitiesByDeal={activitiesByDeal}
          colStats={activityColStats}
        />
      )}

      {activeView === 'kanban' && (dealsLoading ? (
        <PageSkeleton />
      ) : stages.length === 0 ? (
        <EmptyState title={t('pipeline.noStages')} description={t('pipeline.noStagesHint')} />
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          {/* Columns share the available width and shrink to fit so every stage is
              visible at once with no horizontal scrollbar — but only from md up.

              That rule used to apply at every width, and below about 700px it
              stopped being a layout and became a crush: seven stages in a 375px
              viewport are 34px each, headers truncate to a single letter, and card
              content spills across its neighbours. The board was unusable on a
              phone, which is also why the touch-drag row of the QA checklist could
              never be run — there was nothing draggable-sized to drag.

              Below md the columns take a 16rem floor and the row scrolls instead.
              auto-cols with grid-flow-col gives the same result as the explicit
              repeat(n, …) this replaces, without threading the stage count through
              an inline style. */}
          <div className="grid grid-flow-col auto-cols-[minmax(16rem,1fr)] md:auto-cols-[minmax(0,1fr)] overflow-x-auto md:overflow-x-visible gap-3 pb-4">
            {stages.map((stage) => {
              const stageDeals = dealsByStage[stage.id] || []
              const stageCount = countByStage[stage.id] ?? 0
              // Over every deal in the column, not just the cards loaded.
              const totalValue = totalsByStage[stage.id]?.value ?? 0
              const buckets = activityValuesByStage[stage.id] ?? { overdue: 0, today: 0, planned: 0 }
              const pct = (n) => (totalValue > 0 ? (n / totalValue) * 100 : 0)

              return (
                <div key={stage.id} className="min-w-0">
                  <div className="mb-2 px-1">
                    {/* Line 1: stage name + count (left) · add button (right) */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] truncate" title={stage.name}>
                        {stage.name}{' '}
                        <span className="text-gray-400 dark:text-[#a4acb7] font-normal">
                          ({stageCount})
                        </span>
                      </h3>
                      {!stage.is_won && !stage.is_lost && canDo('create') && (
                        <button
                          onClick={() => handleOpenCreate(stage.id)}
                          className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded text-gray-400 dark:text-[#a4acb7] hover:text-indigo-600 dark:hover:text-[#a5b4fc] hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
                          title={t('pipeline.createDeal')}
                        >
                          +
                        </button>
                      )}
                    </div>
                    {/* Line 2: total value */}
                    {totalValue > 0 && (
                      <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                        {Number(totalValue).toLocaleString()} {t('pipeline.currency')}
                      </p>
                    )}
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
                                  {deal.deal_code && (
                                    <p className="text-[10px] font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] mt-0.5">
                                      {deal.deal_code}
                                    </p>
                                  )}
                                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5 truncate">
                                    {deal.customer_name || '—'}
                                  </p>
                                  {deal.value != null && (
                                    <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] mt-1">
                                      {Number(deal.value).toLocaleString()} {t('pipeline.currency')}
                                    </p>
                                  )}
                                  <div className="flex items-center justify-between mt-2">
                                    <span className="text-[10px] text-gray-400 dark:text-[#a4acb7]">
                                      {deal.created_at ? new Date(deal.created_at).toLocaleDateString() : ''}
                                    </span>
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

                        {stageCount > stageDeals.length && (
                          <button
                            type="button"
                            onClick={() =>
                              setColumnLimits((prev) => ({ ...prev, [stage.id]: (prev[stage.id] ?? KANBAN_PAGE) + KANBAN_PAGE }))
                            }
                            className="w-full mt-1 py-1.5 text-xs font-medium text-indigo-600 dark:text-[#a5b4fc] hover:underline"
                          >
                            {t('pipeline.kanbanShowMore', { count: stageCount - stageDeals.length })}
                          </button>
                        )}
                      </div>
                    )}
                  </Droppable>
                </div>
              )
            })}
          </div>
        </DragDropContext>
      ))}

      {showCreate && (
        <CreateDealModal
          form={dealForm}
          setForm={setDealForm}
          dealCode={pendingDealCode}
          pipeline={activePipeline}
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
