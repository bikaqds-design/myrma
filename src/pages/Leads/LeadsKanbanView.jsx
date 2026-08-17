import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import { LEAD_STATUS_LIST } from '../../lib/constants'

const STATUS_BADGE = {
  new:          'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  contacted:    'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  qualified:    'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  nurturing:    'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  inactive:     'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400',
  converted:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  disqualified: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
}

const SOURCE_BADGE = {
  'walk-in':   'bg-cyan-100 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-400',
  phone:       'bg-rose-100 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400',
  referral:    'bg-fuchsia-100 dark:bg-fuchsia-900/20 text-fuchsia-700 dark:text-fuchsia-400',
  exhibition:  'bg-lime-100 dark:bg-lime-900/20 text-lime-700 dark:text-lime-400',
  website:     'bg-sky-100 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400',
  whatsapp:    'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
}

// Top border accent per status for the column header
const COL_ACCENT = {
  new:          'border-t-blue-400',
  contacted:    'border-t-amber-400',
  qualified:    'border-t-purple-500',
  nurturing:    'border-t-teal-400',
  inactive:     'border-t-orange-400',
  converted:    'border-t-green-500',
  disqualified: 'border-t-gray-300 dark:border-t-gray-600',
}

const AVATAR_COLORS = [
  'bg-indigo-500', 'bg-blue-500', 'bg-emerald-500', 'bg-purple-500',
  'bg-pink-500', 'bg-orange-500', 'bg-teal-500', 'bg-rose-500',
]
const REP_COLORS = ['bg-indigo-500', 'bg-teal-500', 'bg-amber-500', 'bg-pink-500', 'bg-sky-500', 'bg-emerald-500']

function avatarColor(str) {
  let h = 0
  for (const c of (str || '')) h = (h * 31 + c.charCodeAt(0)) | 0
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}
function repColor(email) {
  if (!email) return 'bg-gray-400'
  let h = 0
  for (const c of email) h = (h * 31 + c.charCodeAt(0)) | 0
  return REP_COLORS[Math.abs(h) % REP_COLORS.length]
}
function initials(str) {
  return str?.[0]?.toUpperCase() || '?'
}

export default function LeadsKanbanView({ leads, onStatusChange, canEdit }) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  // Group leads by status
  const byStatus = {}
  for (const s of LEAD_STATUS_LIST) byStatus[s] = []
  for (const l of leads) {
    if (byStatus[l.status]) byStatus[l.status].push(l)
    // Leads with unknown status fall into the first column
    else byStatus[LEAD_STATUS_LIST[0]].push(l)
  }

  const handleDragEnd = (result) => {
    const { source, destination, draggableId } = result
    if (!destination || destination.droppableId === source.droppableId) return
    const newStatus = destination.droppableId
    if (newStatus === 'converted') return // only Convert flow sets this
    onStatusChange(draggableId, newStatus)
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div
        className="grid gap-3 pb-4"
        style={{ gridTemplateColumns: `repeat(${LEAD_STATUS_LIST.length}, minmax(0, 1fr))` }}
      >
        {LEAD_STATUS_LIST.map((status) => {
          const statusLeads = byStatus[status] || []
          const isTerminal = status === 'converted'

          return (
            <div key={status} className="min-w-0">
              {/* Column header */}
              <div className={`mb-2 px-3 py-2.5 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] border-t-4 ${COL_ACCENT[status]} rounded-xl`}>
                <div className="flex items-center justify-between">
                  <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATUS_BADGE[status]}`}>
                    {t(`leadStatus.${status}`)}
                  </span>
                  <span className="text-xs font-semibold text-gray-400 dark:text-[#768292]">
                    {statusLeads.length}
                  </span>
                </div>
              </div>

              {/* Droppable column */}
              <Droppable droppableId={status} isDropDisabled={isTerminal}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`min-h-[60px] rounded-xl p-1.5 transition-colors ${
                      snapshot.isDraggingOver && !isTerminal
                        ? 'bg-indigo-50/70 dark:bg-indigo-900/10'
                        : 'bg-[#f4f6f9] dark:bg-[#0f1520]'
                    }`}
                  >
                    <div className="space-y-2">
                      {statusLeads.map((lead, index) => (
                        <Draggable
                          key={lead.id}
                          draggableId={lead.id}
                          index={index}
                          isDragDisabled={!canEdit || lead.status === 'converted'}
                        >
                          {(prov, snap) => (
                            <div
                              ref={prov.innerRef}
                              {...prov.draggableProps}
                              {...prov.dragHandleProps}
                              onClick={() => navigate(`/leads/${lead.id}`)}
                              className={`bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-xl p-3 cursor-pointer select-none transition-all ${
                                snap.isDragging
                                  ? 'shadow-xl rotate-1 border-indigo-400 dark:border-[#a5b4fc]'
                                  : 'hover:border-indigo-300 dark:hover:border-[#a5b4fc] hover:shadow-sm'
                              }`}
                            >
                              {/* Avatar + name */}
                              <div className="flex items-start gap-2.5 mb-2.5">
                                <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs font-bold ${avatarColor(lead.email || lead.full_name)}`}>
                                  {initials(lead.company_name || lead.full_name)}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] truncate leading-tight">
                                    {lead.company_name || lead.full_name}
                                  </p>
                                  {lead.company_name && (
                                    <p className="text-[11px] text-gray-400 dark:text-[#768292] truncate">{lead.full_name}</p>
                                  )}
                                </div>
                              </div>

                              {/* Contact info */}
                              <div className="space-y-1 mb-2.5">
                                {lead.email && (
                                  <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-[#9aa4b2]">
                                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                    </svg>
                                    <span className="truncate">{lead.email}</span>
                                  </div>
                                )}
                                {lead.phone && (
                                  <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-[#9aa4b2]">
                                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                                    </svg>
                                    <span>{lead.phone}</span>
                                  </div>
                                )}
                              </div>

                              {/* Footer: code + source + rep avatar */}
                              {lead.lead_code && (
                                <p className="text-[10px] font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] mb-1.5">
                                  {lead.lead_code}
                                </p>
                              )}
                              <div className="flex items-center justify-between pt-2 border-t border-[#f0f2f6] dark:border-[#1a2230]">
                                <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${SOURCE_BADGE[lead.source] || SOURCE_BADGE['walk-in']}`}>
                                  {t(`leadSource.${lead.source?.replace('-', '_')}`)}
                                </span>
                                {lead.assigned_rep && (
                                  <div
                                    className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 ${repColor(lead.assigned_rep)}`}
                                    title={lead.assigned_rep}
                                  >
                                    {lead.assigned_rep[0].toUpperCase()}
                                  </div>
                                )}
                              </div>
                              {lead.created_at && (
                                <p className="text-[10px] text-gray-400 dark:text-[#768292] mt-1.5">
                                  {new Date(lead.created_at).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                          )}
                        </Draggable>
                      ))}
                    </div>

                    {provided.placeholder}

                    {statusLeads.length === 0 && !snapshot.isDraggingOver && (
                      <div className="py-6 text-center text-xs text-gray-400 dark:text-[#768292]">
                        {isTerminal ? '—' : t('leads.dropHere')}
                      </div>
                    )}
                  </div>
                )}
              </Droppable>
            </div>
          )
        })}
      </div>
    </DragDropContext>
  )
}
