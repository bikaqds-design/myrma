// React component(s) shared across the RMATickets module.
// Pure helpers and constants live in _utils.js (no React imports needed there).

import React, { useState, useEffect, useRef } from 'react'

export function ProductSearchInput({ value, onChange, products = [], placeholder = 'Search or type product name…', className = '', inputClassName = '' }) {
  const [query, setQuery] = useState(value || '')
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  // Sync external value changes (e.g. reset)
  useEffect(() => { setQuery(value || '') }, [value])

  const filtered = query.trim().length >= 1
    ? products.filter((p) => p.product_name?.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : []

  useEffect(() => {
    const handler = (e) => { if (!containerRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true) }}
        onFocus={() => { if (query.trim()) setOpen(true) }}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-full z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1 max-h-48 overflow-y-auto">
          {filtered.map((p) => (
            <button key={p.id} type="button"
              onClick={() => { setQuery(p.product_name); onChange(p.product_name); setOpen(false) }}
              className="w-full px-3 py-2 text-left text-sm hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] flex items-center justify-between gap-2">
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
            className="w-3.5 h-3.5 text-indigo-600 ml-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg
            className="w-3.5 h-3.5 text-indigo-600 ml-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )
      ) : (
        <svg
          className="w-3.5 h-3.5 text-gray-300 ml-0.5"
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
