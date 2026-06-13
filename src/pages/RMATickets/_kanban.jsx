import { useTranslation } from 'react-i18next'
import { TICKET_STATUS_LIST } from '../../lib/constants'
import { getStatusColor, getPriorityColor, formatDate } from './_utils'

function KanbanCard({ ticket, onViewDetails }) {
  return (
    <button
      onClick={() => onViewDetails(ticket)}
      className="w-full text-left bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[10px] p-3 hover:border-[#4338ca] dark:hover:border-[#a5b4fc] transition-colors"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] truncate">
          {ticket.rma_number}
        </span>
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ms-1 ${getPriorityColor(ticket.priority)}`}>
          {ticket.priority}
        </span>
      </div>
      <p className="text-xs font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate">
        {ticket.customer_name}
      </p>
      {ticket.assigned_technician && (
        <p className="text-[10px] text-[#6c6760] dark:text-[#9aa4b2] truncate mt-1">
          {ticket.assigned_technician}
        </p>
      )}
      {ticket.due_date && (
        <p className="text-[10px] text-[#a09d99] dark:text-[#4a5568] mt-1">
          {formatDate(ticket.due_date)}
        </p>
      )}
    </button>
  )
}

export function KanbanView({ tickets, onViewDetails }) {
  const { t } = useTranslation()

  const columns = TICKET_STATUS_LIST.map((status) => ({
    status,
    tickets: tickets.filter((tk) => tk.ticket_status === status),
  }))

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`, minHeight: '400px' }}>
      {columns.map(({ status, tickets: colTickets }) => (
        <div key={status} className="flex flex-col min-w-0">
          <div className="flex items-center justify-between px-1 py-2 mb-2">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full truncate ${getStatusColor(status)}`}>
              {t(`statusValues.${status}`, status)}
            </span>
            <span className="text-xs text-[#9aa4b2] font-medium tabular-nums ms-1 flex-shrink-0">{colTickets.length}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 340px)' }}>
            {colTickets.length === 0 ? (
              <p className="text-[11px] text-[#a09d99] dark:text-[#4a5568] text-center py-6">
                {t('tickets.kanbanNoTickets')}
              </p>
            ) : (
              colTickets.map((tk) => (
                <KanbanCard key={tk.id} ticket={tk} onViewDetails={onViewDetails} />
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
