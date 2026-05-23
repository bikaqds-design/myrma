import React, { useState, useEffect, useRef, useCallback } from 'react'
import { db } from '../api/supabaseClient'

const ICONS = {
  ticket: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  ),
  customer: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  ),
  product: (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  ),
}

const TYPE_COLORS = {
  ticket: 'bg-blue-100 text-blue-700',
  customer: 'bg-green-100 text-green-700',
  product: 'bg-purple-100 text-purple-700',
}

const TYPE_LABELS = { ticket: 'Ticket', customer: 'Customer', product: 'Product' }

export default function CommandPalette({ open, onClose, onSelectTicket, onSelectCustomer, onSelectProduct }) {
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
    if (!q.trim()) { setResults([]); setLoading(false); return }
    if (q.length > 100) { setResults([]); setLoading(false); return }
    setLoading(true)
    try {
      const safe = q.replace(/[%,()]/g, ' ').trim()
      if (!safe) { setResults([]); setLoading(false); return }
      const [tickets, customers, products] = await Promise.all([
        db.supabase.from('rma_tickets').select('id,rma_number,ticket_status,customer_name').or(`rma_number.ilike.%${safe}%,customer_name.ilike.%${safe}%`).limit(5),
        db.supabase.from('customers').select('id,company_name,contact_person,email,mobile').or(`company_name.ilike.%${safe}%,contact_person.ilike.%${safe}%,email.ilike.%${safe}%,mobile.ilike.%${safe}%`).limit(5),
        db.supabase.from('products').select('id,product_name,sku,brand:brands(brand_name)').or(`product_name.ilike.%${safe}%,sku.ilike.%${safe}%`).limit(5),
      ])
      const r = [
        ...(tickets.data || []).map(t => ({ type: 'ticket', id: t.id, primary: t.rma_number, secondary: t.customer_name || '', badge: t.ticket_status, raw: t })),
        ...(customers.data || []).map(c => ({ type: 'customer', id: c.id, primary: c.company_name || c.contact_person || '—', secondary: c.email || c.mobile || '', raw: c })),
        ...(products.data || []).map(p => ({ type: 'product', id: p.id, primary: p.product_name, secondary: `${p.brand?.brand_name || ''} ${p.sku ? '· ' + p.sku : ''}`.trim(), raw: p })),
      ]
      setResults(r)
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

  const select = useCallback((item) => {
    onClose()
    if (item.type === 'ticket') onSelectTicket?.(item.raw)
    else if (item.type === 'customer') onSelectCustomer?.(item.raw)
    else if (item.type === 'product') onSelectProduct?.(item.raw)
  }, [onClose, onSelectTicket, onSelectCustomer, onSelectProduct])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && results[activeIndex]) select(results[activeIndex])
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, results, activeIndex, select, onClose])

  useEffect(() => {
    const el = listRef.current?.children[activeIndex]
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl mx-4 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search tickets, customers, products…"
            className="flex-1 text-sm outline-none bg-transparent text-gray-900 placeholder-gray-400"
          />
          {loading && (
            <svg className="w-4 h-4 text-gray-400 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs text-gray-400 bg-gray-100 rounded border border-gray-200 font-mono">Esc</kbd>
        </div>

        {results.length > 0 && (
          <ul ref={listRef} className="max-h-80 overflow-y-auto py-2">
            {results.map((item, idx) => (
              <li
                key={`${item.type}-${item.id}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => select(item)}
                className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${idx === activeIndex ? 'bg-gray-50' : ''}`}
              >
                <span className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${TYPE_COLORS[item.type]}`}>
                  {ICONS[item.type]}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-900 truncate block">{item.primary}</span>
                  {item.secondary && <span className="text-xs text-gray-500 truncate block">{item.secondary}</span>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${TYPE_COLORS[item.type]}`}>
                  {TYPE_LABELS[item.type]}
                </span>
              </li>
            ))}
          </ul>
        )}

        {query.trim() && !loading && results.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm text-gray-500">No results for <span className="font-medium text-gray-700">"{query}"</span></p>
          </div>
        )}

        {!query.trim() && (
          <div className="px-4 py-3 flex items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">↑↓</kbd> navigate</span>
            <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">↵</kbd> select</span>
            <span className="flex items-center gap-1"><kbd className="px-1.5 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">Esc</kbd> close</span>
          </div>
        )}
      </div>
    </div>
  )
}
