// React component(s) shared across the Pipeline module.
// Mirrors RMATickets/_shared.jsx's ProductSearchInput — page-scoped
// duplicate rather than a cross-folder import, matching this codebase's
// established per-page-folder pattern (not touching the working ticket
// form's copy to add this).

import React, { useState, useEffect, useRef } from 'react'

export function ProductSearchInput({ value, onChange, onSelectProduct, products = [], placeholder = '', className = '', inputClassName = '', 'aria-label': ariaLabel }) {
  const [query, setQuery] = useState(value || '')
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => setQuery(value || ''), [value])

  const filtered = query.trim().length >= 1
    ? products.filter((p) => p.product_name?.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : []

  useEffect(() => {
    const handler = (e) => {
      if (!containerRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        aria-label={ariaLabel}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          onChange?.(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (query.trim()) setOpen(true)
        }}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute top-full start-0 mt-1 w-full z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1 max-h-48 overflow-y-auto">
          {filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery(p.product_name)
                onSelectProduct(p)
                setOpen(false)
              }}
              className="w-full px-3 py-2 text-start text-sm hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] flex items-center justify-between gap-2"
            >
              <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate">{p.product_name}</span>
              {p.brand?.brand_name && <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0">{p.brand.brand_name}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
