import React, { useState, useEffect, useRef, useCallback } from 'react'
import { db } from '../api/supabaseClient'

const ICONS = {
  ticket: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  ),
  product: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  ),
}

const TYPE_COLORS = {
  ticket:  'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  product: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
}

const TYPE_LABELS = { ticket: 'Ticket', product: 'Product' }

export default function CommandPalette({ open, onClose, onSelectTicket, onSelectProduct }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const searchTimeout = useRef(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback(async (q) => {
    if (!q.trim() || q.length > 100) { setResults([]); setLoading(false); return }
    setLoading(true)
    try {
      const safe = q.replace(/[%,()]/g, ' ').trim()
      if (!safe) { setResults([]); setLoading(false); return }
      const [ticketsRes, productsRes] = await Promise.all([
        db.supabase
          .from('rma_tickets')
          .select('id,rma_number,ticket_status,customer_name,priority')
          .or(`rma_number.ilike.%${safe}%,customer_name.ilike.%${safe}%,ticket_status.ilike.%${safe}%`)
          .limit(6),
        db.supabase
          .from('products')
          .select('id,product_name,sku,brand:brands(brand_name)')
          .or(`product_name.ilike.%${safe}%,sku.ilike.%${safe}%`)
          .limit(4),
      ])
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
      onClose()
      if (item.type === 'ticket') onSelectTicket?.(item.raw)
      else if (item.type === 'product') onSelectProduct?.(item.raw)
    },
    [onClose, onSelectTicket, onSelectProduct]
  )

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && results[activeIndex]) select(results[activeIndex])
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, results, activeIndex, select, onClose])

  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  // Group results by type for section headers
  const ticketResults = results.filter((r) => r.type === 'ticket')
  const productResults = results.filter((r) => r.type === 'product')

  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl mx-4 bg-white dark:bg-[#121823] rounded-2xl shadow-2xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">

        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#f0f2f6] dark:border-[#1a2230]">
          <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tickets and products…"
            className="flex-1 text-sm outline-none bg-transparent text-[#211f1b] dark:text-[#e8ebf0] placeholder-[#a09d99] dark:placeholder-[#4a5568]"
          />
          {loading ? (
            <svg className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          ) : (
            <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-[#6c6760] dark:text-[#9aa4b2] bg-[#f0f2f6] dark:bg-[#1a2230] rounded border border-[#e6e9ef] dark:border-[#212a38] font-mono">Esc</kbd>
          )}
        </div>

        {/* Results */}
        {results.length > 0 && (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-2">
            {ticketResults.length > 0 && (
              <>
                <li className="px-4 pt-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#a09d99] dark:text-[#4a5568]">Tickets</span>
                </li>
                {ticketResults.map((item, idx) => {
                  const globalIdx = results.indexOf(item)
                  return (
                    <li key={`ticket-${item.id}`} onMouseEnter={() => setActiveIndex(globalIdx)} onClick={() => select(item)}
                      className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${globalIdx === activeIndex ? 'bg-[#f8f9fb] dark:bg-[#0f1520]' : ''}`}>
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${TYPE_COLORS.ticket}`}>
                        {ICONS.ticket}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate block">{item.primary}</span>
                        {item.secondary && <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] truncate block">{item.secondary}</span>}
                      </div>
                      {item.badge && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 bg-[#f0f2f6] dark:bg-[#1a2230] text-[#6c6760] dark:text-[#9aa4b2]">
                          {item.badge}
                        </span>
                      )}
                    </li>
                  )
                })}
              </>
            )}
            {productResults.length > 0 && (
              <>
                <li className={`px-4 pb-1 ${ticketResults.length > 0 ? 'pt-3 mt-1 border-t border-[#f0f2f6] dark:border-[#1a2230]' : 'pt-2'}`}>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#a09d99] dark:text-[#4a5568]">Products</span>
                </li>
                {productResults.map((item) => {
                  const globalIdx = results.indexOf(item)
                  return (
                    <li key={`product-${item.id}`} onMouseEnter={() => setActiveIndex(globalIdx)} onClick={() => select(item)}
                      className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${globalIdx === activeIndex ? 'bg-[#f8f9fb] dark:bg-[#0f1520]' : ''}`}>
                      <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${TYPE_COLORS.product}`}>
                        {ICONS.product}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-[#211f1b] dark:text-[#e8ebf0] truncate block">{item.primary}</span>
                        {item.secondary && <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] truncate block">{item.secondary}</span>}
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${TYPE_COLORS.product}`}>
                        {TYPE_LABELS.product}
                      </span>
                    </li>
                  )
                })}
              </>
            )}
          </ul>
        )}

        {query.trim() && !loading && results.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
              No results for <span className="font-medium text-[#211f1b] dark:text-[#e8ebf0]">"{query}"</span>
            </p>
          </div>
        )}

        {/* Keyboard hint */}
        {!query.trim() && (
          <div className="px-4 py-3 flex items-center gap-4 text-xs text-[#6c6760] dark:text-[#9aa4b2] border-t border-[#f0f2f6] dark:border-[#1a2230]">
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-[#f0f2f6] dark:bg-[#1a2230] rounded border border-[#e6e9ef] dark:border-[#212a38] font-mono">↑↓</kbd> navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-[#f0f2f6] dark:bg-[#1a2230] rounded border border-[#e6e9ef] dark:border-[#212a38] font-mono">↵</kbd> open
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-[#f0f2f6] dark:bg-[#1a2230] rounded border border-[#e6e9ef] dark:border-[#212a38] font-mono">Esc</kbd> close
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
