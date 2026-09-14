/**
 * exportMenuPaged.test.jsx — BUG-066.
 *
 * A screen that pages in the database holds one page, so it cannot hand the
 * export menu "all rows". It gives counts and a loader instead. Pinned here:
 * the options follow the counts, the rows are fetched only when an option is
 * chosen, and a failed load neither exports nothing silently nor crashes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import ExportMenu from '../components/ExportMenu'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o && 'count' in o ? `${k}:${o.count}` : k) }),
}))

afterEach(cleanup)

const open = () => fireEvent.click(screen.getByRole('button', { name: /common.export/ }))

describe('ExportMenu with counts and a loader', () => {
  it('shows each option with the database counts, and hides what adds nothing', () => {
    render(<ExportMenu allCount={888} filteredCount={888} selectedCount={0} loadRows={vi.fn()} onExport={vi.fn()} />)
    open()
    expect(screen.getByText('common.exportAllDesc:888')).toBeInTheDocument()
    expect(screen.queryByText(/exportFilteredDesc/)).not.toBeInTheDocument()
    expect(screen.queryByText(/exportSelectedDesc/)).not.toBeInTheDocument()
  })

  it('offers filtered and selected when they differ from all', () => {
    render(<ExportMenu allCount={888} filteredCount={12} selectedCount={3} loadRows={vi.fn()} onExport={vi.fn()} />)
    open()
    expect(screen.getByText('common.exportFilteredDesc:12')).toBeInTheDocument()
    expect(screen.getByText('common.exportSelectedDesc:3')).toBeInTheDocument()
  })

  it('loads the rows for the chosen scope, then exports them', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }]
    const loadRows = vi.fn().mockResolvedValue(rows)
    const onExport = vi.fn()
    render(<ExportMenu allCount={2} filteredCount={1} loadRows={loadRows} onExport={onExport} />)
    open()
    fireEvent.click(screen.getByText('common.exportFiltered'))
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(rows, 'filtered'))
    expect(loadRows).toHaveBeenCalledWith('filtered')
  })

  it('does not export when loading fails, and keeps the menu open to retry', async () => {
    const loadRows = vi.fn().mockRejectedValue(new Error('timeout'))
    const onExport = vi.fn()
    render(<ExportMenu allCount={5} loadRows={loadRows} onExport={onExport} />)
    open()
    fireEvent.click(screen.getByText('common.exportAll'))
    await waitFor(() => expect(loadRows).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('common.exportAll').closest('button')).not.toBeDisabled())
    expect(onExport).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('renders nothing when there is nothing to export', () => {
    const { container } = render(<ExportMenu allCount={0} loadRows={vi.fn()} onExport={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('still works the old way for screens that pass arrays', () => {
    const onExport = vi.fn()
    const all = [{ id: 1 }, { id: 2 }]
    render(<ExportMenu allRows={all} filteredRows={[all[0]]} onExport={onExport} />)
    open()
    fireEvent.click(screen.getByText('common.exportFiltered'))
    expect(onExport).toHaveBeenCalledWith([all[0]], 'filtered')
  })
})
