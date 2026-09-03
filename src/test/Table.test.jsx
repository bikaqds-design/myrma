/**
 * Table.test.jsx — the shared data table.
 *
 * This component will back 72 call sites, so the properties pinned here are the
 * ones where being wrong is quiet or destructive rather than merely ugly:
 *
 *  - the empty row must span every column, including the selection column.
 *    A wrong colSpan is why hand-written tables drift out of alignment, and it
 *    is the specific thing a children-based API cannot get right;
 *  - "select all" must only ever select what is on screen. A selection that
 *    outlives its rows means a bulk delete hits records nobody can see;
 *  - numeric columns must be bidi-isolated, or `+8%` reads as `8%+` in Arabic —
 *    a different number, not a cosmetic problem;
 *  - a clickable row must be operable from the keyboard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react'
import Table from '../components/Table'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k }),
}))

afterEach(cleanup)

const ROWS = [
  { id: 'a', name: 'Widget', qty: 5, delta: '+8%' },
  { id: 'b', name: 'Gadget', qty: 12, delta: '-2%' },
]
const COLUMNS = [
  { key: 'name', header: 'Name', cell: (r) => r.name },
  { key: 'qty', header: 'Qty', align: 'end', numeric: true, cell: (r) => r.qty },
]

describe('rendering', () => {
  it('renders a header and a row per record', () => {
    render(<Table columns={COLUMNS} rows={ROWS} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Widget')).toBeInTheDocument()
    expect(screen.getByText('Gadget')).toBeInTheDocument()
  })

  it('aligns with logical classes, never physical ones', () => {
    const { container } = render(<Table columns={COLUMNS} rows={ROWS} />)
    const html = container.innerHTML
    expect(html).toContain('text-end')
    // text-right would not mirror in Arabic — the whole reason for the codemod.
    expect(html).not.toContain('text-right')
    expect(html).not.toContain('text-left')
  })

  /**
   * A signed number inside RTL text reorders without isolation. Doing this in
   * the primitive is what stops every caller having to remember.
   */
  it('bidi-isolates numeric cells', () => {
    const cols = [{ key: 'delta', header: 'Δ', numeric: true, cell: (r) => r.delta }]
    const { container } = render(<Table columns={cols} rows={ROWS} />)
    const isolated = container.querySelectorAll('[dir="ltr"]')
    expect(isolated.length).toBe(2)
    expect(isolated[0].textContent).toBe('+8%')
  })

  it('does not isolate ordinary text cells', () => {
    const cols = [{ key: 'name', header: 'Name', cell: (r) => r.name }]
    const { container } = render(<Table columns={cols} rows={ROWS} />)
    expect(container.querySelectorAll('[dir="ltr"]').length).toBe(0)
  })
})

describe('the empty row', () => {
  /**
   * The defect a children-based API cannot avoid: it cannot count its own
   * columns, so the empty row misaligns.
   */
  it('spans exactly the number of columns', () => {
    const { container } = render(<Table columns={COLUMNS} rows={[]} empty={{ title: 'None' }} />)
    expect(container.querySelector('td[colspan]').getAttribute('colspan')).toBe('2')
  })

  it('counts the selection column too', () => {
    const { container } = render(
      <Table columns={COLUMNS} rows={[]} selectable selected={new Set()} empty={{ title: 'None' }} />
    )
    expect(container.querySelector('td[colspan]').getAttribute('colspan')).toBe('3')
  })

  it('shows the empty state rather than a blank body', () => {
    render(<Table columns={COLUMNS} rows={[]} empty={{ title: 'Nothing to show' }} />)
    expect(screen.getByText('Nothing to show')).toBeInTheDocument()
  })
})

describe('loading', () => {
  it('renders skeleton rows matching the column count, not a spinner', () => {
    const { container } = render(<Table columns={COLUMNS} rows={[]} loading />)
    const skeletons = container.querySelectorAll('.animate-pulse')
    expect(skeletons.length).toBe(5 * COLUMNS.length)
  })

  it('does not show the empty state while loading', () => {
    render(<Table columns={COLUMNS} rows={[]} loading empty={{ title: 'Nothing to show' }} />)
    expect(screen.queryByText('Nothing to show')).not.toBeInTheDocument()
  })
})

describe('selection', () => {
  it('selects every visible row and nothing else', () => {
    const onChange = vi.fn()
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        selectable
        selected={new Set()}
        onSelectionChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText('table.selectAll'))
    expect([...onChange.mock.calls[0][0]]).toEqual(['a', 'b'])
  })

  /**
   * The destructive case. If "select all" merged into an existing selection,
   * a bulk action would reach rows filtered off the screen.
   */
  it('never carries rows that are not on screen into a select-all', () => {
    const onChange = vi.fn()
    render(
      <Table
        columns={COLUMNS}
        rows={[ROWS[0]]} // only 'a' visible
        selectable
        selected={new Set(['zzz-offscreen'])}
        onSelectionChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText('table.selectAll'))
    expect([...onChange.mock.calls[0][0]]).toEqual(['a'])
  })

  it('clears the selection when all visible rows are already selected', () => {
    const onChange = vi.fn()
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        selectable
        selected={new Set(['a', 'b'])}
        onSelectionChange={onChange}
      />
    )
    fireEvent.click(screen.getByLabelText('table.selectAll'))
    expect([...onChange.mock.calls[0][0]]).toEqual([])
  })

  it('toggles a single row without disturbing the rest', () => {
    const onChange = vi.fn()
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        selectable
        selected={new Set(['a'])}
        onSelectionChange={onChange}
      />
    )
    const boxes = screen.getAllByLabelText('table.selectRow')
    fireEvent.click(boxes[1])
    expect([...onChange.mock.calls[0][0]].sort()).toEqual(['a', 'b'])
  })
})

describe('row activation', () => {
  it('calls back on click', () => {
    const onRowClick = vi.fn()
    render(<Table columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />)
    fireEvent.click(screen.getByText('Widget'))
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0])
  })

  it('is operable from the keyboard', () => {
    const onRowClick = vi.fn()
    render(<Table columns={COLUMNS} rows={ROWS} onRowClick={onRowClick} />)
    const rows = screen.getAllByRole('button')
    rows[0].focus()
    fireEvent.keyDown(rows[0], { key: 'Enter' })
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0])
  })

  it('is not focusable when there is nothing to activate', () => {
    render(<Table columns={COLUMNS} rows={ROWS} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('does not activate the row when a selection box is clicked', () => {
    const onRowClick = vi.fn()
    render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        onRowClick={onRowClick}
        selectable
        selected={new Set()}
        onSelectionChange={() => {}}
      />
    )
    fireEvent.click(screen.getAllByLabelText('table.selectRow')[0])
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe('sorting', () => {
  it('announces the sorted column to assistive technology', () => {
    const cols = [{ key: 'name', header: 'Name', sortable: true, cell: (r) => r.name }]
    render(
      <Table
        columns={cols}
        rows={ROWS}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={() => {}}
      />
    )
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending')
  })

  it('toggles direction on the active column', () => {
    const onSortChange = vi.fn()
    const cols = [{ key: 'name', header: 'Name', sortable: true, cell: (r) => r.name }]
    render(
      <Table
        columns={cols}
        rows={ROWS}
        sort={{ key: 'name', direction: 'asc' }}
        onSortChange={onSortChange}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Name/ }))
    expect(onSortChange).toHaveBeenCalledWith({ key: 'name', direction: 'desc' })
  })

  it('leaves a header inert when the column is not sortable', () => {
    render(<Table columns={COLUMNS} rows={ROWS} onSortChange={() => {}} />)
    const header = screen.getAllByRole('columnheader')[0]
    expect(within(header).queryByRole('button')).toBeNull()
  })
})

describe('containment', () => {
  /**
   * A wide table must scroll inside its own wrapper. If it pushes the page
   * sideways, every other screen element moves with it.
   */
  it('scrolls within its own wrapper', () => {
    const { container } = render(<Table columns={COLUMNS} rows={ROWS} />)
    expect(container.firstChild.className).toContain('overflow-x-auto')
  })

  it('exposes a caption to screen readers only', () => {
    const { container } = render(<Table columns={COLUMNS} rows={ROWS} caption="Payments" />)
    const cap = container.querySelector('caption')
    expect(cap.textContent).toBe('Payments')
    expect(cap.className).toContain('sr-only')
  })
})
