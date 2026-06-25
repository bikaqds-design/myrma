import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useURLTab } from '../../hooks/useURLTab'
import { canDo } from '../../lib/permissions'
import { PageHeader } from '../../components/ui'

// ── Type icons (same set as ActivityChatter) ───────────────────────────────
const TYPE_ICON_PATHS = {
  call:     'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z',
  meeting:  'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  whatsapp: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
  email:    'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  task:     'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
  note:     'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
}

const TYPE_COLORS = {
  call:     '#4338ca',
  meeting:  '#7c3aed',
  whatsapp: '#059669',
  email:    '#0284c7',
  task:     '#d97706',
  note:     '#6c6760',
}

function ActivityTypeIcon({ type, size = 16 }) {
  const path = TYPE_ICON_PATHS[type] ?? TYPE_ICON_PATHS.task
  const color = TYPE_COLORS[type] ?? TYPE_COLORS.task
  return (
    <svg width={size} height={size} fill="none" stroke={color} strokeWidth={1.8} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <svg className="w-12 h-12 text-[#a09d99] dark:text-[#4a5568] mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.4} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
      <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{title}</p>
      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{hint}</p>
    </div>
  )
}

// ── Activity row ───────────────────────────────────────────────────────────
function ActivityRow({ activity, relatedName, relatedType, onMarkDone, onDelete, onNavigate, canEdit, today, t }) {
  const [rescheduling, setRescheduling] = useState(false)
  const [newDate, setNewDate] = useState(activity.due_date ?? '')
  const queryClient = useQueryClient()

  const dueDateStr = activity.due_date ? activity.due_date.split('T')[0] : null
  const isOverdue = dueDateStr && dueDateStr < today
  const isToday   = dueDateStr && dueDateStr === today

  const dateColor = isOverdue
    ? 'text-red-600 dark:text-red-400'
    : isToday
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-[#6c6760] dark:text-[#9aa4b2]'

  const handleReschedule = async () => {
    if (!newDate) return
    try {
      await db.activities.reschedule(activity.id, newDate)
      queryClient.invalidateQueries({ queryKey: ['activities'] })
      setRescheduling(false)
      toast.success(t('activityChatter.activityRescheduled'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4">
      <div className="flex items-start gap-3">
        {/* Type icon */}
        <div className="mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: (TYPE_COLORS[activity.type] ?? '#6c6760') + '18' }}>
          <ActivityTypeIcon type={activity.type} size={16} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] leading-snug">{activity.title}</p>
            {/* Due date badge */}
            <span className={`flex-shrink-0 text-xs font-medium ${dateColor}`}>
              {dueDateStr
                ? new Date(dueDateStr + 'T00:00:00').toLocaleDateString()
                : t('activities.noDueDate')}
            </span>
          </div>

          {/* Related record link */}
          <button
            onClick={() => onNavigate(activity)}
            className="mt-0.5 text-xs text-[#4338ca] dark:text-[#a5b4fc] hover:underline text-start"
          >
            {t(`activities.related${relatedType.charAt(0).toUpperCase() + relatedType.slice(1)}`)}: {relatedName}
          </button>

          {/* Assignee */}
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">
            {activity.assigned_rep ?? t('activities.noAssignee')}
          </p>

          {/* Reschedule date picker (inline) */}
          {rescheduling && (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="px-2 py-1 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
              />
              <button onClick={handleReschedule} className="text-xs text-[#4338ca] dark:text-[#a5b4fc] font-medium hover:underline">
                {t('common.save')}
              </button>
              <button onClick={() => setRescheduling(false)} className="text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:underline">
                {t('common.cancel')}
              </button>
            </div>
          )}

          {/* Action buttons */}
          {canEdit && !rescheduling && (
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={() => onMarkDone(activity)}
                className="text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
              >
                ✓ {t('activityChatter.markDone')}
              </button>
              <button
                onClick={() => setRescheduling(true)}
                className="text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
              >
                {t('activityChatter.reschedule')}
              </button>
              <button
                onClick={() => onDelete(activity)}
                className="text-xs font-medium text-red-500 dark:text-red-400 hover:underline"
              >
                {t('activityChatter.cancelActivity')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function Activities({ currentUserRole, currentUserPermissions }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [tab, setTab] = useURLTab('tab', 'overdue')
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')

  const today = new Date().toISOString().split('T')[0]

  const { data: activities = [], isLoading } = useQuery({
    queryKey: ['activities', 'planned'],
    queryFn: () => db.activities.listAllPlanned(),
    staleTime: 30_000,
  })

  // Fetch leads + deals for name resolution (shared cache keys used by Pipeline/Leads pages)
  const { data: leads = [] } = useQuery({
    queryKey: ['leads'],
    queryFn: () => db.leads.list(),
    staleTime: 60_000,
  })
  const { data: deals = [] } = useQuery({
    queryKey: ['deals'],
    queryFn: () => db.deals.list(),
    staleTime: 60_000,
  })

  const leadMap = useMemo(() => Object.fromEntries(leads.map((l) => [l.id, l])), [leads])
  const dealMap = useMemo(() => Object.fromEntries(deals.map((d) => [d.id, d])), [deals])

  const getRelatedName = React.useCallback((a) => {
    if (a.related_type === 'lead') {
      const lead = leadMap[a.related_id]
      return lead ? (lead.company_name || lead.full_name) : a.related_id
    }
    if (a.related_type === 'deal') {
      return dealMap[a.related_id]?.title ?? a.related_id
    }
    return a.related_id
  }, [leadMap, dealMap])

  // Tab filtering
  const tabFiltered = useMemo(() => {
    if (tab === 'overdue') return activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d < today })
    if (tab === 'today')   return activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d === today })
    return activities
  }, [activities, tab, today])

  // Search + filters
  const activeFilterCount = [filterType, filterAssignee].filter(Boolean).length
  const filtered = useMemo(() => {
    let f = tabFiltered
    if (search) {
      const q = search.toLowerCase()
      f = f.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          getRelatedName(a).toLowerCase().includes(q) ||
          a.assigned_rep?.toLowerCase().includes(q)
      )
    }
    if (filterType) f = f.filter((a) => a.type === filterType)
    if (filterAssignee) f = f.filter((a) => a.assigned_rep === filterAssignee)
    return f
  }, [tabFiltered, search, filterType, filterAssignee, getRelatedName])

  const allAssignees = useMemo(
    () => [...new Set(activities.map((a) => a.assigned_rep).filter(Boolean))].sort(),
    [activities]
  )

  const canEdit =
    canDo(currentUserRole, currentUserPermissions, 'deals', 'edit') ||
    canDo(currentUserRole, currentUserPermissions, 'leads', 'edit')

  const overdueCount = useMemo(
    () => activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d < today }).length,
    [activities, today]
  )
  const todayCount = useMemo(
    () => activities.filter((a) => { const d = a.due_date?.split('T')[0]; return d && d === today }).length,
    [activities, today]
  )

  const invalidateAll = () => queryClient.invalidateQueries({ queryKey: ['activities'] })

  const handleMarkDone = async (activity) => {
    try {
      await db.activities.complete(activity.id)
      invalidateAll()
      toast.success(t('activities.markedDoneToast'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  const handleDelete = async (activity) => {
    if (!window.confirm(t('activities.deleteConfirm'))) return
    try {
      await db.activities.delete(activity.id)
      invalidateAll()
      toast.success(t('activities.deletedToast'))
    } catch {
      toast.error(t('common.error'))
    }
  }

  const handleNavigate = (activity) => {
    if (activity.related_type === 'lead') navigate(`/leads/${activity.related_id}`)
    else if (activity.related_type === 'deal') navigate(`/pipeline/${activity.related_id}`)
  }

  const inp =
    'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'

  const TABS = [
    { id: 'overdue', label: t('activities.tabOverdue'), count: overdueCount },
    { id: 'today',   label: t('activities.tabToday'),   count: todayCount },
    { id: 'all',     label: t('activities.tabAll'),     count: activities.length },
  ]

  const emptyProps = {
    overdue: { title: t('activities.noOverdue'),    hint: t('activities.noOverdueHint') },
    today:   { title: t('activities.noToday'),      hint: t('activities.noTodayHint') },
    all:     { title: t('activities.noActivities'), hint: t('activities.noActivitiesHint') },
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin w-8 h-8 border-4 border-[#4338ca] border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('activities.title')}
        subtitle={t('activities.subtitle', { count: activities.length })}
      />

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#e6e9ef] dark:border-[#212a38]">
        {TABS.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              tab === id
                ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc]'
                : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                id === 'overdue'
                  ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                  : 'bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]'
              }`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search + Filters toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('activities.searchPlaceholder')}
            className="w-full pl-9 pr-4 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#a09d99] dark:placeholder:text-[#4a5568]"
          />
          <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          aria-expanded={showFilters}
          aria-controls="activities-filter-panel"
          className={`flex items-center gap-2 px-4 py-2 border rounded-lg text-sm transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'border-[#4338ca] dark:border-[#a5b4fc] text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20'
              : 'border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
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
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div id="activities-filter-panel" className="p-4 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className={inp}>
              <option value="">{t('activities.allTypes')}</option>
              {Object.keys(TYPE_ICON_PATHS).map((type) => (
                <option key={type} value={type}>{t(`activityType.${type}`)}</option>
              ))}
            </select>
            <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} className={inp}>
              <option value="">{t('activities.allAssignees')}</option>
              {allAssignees.map((rep) => (
                <option key={rep} value={rep}>{rep}</option>
              ))}
            </select>
          </div>
          {activeFilterCount > 0 && (
            <button
              onClick={() => { setFilterType(''); setFilterAssignee('') }}
              className="mt-3 text-sm text-red-500 dark:text-red-400 hover:underline"
            >
              {t('common.clear')}
            </button>
          )}
        </div>
      )}

      {/* Count line */}
      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
        {t('activities.showingOf', { filtered: filtered.length, total: tabFiltered.length })}
      </p>

      {/* Activity list */}
      {filtered.length === 0 ? (
        <EmptyState {...emptyProps[tab]} />
      ) : (
        <div className="space-y-3">
          {filtered.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              relatedName={getRelatedName(activity)}
              relatedType={activity.related_type}
              onMarkDone={handleMarkDone}
              onDelete={handleDelete}
              onNavigate={handleNavigate}
              canEdit={canEdit}
              today={today}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}
