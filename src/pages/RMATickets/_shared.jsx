// React component(s) shared across the RMATickets module.
// Pure helpers and constants live in _utils.js (no React imports needed there).

import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useProductSearch } from '../../lib/useLookups'

const SHORTCUTS = [
  { key: 'N', descKey: 'shortcuts.newTicket' },
  { key: '/', descKey: 'shortcuts.focusSearch' },
  { key: '?', descKey: 'shortcuts.showHelp' },
  { key: 'Esc', descKey: 'shortcuts.closePanel' },
]

export function ShortcutsHelp({ onClose }) {
  const { t } = useTranslation()

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-6 w-80 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
            {t('shortcuts.title')}
          </h2>
          <button
            onClick={onClose}
            className="text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] transition-colors"
            aria-label={t('common.close')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ul className="space-y-3">
          {SHORTCUTS.map(({ key, descKey }) => (
            <li key={key} className="flex items-center justify-between">
              <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t(descKey)}</span>
              <kbd className="px-2 py-0.5 text-xs font-mono font-semibold bg-[#f4f6f9] dark:bg-[#0f1520] border border-[#e6e9ef] dark:border-[#212a38] rounded text-[#211f1b] dark:text-[#e8ebf0]">
                {key}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// onSelectProduct fires only when a catalog row is picked from the dropdown,
// and carries the whole product so the caller can keep its id. Typing instead
// fires onChange alone — the caller treats that as "no longer a catalog
// product" and clears any id it was holding.
export function ProductSearchInput({ value, onChange, onSelectProduct, brandId, excludeService = false, searchEnabled = true, placeholder = 'Search or type product name…', className = '', inputClassName = '', 'aria-label': ariaLabel }) {
  const [query, setQuery] = useState(value || '')
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  // Sync external value changes (e.g. reset)
  useEffect(() => { setQuery(value || '') }, [value])

  // Matches come from the database (BUG-066). This filtered a `products` array
  // the caller passed in — the whole catalogue, loaded by every screen that had
  // a product field, and capped by the Data API at 1 000 rows. `brandId` and
  // `excludeService` narrow the search where the caller used to pre-filter.
  const { results: filtered } = useProductSearch(query, { limit: 8, brandId, excludeService, enabled: open && searchEnabled })

  useEffect(() => {
    const handler = (e) => { if (!containerRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        aria-label={ariaLabel}
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true) }}
        onFocus={() => { if (query.trim()) setOpen(true) }}
        // Escape closes the suggestion list only. A surrounding dialog checks
        // aria-expanded and stays open (TicketForm, warehouse finding 3).
        onKeyDown={(e) => { if (e.key === 'Escape' && open) setOpen(false) }}
        aria-expanded={open && filtered.length > 0}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute top-full start-0 mt-1 w-full z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1 max-h-48 overflow-y-auto">
          {filtered.map((p) => (
            <button key={p.id} type="button"
              onClick={() => { setQuery(p.product_name); onSelectProduct ? onSelectProduct(p) : onChange(p.product_name); setOpen(false) }}
              className="w-full px-3 py-2 text-start text-sm hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] flex items-center justify-between gap-2">
              <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate">{p.product_name}</span>
              {p.brand?.brand_name && <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0">{p.brand.brand_name}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SortableHeader({ label, sortKey, sortConfig, onSort }) {
  const isActive = sortConfig.key === sortKey
  const ariaSort = isActive
    ? sortConfig.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none'
  return (
    <button
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label}`}
      aria-sort={ariaSort}
      className="flex items-center gap-1 hover:text-gray-900 transition-colors"
    >
      <span>{label}</span>
      {isActive ? (
        sortConfig.direction === 'asc' ? (
          <svg
            className="w-3.5 h-3.5 text-indigo-600 ms-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg
            className="w-3.5 h-3.5 text-indigo-600 ms-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )
      ) : (
        <svg
          className="w-3.5 h-3.5 text-gray-300 ms-0.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
      )}
    </button>
  )
}
