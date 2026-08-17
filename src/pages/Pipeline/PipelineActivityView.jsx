import React, { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ACTIVITY_TYPE_SCHEDULABLE } from '../../lib/constants'

const STATE_CELL = {
  overdue: 'bg-red-500 text-white',
  today: 'bg-amber-500 text-white',
  planned: 'bg-emerald-500 text-white',
}

const ACT_ICONS = {
  call: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.654 1.328a.678.678 0 00-1.015-.063L1.605 2.3c-.483.484-.661 1.169-.45 1.77a17.568 17.568 0 004.168 6.608 17.569 17.569 0 006.608 4.168c.601.211 1.286.033 1.77-.45l1.034-1.034a.678.678 0 00-.063-1.015l-2.307-1.794a.678.678 0 00-.58-.122l-2.19.547a1.745 1.745 0 01-1.657-.459L5.482 8.062a1.745 1.745 0 01-.46-1.657l.548-2.19a.678.678 0 00-.122-.58L3.654 1.328z" />
    </svg>
  ),
  email: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M.05 3.555A2 2 0 012 2h12a2 2 0 011.95 1.555L8 8.414.05 3.555zM0 4.697v7.104l5.803-3.558L0 4.697zM6.761 8.83l-6.57 4.027A2 2 0 002 14h12a2 2 0 001.808-1.144l-6.57-4.027L8 9.586l-1.239-.757zm3.436-.586L16 11.801V4.697l-5.803 3.546z" />
    </svg>
  ),
  meeting: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.5 0a.5.5 0 01.5.5V1h8V.5a.5.5 0 011 0V1h1a2 2 0 012 2v11a2 2 0 01-2 2H2a2 2 0 01-2-2V3a2 2 0 012-2h1V.5a.5.5 0 01.5-.5zM1 4v10a1 1 0 001 1h12a1 1 0 001-1V4H1z" />
    </svg>
  ),
  whatsapp: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.601 2.326A7.854 7.854 0 007.994 0C3.627 0 .068 3.558.064 7.926c0 1.399.366 2.76 1.057 3.965L0 16l4.204-1.102a7.933 7.933 0 003.79.965h.004c4.368 0 7.926-3.558 7.93-7.93A7.898 7.898 0 0013.6 2.326zM7.994 14.521a6.573 6.573 0 01-3.356-.92l-.24-.144-2.494.654.666-2.433-.156-.251a6.56 6.56 0 01-1.007-3.505c0-3.626 2.957-6.584 6.591-6.584a6.56 6.56 0 014.66 1.931 6.557 6.557 0 011.928 4.66c-.004 3.639-2.961 6.592-6.592 6.592z" />
    </svg>
  ),
  task: (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
      <path d="M14 1a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1h12zM2 0a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V2a2 2 0 00-2-2H2z" />
      <path d="M10.97 4.97a.75.75 0 011.071 1.05l-3.992 4.99a.75.75 0 01-1.08.02L4.324 8.384a.75.75 0 111.06-1.06l2.094 2.093 3.473-4.425a.235.235 0 01.02-.022z" />
    </svg>
  ),
}

function getActivityState(acts) {
  if (acts.length === 0) return null
  const now = Date.now()
  const todayEnd = new Date().setHours(23, 59, 59, 999)
  let state = 'planned'
  let best = null
  for (const a of acts) {
    if (!a.due_date) {
      best = best || a
      continue
    }
    const due = new Date(a.due_date).getTime()
    if (due < now) return { state: 'overdue', activity: a }
    if (due <= todayEnd) {
      state = 'today'
      best = a
    } else if (state === 'planned') {
      best = best || a
    }
  }
  return best ? { state, activity: best } : null
}

export default function PipelineActivityView({ deals, stages, customerMap, activitiesByDeal }) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const stageMap = useMemo(() => Object.fromEntries(stages.map((s) => [s.id, s])), [stages])
  const activeDeals = useMemo(() => deals.filter((d) => d.status === 'open'), [deals])

  // Column header stats: done/total per activity type
  const colStats = useMemo(() => {
    const stats = {}
    for (const type of ACTIVITY_TYPE_SCHEDULABLE) {
      let done = 0
      let total = 0
      for (const deal of activeDeals) {
        const acts = (activitiesByDeal[deal.id] || []).filter((a) => a.type === type)
        total += acts.length
        done += acts.filter((a) => a.completed_at).length
      }
      stats[type] = { done, total }
    }
    return stats
  }, [activeDeals, activitiesByDeal])

  const BORDER = 'border-[#e6e9ef] dark:border-[#212a38]'

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={`border-b ${BORDER} bg-[#f8f9fb] dark:bg-[#0f1520]`}>
                <th
                  className={`px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] min-w-[240px] border-r ${BORDER}`}
                >
                  {t('pipeline.activityDeal')}
                </th>
                {ACTIVITY_TYPE_SCHEDULABLE.map((type) => {
                  const { done, total } = colStats[type] || { done: 0, total: 0 }
                  return (
                    <th key={type} className="px-4 py-3 text-center min-w-[110px]">
                      <div className="flex flex-col items-center gap-1.5">
                        <div className="flex items-center gap-1 text-[#6c6760] dark:text-[#9aa4b2]">
                          {ACT_ICONS[type]}
                          <span className="text-xs font-semibold capitalize">
                            {t(`pipeline.actType_${type}`)}
                          </span>
                        </div>
                        {total > 0 ? (
                          <div className="w-full max-w-[80px]">
                            <p className="text-[10px] text-[#6c6760] dark:text-[#9aa4b2] mb-0.5 text-center">
                              {done}/{total}
                            </p>
                            <div className="h-1 rounded-full bg-gray-200 dark:bg-[#212a38] overflow-hidden">
                              <div
                                className="h-full bg-emerald-500 transition-all"
                                style={{ width: total > 0 ? `${(done / total) * 100}%` : '0%' }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-[10px] text-[#6c6760] dark:text-[#768292]">—</span>
                        )}
                      </div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {activeDeals.length === 0 ? (
                <tr>
                  <td
                    colSpan={ACTIVITY_TYPE_SCHEDULABLE.length + 1}
                    className="px-4 py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]"
                  >
                    {t('pipeline.listEmpty')}
                  </td>
                </tr>
              ) : (
                activeDeals.map((deal, ri) => {
                  const cust = customerMap[deal.customer_id]
                  const stage = stageMap[deal.stage]
                  return (
                    <tr
                      key={deal.id}
                      onClick={() => navigate(`/pipeline/${deal.id}`)}
                      className={`border-t ${BORDER} cursor-pointer hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors ${
                        ri % 2 === 1 ? 'bg-[#fafbfc] dark:bg-[#0d1119]' : ''
                      }`}
                    >
                      {/* Deal info */}
                      <td className={`px-4 py-3 border-r ${BORDER}`}>
                        <p className="font-medium text-[#211f1b] dark:text-[#e8ebf0] text-xs line-clamp-1">
                          {deal.title}
                        </p>
                        <p className="text-[10px] text-[#6c6760] dark:text-[#9aa4b2] mt-0.5 line-clamp-1">
                          {cust?.company_name || cust?.contact_person || '—'}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {stage && (
                            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc] whitespace-nowrap">
                              {stage.name}
                            </span>
                          )}
                          {deal.value != null && (
                            <span className="text-[10px] text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap">
                              {Number(deal.value).toLocaleString()} {t('pipeline.currency')}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Activity cells */}
                      {ACTIVITY_TYPE_SCHEDULABLE.map((type) => {
                        const acts = (activitiesByDeal[deal.id] || []).filter(
                          (a) => a.type === type
                        )
                        const result = getActivityState(acts)
                        return (
                          <td key={type} className="px-2 py-3 text-center align-middle">
                            {result ? (
                              <div
                                className={`inline-flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg text-[10px] font-medium max-w-[96px] ${STATE_CELL[result.state]}`}
                              >
                                <span className="line-clamp-1 w-full text-center">
                                  {result.activity?.title || t(`pipeline.actType_${type}`)}
                                </span>
                                {result.activity?.due_date && (
                                  <span className="opacity-80 whitespace-nowrap">
                                    {new Date(result.activity.due_date).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[#6c6760] dark:text-[#768292] text-xs">—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div
          className={`px-4 py-3 border-t ${BORDER} flex items-center gap-5 text-xs text-[#6c6760] dark:text-[#9aa4b2] bg-[#f8f9fb] dark:bg-[#0f1520]`}
        >
          {[
            { key: 'overdue', cls: 'bg-red-500', label: t('pipeline.actOverdue') },
            { key: 'today', cls: 'bg-amber-500', label: t('pipeline.actToday') },
            { key: 'planned', cls: 'bg-emerald-500', label: t('pipeline.actPlanned') },
          ].map(({ key, cls, label }) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-sm inline-block ${cls}`} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
