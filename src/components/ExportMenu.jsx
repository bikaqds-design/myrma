import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * ExportMenu — the standard three-option export dropdown.
 *
 *   Export All       always shown
 *   Export Filtered  only when a search/filter is narrowing the list
 *   Export Selected  only when rows are checked
 *
 * The pattern was introduced on Leads and Pipeline (see the "System-wide Design
 * Unification Sprint" notes in MASTER_UPGRADE_PLAN.md) as ~65 lines of inline
 * JSX, copied between them. Purchasing needed it third, and copying a block that
 * size a third time is exactly how the warehouse-destination filter ended up
 * written four times and wrong in all four. So it lives here once.
 *
 * Leads has since been migrated onto it. Pipeline turned out never to have had
 * an inline copy, so this is now the only implementation in the app.
 *
 * Callers own the data and the export itself; this component only decides which
 * options make sense and hands back the chosen row set.
 */
export default function ExportMenu({
  /** Every row, ignoring search/filters. */
  allRows = [],
  /** Rows after search/filters. Pass the same array as allRows if nothing narrows them. */
  filteredRows = null,
  /** Currently checked rows. */
  selectedRows = [],
  /** Called with the chosen array and a filename-friendly scope: 'all' | 'filtered' | 'selected'. */
  onExport,
  /** Overrides the button label; defaults to common.export. */
  label = null,
  /** Namespace to read exportAll/exportFiltered/… from, so page-specific wording still works. */
  ns = 'common',
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const filtered = filteredRows ?? allRows
  // Only worth offering when it differs from "all" — otherwise it is the same export twice.
  const showFiltered = filtered.length !== allRows.length
  const showSelected = selectedRows.length > 0

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  if (allRows.length === 0) return null

  const choose = (rows, scope) => {
    setOpen(false)
    onExport?.(rows, scope)
  }

  const itemCls =
    'w-full px-4 py-2.5 text-left hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] flex items-center gap-3'
  const dividerCls = 'border-t border-[#f0f2f6] dark:border-[#1a2230]'

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] transition-colors"
      >
        <svg className="w-4 h-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        {label ?? t('common.export')}
        <svg className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] z-20 py-1.5"
        >
          <button role="menuitem" onClick={() => choose(allRows, 'all')} className={itemCls}>
            <svg className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <div>
              <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t(`${ns}.exportAll`)}</div>
              <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t(`${ns}.exportAllDesc`, { count: allRows.length })}</div>
            </div>
          </button>

          {showFiltered && (
            <button role="menuitem" onClick={() => choose(filtered, 'filtered')} className={`${itemCls} ${dividerCls}`}>
              <svg className="w-4 h-4 text-indigo-500 dark:text-[#a5b4fc] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
              </svg>
              <div>
                <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t(`${ns}.exportFiltered`)}</div>
                <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t(`${ns}.exportFilteredDesc`, { count: filtered.length })}</div>
              </div>
            </button>
          )}

          {showSelected && (
            <button role="menuitem" onClick={() => choose(selectedRows, 'selected')} className={`${itemCls} ${dividerCls}`}>
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <div>
                <div className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0]">{t(`${ns}.exportSelected`)}</div>
                <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t(`${ns}.exportSelectedDesc`, { count: selectedRows.length })}</div>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
