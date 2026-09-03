import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Ltr } from './ui'
import EmptyState from './EmptyState'

/**
 * The shared data table.
 *
 * The audit found 72 hand-written `<table>` blocks across 50 files and no
 * primitive at all (UX-GLOBAL-007). They agreed on the shape — styled thead,
 * `px-4 py-3` cells, a `colSpan` empty row — and disagreed on everything a user
 * notices: which columns get end-alignment, whether an empty result explains
 * itself, whether loading shows anything, whether numbers survive Arabic.
 *
 * ── Why columns are data, not children ──────────────────────────────────────
 *
 * A `<Table>{children}</Table>` API cannot know how many columns there are, so
 * it cannot render a correct `colSpan` for the empty row, cannot build skeleton
 * rows that match the real layout, and cannot offer selection without the
 * caller threading a checkbox into every row. Describing columns as data lets
 * the component own all four, which is the whole point of having one.
 *
 * ── Alignment is logical ─────────────────────────────────────────────────────
 *
 * `align: 'end'`, never 'right'. In Arabic the numeric column belongs on the
 * left, and `text-end` resolves per direction while `text-right` does not.
 *
 * ── numeric columns are bidi-isolated ────────────────────────────────────────
 *
 * `numeric: true` wraps the value in <Ltr>. A signed or punctuated number
 * inside RTL text reorders — `+8%` renders as `8%+`, which reads as a different
 * value. Doing it here means every migrated table gets it without each caller
 * having to remember (the fix existed and was used 6 times before this).
 */

const ALIGN = { start: 'text-start', end: 'text-end', center: 'text-center' }

export default function Table({
  columns,
  rows,
  rowKey,
  /** Renders skeleton rows matching the column layout rather than a spinner. */
  loading = false,
  /** Preset name or { title, description, action, actionLabel } for EmptyState. */
  empty,
  /** Row selection. `selected` is a Set of row keys. */
  selectable = false,
  selected,
  onSelectionChange,
  /** Called with the row when a row is activated. Adds keyboard support. */
  onRowClick,
  /** Sorting: { key, direction } plus a handler. Columns opt in with sortable. */
  sort,
  onSortChange,
  /**
   * Totals row. An array of cells: { span, content, align, numeric }.
   * Spans must sum to the column count — the component checks, because the
   * hand-written versions carried comments like "checkbox + # + code = 6" and
   * a colSpan counted by hand goes silently wrong the day a column is added.
   */
  footer,
  stickyHeader = false,
  /** Screen-reader description of the table. */
  caption,
  className = '',
  rowClassName,
}) {
  const { t } = useTranslation()
  const cols = useMemo(
    () => (selectable ? [{ key: '__select', width: '1%' }, ...columns] : columns),
    [columns, selectable]
  )

  // A footer whose spans do not cover the table misaligns every cell after the
  // gap, and does it silently. Fail loudly in development instead.
  if (import.meta.env.DEV && footer) {
    const span = footer.reduce((n, c) => n + (c.span || 1), 0)
    if (span !== cols.length) {
      console.error(
        `Table: footer spans ${span} column(s) but the table has ${cols.length}. ` +
          'The totals row will not line up.'
      )
    }
  }

  const keyOf = (row, i) => (rowKey ? rowKey(row) : (row.id ?? i))
  const visibleKeys = (rows ?? []).map(keyOf)
  const allSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected?.has(k))

  const toggleAll = () => {
    if (!onSelectionChange) return
    // Only ever operates on what is on screen. A selection that outlives the
    // rows it was made on means a bulk action hits invisible records.
    onSelectionChange(allSelected ? new Set() : new Set(visibleKeys))
  }

  const toggleOne = (k) => {
    if (!onSelectionChange) return
    const next = new Set(selected)
    next.has(k) ? next.delete(k) : next.add(k)
    onSelectionChange(next)
  }

  const headCell =
    'px-4 py-3 text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase tracking-wide'
  const bodyCell = 'px-4 py-3 text-[#211f1b] dark:text-[#e8ebf0]'

  const renderHeader = (col) => {
    if (col.key === '__select') {
      return (
        <th scope="col" className={headCell} style={{ width: col.width }}>
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            aria-label={t('table.selectAll')}
            className="w-4 h-4 rounded border-gray-300 cursor-pointer"
          />
        </th>
      )
    }

    const align = ALIGN[col.align] || ALIGN.start
    if (!col.sortable || !onSortChange) {
      return (
        <th scope="col" className={`${headCell} ${align}`} style={{ width: col.width }}>
          {col.header}
        </th>
      )
    }

    const active = sort?.key === col.key
    const dir = active ? sort.direction : null
    return (
      <th
        scope="col"
        // aria-sort belongs on the header cell, not the button, or a screen
        // reader announces the control instead of the column state.
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`${headCell} ${align}`}
        style={{ width: col.width }}
      >
        <button
          type="button"
          onClick={() => onSortChange({ key: col.key, direction: active && dir === 'asc' ? 'desc' : 'asc' })}
          className="inline-flex items-center gap-1 uppercase hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
        >
          {col.header}
          <span aria-hidden="true" className={active ? '' : 'opacity-30'}>
            {active && dir === 'desc' ? '▾' : '▴'}
          </span>
        </button>
      </th>
    )
  }

  const renderCell = (col, row, i) => {
    if (col.key === '__select') {
      const k = keyOf(row, i)
      return (
        <td className={bodyCell} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!selected?.has(k)}
            onChange={() => toggleOne(k)}
            aria-label={t('table.selectRow')}
            className="w-4 h-4 rounded border-gray-300 cursor-pointer"
          />
        </td>
      )
    }
    const align = ALIGN[col.align] || ALIGN.start
    const value = col.cell ? col.cell(row, i) : row[col.key]
    return (
      <td className={`${bodyCell} ${align} ${col.cellClassName || ''}`}>
        {col.numeric ? <Ltr>{value}</Ltr> : value}
      </td>
    )
  }

  return (
    // The wrapper scrolls, not the page. A wide table must never push the whole
    // layout sideways on a narrow screen.
    <div className={`w-full overflow-x-auto ${className}`}>
      <table className="w-full text-sm border-collapse">
        {caption && <caption className="sr-only">{caption}</caption>}

        <thead className={stickyHeader ? 'sticky top-0 z-10' : ''}>
          <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
            {cols.map((col) => (
              <React.Fragment key={col.key}>{renderHeader(col)}</React.Fragment>
            ))}
          </tr>
        </thead>

        <tbody>
          {loading ? (
            // Skeletons shaped like the real rows, so the layout does not jump
            // when data arrives.
            Array.from({ length: 5 }).map((_, r) => (
              <tr key={`sk-${r}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                {cols.map((col) => (
                  <td key={col.key} className={bodyCell}>
                    <div className="h-3 rounded bg-[#e6e9ef] dark:bg-[#1a2230] animate-pulse" />
                  </td>
                ))}
              </tr>
            ))
          ) : (rows ?? []).length === 0 ? (
            <tr>
              {/* colSpan is why columns are data: a children-based table cannot
                  count its own columns and the empty row misaligns. */}
              <td colSpan={cols.length}>
                {typeof empty === 'string' ? (
                  <EmptyState preset={empty} />
                ) : (
                  <EmptyState {...(empty || {})} />
                )}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const k = keyOf(row, i)
              const clickable = !!onRowClick
              return (
                <tr
                  key={k}
                  onClick={clickable ? () => onRowClick(row) : undefined}
                  // A clickable row must be reachable without a mouse. role and
                  // tabIndex make it focusable; Enter and Space match how a
                  // button behaves elsewhere.
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onRowClick(row)
                          }
                        }
                      : undefined
                  }
                  className={`border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0 hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] ${
                    clickable ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500' : ''
                  } ${rowClassName ? rowClassName(row) : ''}`}
                >
                  {cols.map((col) => (
                    <React.Fragment key={col.key}>{renderCell(col, row, i)}</React.Fragment>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>

        {footer && (rows ?? []).length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              {footer.map((cell, i) => (
                <td
                  key={i}
                  colSpan={cell.span || 1}
                  className={`px-4 py-2.5 text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0] ${
                    ALIGN[cell.align] || ALIGN.start
                  }`}
                >
                  {cell.numeric ? <Ltr>{cell.content}</Ltr> : cell.content}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}
