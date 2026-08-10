import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd'
import { TICKET_STATUS, TICKET_STATUS_LIST } from '../../lib/constants'
import { getStatusColor, getPriorityColor, formatDate } from './_utils'

// Happy-path "next step" for the swipe quick action. Pending/On Hold/Closed/Cancelled
// have no single obvious next status, so they get no swipe action — tap-to-open only.
const NEXT_STATUS = {
  [TICKET_STATUS.OPEN]: TICKET_STATUS.IN_PROGRESS,
  [TICKET_STATUS.IN_PROGRESS]: TICKET_STATUS.COMPLETED,
  [TICKET_STATUS.COMPLETED]: TICKET_STATUS.CLOSED,
}
const REVEAL_WIDTH = 92

function KanbanCard({ ticket, onViewDetails, onQuickStatusChange, canQuickEdit, nextStatus, isDragging: isBoardDragging = false }) {
  const { t } = useTranslation()
  const [dragX, setDragX] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const touchStartX = useRef(0)

  // Swipe-to-reveal and the board's drag both want the touch stream and both
  // translate the card. The library only starts a touch drag after a long
  // press, so a quick horizontal swipe still belongs to us — but once it has
  // taken over, our transform has to stand down or the two fight over the same
  // element.
  const canSwipe = Boolean(nextStatus) && Boolean(canQuickEdit?.(ticket)) && !isBoardDragging

  const handleTouchStart = (e) => {
    if (!canSwipe) return
    touchStartX.current = e.touches[0].clientX
    setIsDragging(true)
  }
  const handleTouchMove = (e) => {
    if (!isDragging || !canSwipe) return
    const delta = e.touches[0].clientX - touchStartX.current
    const base = revealed ? -REVEAL_WIDTH : 0
    setDragX(Math.min(0, Math.max(-REVEAL_WIDTH, base + delta)))
  }
  const handleTouchEnd = () => {
    if (!isDragging) return
    setIsDragging(false)
    const shouldReveal = dragX < -REVEAL_WIDTH / 2
    setRevealed(shouldReveal)
    setDragX(shouldReveal ? -REVEAL_WIDTH : 0)
  }

  const handleQuickAction = (e) => {
    e.stopPropagation()
    onQuickStatusChange?.(ticket, nextStatus)
    setRevealed(false)
    setDragX(0)
  }

  const handleCardClick = () => {
    if (revealed) {
      setRevealed(false)
      setDragX(0)
      return
    }
    onViewDetails(ticket)
  }

  return (
    <div className="relative overflow-hidden rounded-[10px]">
      {canSwipe && (
        <button
          onClick={handleQuickAction}
          style={{ width: REVEAL_WIDTH }}
          className="absolute inset-y-0 right-0 flex items-center justify-center px-2 bg-[#4338ca] text-white text-[10px] font-medium text-center leading-tight"
        >
          {t('tickets.markAs', { status: t(`statusValues.${nextStatus}`, nextStatus) })}
        </button>
      )}
      <button
        onClick={handleCardClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          // While the board is dragging this card, the library owns its
          // position — leave the transform alone rather than adding ours to it.
          transform: isBoardDragging ? undefined : `translateX(${dragX}px)`,
          transition: isDragging ? 'none' : 'transform 0.2s ease',
        }}
        className={`relative w-full text-left bg-white dark:bg-[#121823] border rounded-[10px] p-3 transition-colors ${
          isBoardDragging
            ? 'border-[#4338ca] dark:border-[#a5b4fc] shadow-lg'
            : 'border-[#e6e9ef] dark:border-[#212a38] hover:border-[#4338ca] dark:hover:border-[#a5b4fc]'
        }`}
      >
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono text-xs font-medium text-[#4338ca] dark:text-[#a5b4fc] truncate">
            {ticket.rma_number}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ms-1 ${getPriorityColor(ticket.priority)}`}>
            {t(`priorityValues.${ticket.priority}`, ticket.priority)}
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
    </div>
  )
}

export function KanbanView({ tickets, onViewDetails, onQuickStatusChange, canQuickEdit }) {
  const { t } = useTranslation()

  // Any status the data actually uses that TICKET_STATUS_LIST does not know
  // about. Without these, such tickets match no column and the board silently
  // drops them — they stay visible in the list view, so the two views disagree
  // with no indication why. Found during QA: two legacy tickets carry 'New',
  // leaving the board showing 12 of 14.
  //
  // Not a hypothetical to guard against, either: 20260531 deliberately removed
  // the ticket_status CHECK constraint so deployments can configure their own
  // statuses, which makes unknown values an expected condition rather than
  // corruption. The board has to show them, and showing them under their own
  // heading is what makes the drift noticeable enough to clean up.
  const knownStatuses = new Set(TICKET_STATUS_LIST)
  const unknownStatuses = [
    ...new Set(
      tickets
        .map((tk) => tk.ticket_status)
        .filter((s) => s && !knownStatuses.has(s))
    ),
  ].sort()

  const columns = [...TICKET_STATUS_LIST, ...unknownStatuses].map((status) => ({
    status,
    tickets: tickets.filter((tk) => tk.ticket_status === status),
  }))

  // Dropping a card on another column is just a status change, so it reuses the
  // same handler the swipe quick-action calls. Reordering within a column means
  // nothing here — the board has no manual ordering — so a same-column drop is
  // a no-op rather than a write.
  const handleDragEnd = (result) => {
    const { source, destination, draggableId } = result
    if (!destination || destination.droppableId === source.droppableId) return
    const ticket = tickets.find((tk) => tk.id === draggableId)
    if (!ticket || !canQuickEdit?.(ticket)) return
    onQuickStatusChange?.(ticket, destination.droppableId)
  }

  return (
    // flex + min-width per column + overflow-x-auto is CSS-only responsive: columns share
    // space evenly on wide desktop screens, and naturally overflow into horizontal scroll
    // (with snap points, like a swipe-between-statuses mobile board) once the viewport can't
    // fit every column at its minimum width — no JS breakpoint logic needed.
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2" style={{ minHeight: '400px' }}>
        {columns.map(({ status, tickets: colTickets }) => (
          <div key={status} className="flex-1 min-w-[200px] flex flex-col snap-start">
            <div className="flex items-center justify-between px-1 py-2 mb-2">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full truncate ${getStatusColor(status)}`}>
                {t(`statusValues.${status}`, status)}
              </span>
              <span className="text-xs text-[#9aa4b2] font-medium tabular-nums ms-1 flex-shrink-0">{colTickets.length}</span>
            </div>
            <Droppable droppableId={status}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={`flex-1 space-y-2 overflow-y-auto rounded-lg p-1 transition-colors ${
                    snapshot.isDraggingOver ? 'bg-indigo-50 dark:bg-indigo-900/10' : ''
                  }`}
                  style={{ maxHeight: 'calc(100vh - 340px)' }}
                >
                  {colTickets.length === 0 && !snapshot.isDraggingOver ? (
                    <p className="text-[11px] text-[#a09d99] dark:text-[#4a5568] text-center py-6">
                      {t('tickets.kanbanNoTickets')}
                    </p>
                  ) : (
                    colTickets.map((tk, index) => (
                      <Draggable
                        key={tk.id}
                        draggableId={tk.id}
                        index={index}
                        isDragDisabled={!canQuickEdit?.(tk)}
                      >
                        {(dragProvided, dragSnapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            {...dragProvided.dragHandleProps}
                          >
                            <KanbanCard
                              ticket={tk}
                              onViewDetails={onViewDetails}
                              onQuickStatusChange={onQuickStatusChange}
                              canQuickEdit={canQuickEdit}
                              nextStatus={NEXT_STATUS[status]}
                              isDragging={dragSnapshot.isDragging}
                            />
                          </div>
                        )}
                      </Draggable>
                    ))
                  )}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>
        ))}
      </div>
    </DragDropContext>
  )
}
