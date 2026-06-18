import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

const ACTIVITY_CFG = {
  ticket_created:      { bg: 'bg-blue-500/10',     dot: 'bg-blue-500' },
  ticket_updated:      { bg: 'bg-[#e6e9ef] dark:bg-[#212a38]', dot: 'bg-[#6c6760] dark:bg-[#9aa4b2]' },
  status_changed:      { bg: 'bg-amber-500/10',    dot: 'bg-amber-500' },
  priority_changed:    { bg: 'bg-rose-500/10',     dot: 'bg-rose-500' },
  technician_assigned: { bg: 'bg-violet-500/10',   dot: 'bg-violet-500' },
  attachment_added:    { bg: 'bg-sky-500/10',      dot: 'bg-sky-500' },
  resolution_saved:       { bg: 'bg-emerald-500/10',  dot: 'bg-emerald-500' },
  resolution_deleted:     { bg: 'bg-rose-500/10',     dot: 'bg-rose-400' },
  product_status_changed: { bg: 'bg-cyan-500/10',     dot: 'bg-cyan-500' },
  product_updated:        { bg: 'bg-sky-500/10',      dot: 'bg-sky-500' },
  time_entry_added:       { bg: 'bg-emerald-500/10',  dot: 'bg-emerald-500' },
  time_entry_deleted:     { bg: 'bg-[#e6e9ef] dark:bg-[#212a38]', dot: 'bg-[#a09d99] dark:bg-[#4a5568]' },
  comment_deleted:        { bg: 'bg-[#e6e9ef] dark:bg-[#212a38]', dot: 'bg-[#a09d99] dark:bg-[#4a5568]' },
}

function TypeIcon({ type, actionType }) {
  if (type === 'comment')
    return (
      <div className="w-7 h-7 rounded-full bg-[#4338ca] dark:bg-[#a5b4fc]/20 flex items-center justify-center flex-shrink-0">
        <svg className="w-3.5 h-3.5 text-white dark:text-[#a5b4fc]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>
    )
  if (type === 'time')
    return (
      <div className="w-7 h-7 rounded-full bg-emerald-500/10 dark:bg-emerald-400/10 flex items-center justify-center flex-shrink-0">
        <svg className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
    )
  const cfg = ACTIVITY_CFG[actionType] || ACTIVITY_CFG.ticket_updated
  return (
    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${cfg.bg}`}>
      <div className={`w-2.5 h-2.5 rounded-full ${cfg.dot}`} />
    </div>
  )
}

export default function ActivityTimeline({ ticketComments, timeEntries, activityLog }) {
  const { t } = useTranslation()

  const entries = useMemo(
    () =>
      [
        ...ticketComments.map((c) => ({ ...c, _type: 'comment' })),
        ...timeEntries.map((e) => ({ ...e, _type: 'time' })),
        ...activityLog.map((a) => ({ ...a, _type: 'activity' })),
      ].sort((a, b) => new Date(b.created_date) - new Date(a.created_date)),
    [ticketComments, timeEntries, activityLog]
  )

  const translateDetail = (actionType, details) => {
    if (!details || !details.includes('|')) return details
    const [from, to] = details.split('|')
    if (actionType === 'status_changed') {
      return `${t(`statusValues.${from}`, from)} → ${t(`statusValues.${to}`, to)}`
    }
    if (actionType === 'priority_changed') {
      return `${t(`priorityValues.${from}`, from)} → ${t(`priorityValues.${to}`, to)}`
    }
    return `${from} → ${to}`
  }

  const typeLabel = (entry) => {
    const who = <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">{entry.author_name || entry.user_email || 'System'}</span>
    if (entry._type === 'comment')
      return <span>{who} {t('ticketDrawer.timelineCommented')}</span>
    if (entry._type === 'time') {
      const h = Math.floor((entry.duration_min || 0) / 60)
      const m = (entry.duration_min || 0) % 60
      return <span>{who} {t('ticketDrawer.timelineTimeLogged')} <span className="font-medium text-emerald-600 dark:text-emerald-400">{h}h {m}m</span></span>
    }
    return <span>{who} {entry.details || entry.action_type?.replace(/_/g, ' ')}</span>
  }

  return (
    <div className="border-t border-gray-200 dark:border-[#212a38] pt-5">
      <h3 className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-4">
        {t('ticketDrawer.timeline')}
      </h3>
      {entries.length === 0 ? (
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">{t('ticketDrawer.timelineEmpty')}</p>
      ) : (
        <div className="relative">
          <div className="absolute start-3.5 top-4 bottom-0 w-px bg-[#e6e9ef] dark:bg-[#212a38]" />
          <div className="space-y-4">
            {entries.map((entry, i) => {
              const ts = new Date(entry.created_date)
              const dateStr = ts.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
              const timeStr = ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
              return (
                <div key={entry.id ?? i} className="relative flex gap-3">
                  <TypeIcon type={entry._type} actionType={entry.action_type} />
                  <div className="flex-1 min-w-0 pt-0.5">
                    <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] leading-snug">
                      {typeLabel(entry)}
                    </p>
                    {entry._type === 'comment' && entry.comment_text && (
                      <p className="mt-1 text-xs text-[#211f1b] dark:text-[#e8ebf0] bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg px-3 py-2 line-clamp-3 whitespace-pre-wrap">
                        {entry.comment_text}
                      </p>
                    )}
                    {entry._type === 'time' && entry.notes && (
                      <p className="mt-1 text-xs text-[#6c6760] dark:text-[#9aa4b2] italic truncate">{entry.notes}</p>
                    )}
                    {entry._type === 'activity' && entry.details && (
                      <p className="mt-1 text-xs text-[#6c6760] dark:text-[#9aa4b2] italic truncate">{translateDetail(entry.action_type, entry.details)}</p>
                    )}
                    <p className="mt-1 text-[11px] text-[#a09d99] dark:text-[#4a5568]">{dateStr} · {timeStr}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
