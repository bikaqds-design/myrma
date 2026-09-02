import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Button, Spinner, PageHeader } from '../components/ui'
import EmptyState from '../components/EmptyState'
import { useAppearance } from '../contexts/AppearanceContext'
import { captureException } from '../lib/sentry'
import { EMPTY_ARRAY } from '../lib/stableEmpty'

// ─── Constants ────────────────────────────────────────────────────────────────

const PRIORITY_CLS = {
  Critical: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900/30',
  High:     'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300',
  Medium:   'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
  Low:      'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
}

const STATUS_CLS = {
  New:          'bg-pink-100 dark:bg-pink-900/20 text-pink-700 dark:text-pink-300',
  'In Progress':'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  'On Hold':    'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
  Completed:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  Cancelled:    'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the Monday of the week containing `date` */
function getMonday(date) {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

/** Returns array of 7 Date objects starting from monday */
function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + i)
    return d
  })
}

function isoDate(date) {
  return date.toISOString().split('T')[0]
}

function sameDay(a, b) {
  return isoDate(a) === isoDate(b)
}

function shortDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Ticket Card ─────────────────────────────────────────────────────────────

/**
 * A planned CRM activity on the week grid.
 *
 * Visually distinct from a ticket on purpose — an overdue approval and a repair
 * due the same day are different work, and rendering them identically invites
 * someone to action the wrong one. Tickets keep the solid card; activities get
 * a left rule and a type label.
 *
 * Overdue items are marked where they fall rather than pulled to today, so the
 * week reads as a record of what was due when. Same rule the ticket cards use.
 *
 * Approval titles are machine-built ("approval|quotation|<uuid>"), so the type
 * carries the meaning and the raw title is a tooltip rather than the headline.
 */
function ActivityCard({ activity }) {
  const { t } = useTranslation()
  const overdue = activity.due_date && new Date(activity.due_date) < new Date()
  const label = t(`calendar.activityType_${activity.type}`, activity.type)
  return (
    <div
      title={activity.title || ''}
      className={`rounded-md border-l-2 ps-2 pe-1.5 py-1.5 text-[11px] bg-[#f8f9fb] dark:bg-[#0f1520] ${
        overdue ? 'border-l-red-500 dark:border-l-red-400' : 'border-l-indigo-400 dark:border-l-indigo-300'
      }`}
    >
      <p className="font-semibold text-gray-800 dark:text-[#e8ebf0] truncate">{label}</p>
      {activity.assigned_rep && (
        <p className="text-gray-600 dark:text-[#9aa4b2] truncate">{activity.assigned_rep}</p>
      )}
      {overdue && <p className="text-red-600 dark:text-red-300 font-medium">{t('calendar.overdue')}</p>}
    </div>
  )
}

function TicketCard({ ticket, isOverdue, onNavigateToTicket }) {
  return (
    <div
      onClick={() => onNavigateToTicket?.(ticket.id)}
      className={`rounded-lg border bg-white dark:bg-[#121823] p-2.5 cursor-pointer hover:shadow-md transition-shadow text-xs ${
        isOverdue
          ? 'border-l-4 border-l-red-500 border-t-[#e6e9ef] border-r-[#e6e9ef] border-b-[#e6e9ef] dark:border-t-[#212a38] dark:border-r-[#212a38] dark:border-b-[#212a38]'
          : 'border-[#e6e9ef] dark:border-[#212a38]'
      }`}
    >
      <p className="font-semibold text-gray-800 dark:text-[#e8ebf0] truncate mb-1">{ticket.rma_number}</p>
      <p className="text-gray-500 dark:text-[#9aa4b2] truncate mb-1.5">{ticket.customer_name || '—'}</p>
      <div className="flex flex-wrap gap-1">
        {ticket.priority && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_CLS[ticket.priority] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
          >
            {ticket.priority}
          </span>
        )}
        {ticket.ticket_status && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CLS[ticket.ticket_status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
          >
            {ticket.ticket_status}
          </span>
        )}
      </div>
      {ticket.assigned_technician && (
        <p className="text-gray-500 dark:text-[#9aa4b2] mt-1 truncate">{ticket.assigned_technician}</p>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function TechCalendar({
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onNavigateToTicket,
}) {
  const { t, i18n } = useTranslation()
  const { formatDate: _formatDate } = useAppearance()

  const _canDo = (s, a) =>
    ['super_admin', 'admin'].includes(currentUserRole) || currentUserPermissions?.[s]?.[a]

  const isAdminOrManager = ['super_admin', 'admin', 'manager'].includes(currentUserRole)

  const [mondayDate, setMondayDate] = useState(() => getMonday(new Date()))
  const [selectedTech, setSelectedTech] = useState('')

  // ─── Load data ──────────────────────────────────────────────────────────────
  const { data: tickets = EMPTY_ARRAY, isLoading: loading, isError, error, refetch } = useQuery({
    queryKey: ['tech-calendar-tickets'],
    queryFn: () => db.rmaTickets.list(),
  })
  // Planned CRM work — scheduled calls and approvals awaiting action. The page
  // used to load tickets alone, so the only dated things it could show were 13
  // repairs spread over four months; most weeks rendered empty while follow-ups
  // sat unseen. listAllPlanned() already encodes what "planned" means (open,
  // dated, not a log entry), so this page and the Activities page agree.
  const { data: planned = EMPTY_ARRAY } = useQuery({
    queryKey: ['tech-calendar-activities'],
    queryFn: () => db.activities.listAllPlanned(),
  })
  useEffect(() => {
    if (isError) {
      captureException(error)
      toast.error(i18next.t('calendar.errorLoadTickets'))
    }
  }, [isError, error])

  // ─── Derived data ────────────────────────────────────────────────────────────
  // Assignees, not technicians: a row is one person's week, and a rep with a
  // scheduled call belongs on it as much as a technician with a repair.
  const technicians = useMemo(() => {
    const set = new Set()
    tickets.forEach((t) => {
      if (t.assigned_technician) set.add(t.assigned_technician)
    })
    planned.forEach((a) => {
      if (a.assigned_rep) set.add(a.assigned_rep)
    })
    return Array.from(set).sort()
  }, [tickets, planned])

  const effectiveTech = isAdminOrManager ? selectedTech : currentUserEmail

  const filteredTickets = useMemo(() => {
    if (!effectiveTech) return tickets
    return tickets.filter((t) => t.assigned_technician === effectiveTech)
  }, [tickets, effectiveTech])

  const filteredPlanned = useMemo(() => {
    if (!effectiveTech) return planned
    return planned.filter((a) => a.assigned_rep === effectiveTech)
  }, [planned, effectiveTech])

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const days = weekDays(mondayDate)

  const ticketsByDay = useMemo(() => {
    const map = {}
    days.forEach((d) => {
      map[isoDate(d)] = []
    })
    filteredTickets.forEach((t) => {
      if (!t.due_date) return
      const key = t.due_date.split('T')[0]
      if (map[key]) map[key].push(t)
    })
    return map
  }, [filteredTickets, days])

  const activitiesByDay = useMemo(() => {
    const map = {}
    days.forEach((d) => {
      map[isoDate(d)] = []
    })
    filteredPlanned.forEach((a) => {
      if (!a.due_date) return
      const key = a.due_date.split('T')[0]
      if (map[key]) map[key].push(a)
    })
    return map
  }, [filteredPlanned, days])

  const unscheduled = useMemo(
    () =>
      filteredTickets.filter(
        (t) => !t.due_date && t.ticket_status !== 'Completed' && t.ticket_status !== 'Cancelled'
      ),
    [filteredTickets]
  )

  // ─── Navigation ──────────────────────────────────────────────────────────────
  const goToPrev = () => {
    const d = new Date(mondayDate)
    d.setDate(d.getDate() - 7)
    setMondayDate(d)
  }
  const goToNext = () => {
    const d = new Date(mondayDate)
    d.setDate(d.getDate() + 7)
    setMondayDate(d)
  }
  const goToToday = () => setMondayDate(getMonday(new Date()))

  const sunday = days[6]
  const weekLabel = `${shortDate(mondayDate)} – ${shortDate(sunday)}`

  // ─── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <Spinner size="lg" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[320px] gap-3">
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('calendar.errorLoadCalendar')}</p>
        <Button variant="secondary" size="sm" onClick={() => refetch()}>{t('common.retry')}</Button>
      </div>
    )
  }

  return (
    <div className="p-3 sm:p-6 max-w-full">
      {/* Header */}
      <PageHeader
        title={t('calendar.title')}
        subtitle={t('calendar.subtitle')}
      />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Week navigation */}
        <div className="flex items-center gap-2">
          <button
            onClick={goToPrev}
            className="p-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
            aria-label="Previous week"
          >
            <svg
              className="w-4 h-4 text-gray-600 dark:text-[#9aa4b2]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <span className="text-sm font-semibold text-gray-800 dark:text-[#e8ebf0] min-w-[160px] text-center">
            {weekLabel}
          </span>
          <button
            onClick={goToNext}
            className="p-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
            aria-label="Next week"
          >
            <svg
              className="w-4 h-4 text-gray-600 dark:text-[#9aa4b2]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <Button variant="secondary" size="sm" onClick={goToToday}>
            {t('calendar.today')}
          </Button>
        </div>

        {/* Technician filter — admin/manager only */}
        {isAdminOrManager && (
          <div className="ms-auto flex items-center gap-2">
            <label className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('calendar.technician')}:</label>
            <select
              aria-label={t('calendar.technician')}
              value={selectedTech}
              onChange={(e) => setSelectedTech(e.target.value)}
              className="px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">{t('calendar.allTechnicians')}</option>
              {technicians.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Calendar Grid */}
      <div className="overflow-x-auto -mx-3 sm:mx-0">
      <div className="min-w-[640px] bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] shadow-sm overflow-hidden mb-6">
        {/* Day header row */}
        <div className="grid grid-cols-7 border-b border-[#e6e9ef] dark:border-[#212a38]">
          {days.map((d, i) => {
            const isToday = sameDay(d, new Date())
            return (
              <div
                key={i}
                className={`px-3 py-3 text-center border-r last:border-r-0 border-[#e6e9ef] dark:border-[#212a38] ${
                  isToday ? 'bg-indigo-50 dark:bg-[#1e1f3a]' : 'bg-[#f8f9fb] dark:bg-[#0f1520]'
                }`}
              >
                <p
                  className={`text-xs font-semibold uppercase tracking-wide ${isToday ? 'text-indigo-600 dark:text-[#a5b4fc]' : 'text-gray-500 dark:text-[#9aa4b2]'}`}
                >
                  {d.toLocaleDateString(i18n.language, { weekday: 'short' }).toUpperCase()}
                </p>
                <p
                  className={`text-lg font-bold mt-0.5 ${isToday ? 'text-indigo-700 dark:text-[#a5b4fc]' : 'text-gray-800 dark:text-[#e8ebf0]'}`}
                >
                  {d.getDate()}
                </p>
                <p className="text-[10px] text-gray-500 dark:text-[#9aa4b2]">
                  {d.toLocaleDateString('en-US', { month: 'short' })}
                </p>
              </div>
            )
          })}
        </div>

        {/* Day columns */}
        <div className="grid grid-cols-7 min-h-[400px]">
          {days.map((d, i) => {
            const key = isoDate(d)
            const dayTickets = ticketsByDay[key] || []
            const dayActivities = activitiesByDay[key] || []
            const isToday = sameDay(d, new Date())
            return (
              <div
                key={i}
                className={`border-r last:border-r-0 border-[#e6e9ef] dark:border-[#212a38] p-2 flex flex-col gap-2 ${
                  isToday ? 'bg-indigo-50/30 dark:bg-[#1e1f3a]/20' : ''
                }`}
              >
                {dayTickets.length === 0 && dayActivities.length === 0 && (
                  <p className="text-[10px] text-gray-300 dark:text-[#a4acb7] text-center mt-4">—</p>
                )}
                {dayActivities.map((act) => (
                  <ActivityCard key={act.id} activity={act} />
                ))}
                {dayTickets.map((ticket) => {
                  const dueDate = ticket.due_date ? new Date(ticket.due_date) : null
                  dueDate && dueDate.setHours(0, 0, 0, 0)
                  const isOverdue =
                    dueDate &&
                    dueDate < today &&
                    ticket.ticket_status !== 'Completed' &&
                    ticket.ticket_status !== 'Cancelled'
                  return (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      isOverdue={isOverdue}
                      onNavigateToTicket={onNavigateToTicket}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      </div>

      {/* Unscheduled Panel */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] shadow-sm p-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] mb-3 flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          {t('calendar.unscheduledTickets')}
          {unscheduled.length > 0 && (
            <span className="ms-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] text-xs font-medium">
              {unscheduled.length}
            </span>
          )}
        </h3>
        {unscheduled.length === 0 ? (
          <EmptyState
            title={t('calendar.noUnscheduled')}
            description={t('calendar.noUnscheduledDesc')}
            className="py-8"
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {unscheduled.map((ticket) => (
              <TicketCard
                key={ticket.id}
                ticket={ticket}
                isOverdue={false}
                onNavigateToTicket={onNavigateToTicket}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
