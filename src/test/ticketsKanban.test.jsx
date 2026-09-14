/**
 * ticketsKanban.test.jsx — BUG-066.
 *
 * Board columns now arrive loaded separately: some cards plus the true count.
 * Pinned: the header shows the count, not the number of cards on screen; "Show
 * more" appears only while cards are missing and asks for that column; and an
 * empty column says it is loading rather than "No tickets" while it loads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { KanbanView } from '../pages/RMATickets/_kanban'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}))

afterEach(cleanup)

const card = (id, status) => ({ id, rma_number: `RMA-${id}`, customer_name: `Customer ${id}`, ticket_status: status })

const board = (columns, onLoadMore = vi.fn()) =>
  render(<KanbanView columns={columns} pageSize={50} onLoadMore={onLoadMore} onViewDetails={vi.fn()} canQuickEdit={() => false} />)

describe('KanbanView with columns loaded from the database', () => {
  it('shows the full count in the header, not the cards on screen', () => {
    board([{ status: 'Open', tickets: [card('1', 'Open'), card('2', 'Open')], count: 120, loading: false }])
    expect(screen.getByText('120')).toBeInTheDocument()
  })

  it('offers "Show more" while cards are missing, for that column', () => {
    const onLoadMore = vi.fn()
    board(
      [
        { status: 'Open', tickets: [card('1', 'Open')], count: 70, loading: false },
        { status: 'Closed', tickets: [card('2', 'Closed')], count: 1, loading: false },
      ],
      onLoadMore
    )
    const more = screen.getAllByRole('button', { name: /kanbanShowMore/ })
    expect(more).toHaveLength(1)
    expect(more[0].textContent).toContain('"next":50')
    fireEvent.click(more[0])
    expect(onLoadMore).toHaveBeenCalledWith('Open')
  })

  it('says a column is loading instead of claiming it is empty', () => {
    board([
      { status: 'Open', tickets: [], count: 0, loading: true },
      { status: 'Closed', tickets: [], count: 0, loading: false },
    ])
    expect(screen.getByText('common.loading')).toBeInTheDocument()
    expect(screen.getByText('tickets.kanbanNoTickets')).toBeInTheDocument()
  })
})
