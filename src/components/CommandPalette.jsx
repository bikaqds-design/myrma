import React, { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../api/supabaseClient'
import { useTranslation } from 'react-i18next'

const STATUS_COLORS = {
  Open: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  'In Progress': 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300',
  Pending: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
  'On Hold': 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300',
  Completed: 'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300',
  Closed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  Cancelled: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
}
const statusBadge = (s) => STATUS_COLORS[s] || 'bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]'

export default function CommandPalette({ onSelectTicket, onSelectProduct, inputRef: externalRef }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef(null)
  const internalRef = useRef(null)
  const inputEl = externalRef || internalRef
  const searchTimeout = useRef(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (!containerRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const search = useCallback(async (q) => {
    if (!q.trim() || q.length < 2) { setResults([]); setLoading(false); return }
    setLoading(true)
    try {
      const safe = q.replace(/[%,()]/g, ' ').trim()

      // Run tickets + brand lookup in parallel
      const [ticketsRes, brandsRes] = await Promise.all([
        supabase
          .from('rma_tickets')
          .select('id,rma_number,ticket_status,customer_name,priority')
          .or(`rma_number.ilike.%${safe}%,customer_name.ilike.%${safe}%,ticket_status.ilike.%${safe}%`)
          .limit(6),
        supabase
          .from('brands')
          .select('id')
          .ilike('brand_name', `%${safe}%`)
          .limit(20),
      ])

      // Build products OR including any matching brand IDs
      const brandIds = (brandsRes.data || []).map((b) => b.id)
      const orParts = [`product_name.ilike.%${safe}%`, `sku.ilike.%${safe}%`]
      if (brandIds.length) orParts.push(`brand_id.in.(${brandIds.join(',')})`)

      const productsRes = await supabase
        .from('products')
        .select('id,product_name,sku,brand:brands(brand_name)')
        .or(orParts.join(','))
        .limit(5)

      setResults([
        ...(ticketsRes.data || []).map((t) => ({
          type: 'ticket',
          id: t.id,
          primary: t.rma_number,
          secondary: [t.customer_name, t.priority].filter(Boolean).join(' · '),
          badge: t.ticket_status,
          raw: t,
        })),
        ...(productsRes.data || []).map((p) => ({
          type: 'product',
          id: p.id,
          primary: p.product_name,
          secondary: [p.brand?.brand_name, p.sku ? 'SKU: ' + p.sku : ''].filter(Boolean).join(' · '),
          raw: p,
        })),
      ])
      setActiveIndex(0)
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    clearTimeout(searchTimeout.current)
    searchTimeout.current = setTimeout(() => search(query), 220)
    return () => clearTimeout(searchTimeout.current)
  }, [query, search])

  const select = useCallback(
    (item) => {
      setOpen(false)
      setQuery('')
      setResults([])
      if (item.type === 'ticket') onSelectTicket?.(item.raw)
      else if (item.type === 'product') onSelectProduct?.(item.raw)
    },
    [onSelectTicket, onSelectProduct]
  )

  // Keyboard navigation while dropdown is open
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') { setOpen(false); inputEl.current?.blur(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && results[activeIndex]) select(results[activeIndex])
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, results, activeIndex, select, inputEl])

  const ticketResults = results.filter((r) => r.type === 'ticket')
  const productResults = results.filter((r) => r.type === 'product')

  return (
    <div ref={containerRef} className="relative">
      {/* Search input bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#f4f6f9] dark:bg-[#0f1520] border border-[#e6e9ef] dark:border-[#212a38] focus-within:border-[#4338ca] dark:focus-within:border-[#a5b4fc] transition-colors w-80">
        <svg className="w-3.5 h-3.5 text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputEl}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={t('commandPalette.searchPlaceholder')}
          className="flex-1 text-xs outline-none bg-transparent text-[#211f1b] dark:text-[#e8ebf0] placeholder-[#a09d99] dark:placeholder-[#4a5568] min-w-0"
        />
        {loading ? (
          <svg className="w-3 h-3 text-[#6c6760] dark:text-[#9aa4b2] animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        ) : (
          <kbd className="text-[10px] px-1.5 py-0.5 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded font-mono text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0">⌘K</kbd>
        )}
      </div>

      {/* Dropdown */}
      {open && (query.trim().length >= 2) && (
        <div className="absolute left-0 top-full mt-1.5 w-96 bg-white dark:bg-[#121823] rounded-xl shadow-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden z-[200]">
          {results.length > 0 ? (
            <ul className="max-h-80 overflow-y-auto py-1.5">
              {ticketResults.length > 0 && (
                <>
                  <li className="px-4 pt-2 pb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[#a09d99] dark:text-[#4a5568]">{t('commandPalette.ticketsSection')}</span>
                  </li>
                  {ticketResults.map((item) => {
                    const idx = results.indexOf(item)
                    return (
                      <li key={`t-${item.id}`} onMouseEnter={() => setActiveIndex(idx)} onClick={() => select(item)}
                        className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${idx === activeIndex ? 'bg-[#f8f9fb] dark:bg-[#0f1520]' : ''}`}>
                        <div className="w-6 h-6 rounded-md bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3.5 h-3.5 text-blue-700 dark:text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate block">{item.primary}</span>
                          {item.secondary && <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] truncate block">{item.secondary}</span>}
                        </div>
                        {item.badge && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${statusBadge(item.badge)}`}>{item.badge}</span>
                        )}
                      </li>
                    )
                  })}
                </>
              )}
              {productResults.length > 0 && (
                <>
                  <li className={`px-4 pb-1 ${ticketResults.length > 0 ? 'pt-3 mt-1 border-t border-[#f0f2f6] dark:border-[#1a2230]' : 'pt-2'}`}>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[#a09d99] dark:text-[#4a5568]">{t('commandPalette.productsSection')}</span>
                  </li>
                  {productResults.map((item) => {
                    const idx = results.indexOf(item)
                    return (
                      <li key={`p-${item.id}`} onMouseEnter={() => setActiveIndex(idx)} onClick={() => select(item)}
                        className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${idx === activeIndex ? 'bg-[#f8f9fb] dark:bg-[#0f1520]' : ''}`}>
                        <div className="w-6 h-6 rounded-md bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center flex-shrink-0">
                          <svg className="w-3.5 h-3.5 text-purple-700 dark:text-purple-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate block">{item.primary}</span>
                          {item.secondary && <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] truncate block">{item.secondary}</span>}
                        </div>
                      </li>
                    )
                  })}
                </>
              )}
            </ul>
          ) : !loading ? (
            <div className="py-8 text-center">
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                {t('commandPalette.noResults', { query })}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
