import React, { useState, useMemo, lazy, Suspense } from 'react'
const BarcodeScannerModule = lazy(() => import('../components/BarcodeScanner'))
const BarcodeScanner = (props) => (
  <Suspense fallback={null}><BarcodeScannerModule {...props} /></Suspense>
)
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../lib/sentry'
import ConfirmDialog from '../components/ConfirmDialog'
import { Button, Spinner, PageHeader } from '../components/ui'
import { useAppearance } from '../contexts/AppearanceContext'
import EmptyState from '../components/EmptyState'
import { ROLES } from '../lib/constants'

// ─── Utility ──────────────────────────────────────────────────────────────────
function downloadCSV(rows, columns, filename) {
  if (!rows.length) {
    toast('No data to export')
    return
  }
  const headers = columns.map((c) => c.label)
  const escape = (v) => {
    const s = String(v ?? '').replace(/"/g, '""')
    return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s
  }
  const csv = [
    headers.join(','),
    ...rows.map((r) => columns.map((c) => escape(r[c.key] ?? '')).join(',')),
  ].join('\r\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  toast.success(`Exported ${rows.length} rows`)
}

const MIGRATION_SQL = `-- Run in Supabase SQL Editor to enable parts inventory:

CREATE TABLE IF NOT EXISTS parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_name TEXT NOT NULL,
  part_number TEXT,
  quantity INT NOT NULL DEFAULT 0,
  unit_cost NUMERIC(10,2) DEFAULT 0,
  supplier TEXT,
  reorder_level INT NOT NULL DEFAULT 5,
  location TEXT,
  notes TEXT,
  created_date TIMESTAMPTZ DEFAULT now(),
  updated_date TIMESTAMPTZ DEFAULT now()
);`

const EMPTY_FORM = {
  part_name: '',
  part_number: '',
  quantity: '',
  unit_cost: '',
  supplier: '',
  reorder_level: '',
  location: '',
  notes: '',
}

// ─── Sort Button ──────────────────────────────────────────────────────────────
function SortBtn({ label, sortKey, activeSortKey, activeSortDir, onSort }) {
  const isActive = activeSortKey === sortKey
  return (
    <button
      onClick={() => onSort(sortKey)}
      className="flex items-center gap-1 hover:text-gray-900 dark:text-[#e8ebf0] transition-colors"
    >
      {label}
      {isActive ? (
        activeSortDir === 'asc' ? (
          <svg
            className="w-3 h-3 text-indigo-600 ml-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg
            className="w-3 h-3 text-indigo-600 ml-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )
      ) : (
        <svg
          className="w-3 h-3 text-gray-300 ml-0.5"
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

// ─── Part Form Modal ──────────────────────────────────────────────────────────
function PartModal({ part, onSave, onClose, saving }) {
  const [form, setForm] = useState(
    part
      ? {
          part_name: part.part_name || '',
          part_number: part.part_number || '',
          quantity: String(part.quantity ?? ''),
          unit_cost: String(part.unit_cost ?? ''),
          supplier: part.supplier || '',
          reorder_level: String(part.reorder_level ?? ''),
          location: part.location || '',
          notes: part.notes || '',
        }
      : EMPTY_FORM
  )

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const [showScanner, setShowScanner] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.part_name.trim()) {
      toast.error('Part name is required')
      return
    }
    if (form.quantity === '' || isNaN(Number(form.quantity))) {
      toast.error('Quantity is required')
      return
    }
    if (form.unit_cost === '' || isNaN(Number(form.unit_cost))) {
      toast.error('Unit cost is required')
      return
    }
    if (form.reorder_level === '' || isNaN(Number(form.reorder_level))) {
      toast.error('Reorder level is required')
      return
    }
    onSave({
      part_name: form.part_name.trim(),
      part_number: form.part_number.trim() || null,
      quantity: parseInt(form.quantity, 10),
      unit_cost: parseFloat(form.unit_cost),
      supplier: form.supplier.trim() || null,
      reorder_level: parseInt(form.reorder_level, 10),
      location: form.location.trim() || null,
      notes: form.notes.trim() || null,
    })
  }

  const field =
    'w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent'
  const label = 'block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-[#121823] rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-[#212a38]">
          <h2 className="text-base font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {part ? 'Edit Part' : 'Add Part'}
          </h2>
          <button onClick={onClose} className="text-gray-500 dark:text-[#9aa4b2] hover:text-gray-600 dark:text-[#9aa4b2] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={label}>
                Part Name <span className="text-red-500">*</span>
              </label>
              <input
                value={form.part_name}
                onChange={(e) => set('part_name', e.target.value)}
                className={field}
                placeholder="e.g. Capacitor 100µF"
                required
              />
            </div>
            <div>
              <label className={label}>Part Number</label>
              <div className="relative">
                <input
                  value={form.part_number}
                  onChange={(e) => set('part_number', e.target.value)}
                  className={`${field} pr-9`}
                  placeholder="e.g. CAP-100UF-25V"
                />
                <button type="button" onClick={() => setShowScanner(true)}
                  title="Scan barcode / USB scanner"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-[#4a5568] hover:text-indigo-600 dark:hover:text-[#a5b4fc] transition-colors">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <rect x="2"  y="3" width="2" height="18" rx="0.5" />
                    <rect x="6"  y="3" width="1" height="18" rx="0.5" />
                    <rect x="9"  y="3" width="2" height="18" rx="0.5" />
                    <rect x="13" y="3" width="1" height="18" rx="0.5" />
                    <rect x="16" y="3" width="3" height="18" rx="0.5" />
                    <rect x="21" y="3" width="1" height="18" rx="0.5" />
                  </svg>
                </button>
              </div>
              {showScanner && (
                <BarcodeScanner
                  onScan={(value) => { set('part_number', value); setShowScanner(false) }}
                  onClose={() => setShowScanner(false)}
                />
              )}
            </div>
            <div>
              <label className={label}>Location</label>
              <input
                value={form.location}
                onChange={(e) => set('location', e.target.value)}
                className={field}
                placeholder="e.g. Shelf A-3"
              />
            </div>
            <div>
              <label className={label}>
                Quantity <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0"
                value={form.quantity}
                onChange={(e) => set('quantity', e.target.value)}
                className={field}
                placeholder="0"
                required
              />
            </div>
            <div>
              <label className={label}>
                Reorder Level <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0"
                value={form.reorder_level}
                onChange={(e) => set('reorder_level', e.target.value)}
                className={field}
                placeholder="5"
                required
              />
            </div>
            <div>
              <label className={label}>
                Unit Cost ($) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.unit_cost}
                onChange={(e) => set('unit_cost', e.target.value)}
                className={field}
                placeholder="0.00"
                required
              />
            </div>
            <div>
              <label className={label}>Supplier</label>
              <input
                value={form.supplier}
                onChange={(e) => set('supplier', e.target.value)}
                className={field}
                placeholder="Supplier name"
              />
            </div>
            <div className="col-span-2">
              <label className={label}>Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={2}
                className={`${field} resize-none`}
                placeholder="Optional notes…"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#e8ebf0] border border-gray-200 dark:border-[#212a38] rounded-xl hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors"
            >
              Cancel
            </button>
            <Button type="submit" loading={saving}>
              {part ? 'Save Changes' : 'Add Part'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function PartsInventory({
  currentUserRole,
  currentUserEmail: _currentUserEmail,
  currentUserPermissions,
}) {
  const { formatDate: _formatDate } = useAppearance()

  const canDo = (action) => {
    if (currentUserRole === ROLES.SUPER_ADMIN || currentUserRole === ROLES.ADMIN) return true
    return currentUserPermissions?.parts?.[action] === true
  }
  const canAdd = canDo('create') || currentUserRole === ROLES.MANAGER
  const canEdit = canDo('edit') || currentUserRole === ROLES.MANAGER
  const canDelete = currentUserRole === ROLES.SUPER_ADMIN || currentUserRole === ROLES.ADMIN
  const canAdjust = canAdd || currentUserRole === ROLES.TECHNICIAN || canDo('adjust_stock')
  const canExport = canAdd || canDo('export')

  const queryClient = useQueryClient()
  const { data: partsResult, isLoading: loading, refetch } = useQuery({
    queryKey: ['parts'],
    queryFn: () => db.parts.list(),
  })
  const tableMissing = partsResult?.missing ?? false
  const parts = useMemo(() => partsResult?.data ?? [], [partsResult])

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('part_name')
  const [sortDir, setSortDir] = useState('asc')
  const [showLowOnly, setShowLowOnly] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editingPart, setEditingPart] = useState(null)
  const [adjusting, setAdjusting] = useState({})
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })

  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  const handleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const lowStockParts = useMemo(() => parts.filter((p) => p.quantity <= p.reorder_level), [parts])

  const filtered = useMemo(() => {
    let list = [...parts]
    if (showLowOnly) list = list.filter((p) => p.quantity <= p.reorder_level)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (p) => p.part_name?.toLowerCase().includes(q) || p.part_number?.toLowerCase().includes(q)
      )
    }
    return list.sort((a, b) => {
      let av, bv
      if (sortKey === 'quantity') {
        av = a.quantity ?? 0
        bv = b.quantity ?? 0
      } else {
        av = (a.part_name || '').toLowerCase()
        bv = (b.part_name || '').toLowerCase()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [parts, search, showLowOnly, sortKey, sortDir])

  const saveMutation = useMutation({
    mutationFn: (data) =>
      editingPart ? db.parts.update(editingPart.id, data) : db.parts.create(data),
    onSuccess: () => {
      toast.success(editingPart ? 'Part updated' : 'Part added')
      setShowModal(false)
      setEditingPart(null)
      queryClient.invalidateQueries({ queryKey: ['parts'] })
    },
    onError: (err) => {
      captureException(err, { page: 'PartsInventory', context: 'savePart' })
      toast.error(err.message || 'Failed to save part')
    },
  })
  const saving = saveMutation.isPending

  const deleteMutation = useMutation({
    mutationFn: (id) => db.parts.delete(id),
    onSuccess: () => {
      toast.success('Part deleted')
      queryClient.invalidateQueries({ queryKey: ['parts'] })
    },
    onError: (err) => {
      captureException(err, { page: 'PartsInventory', context: 'deletePart' })
      toast.error('Failed to delete part')
    },
  })

  const adjustMutation = useMutation({
    mutationFn: ({ id, delta }) => db.parts.adjustQuantity(id, delta),
    onSuccess: (updated, { id, delta, name }) => {
      queryClient.setQueryData(['parts'], (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          data: prev.data.map((p) => (p.id === id ? { ...p, quantity: updated.quantity } : p)),
        }
      })
      if (delta > 0) toast.success(`+${delta} added to ${name}`)
      else toast.success(`${delta} removed from ${name}`)
    },
    onError: (err) => {
      captureException(err, { page: 'PartsInventory', context: 'adjustQuantity' })
      toast.error('Failed to adjust quantity')
    },
    onSettled: (_d, _e, { id }) => {
      setAdjusting((a) => ({ ...a, [id]: false }))
    },
  })

  const handleSave = (data) => saveMutation.mutate(data)

  const handleDelete = (part) => {
    openConfirm(
      'Delete Part',
      `Are you sure you want to delete "${part.part_name}"? This cannot be undone.`,
      () => {
        closeConfirm()
        deleteMutation.mutate(part.id)
      }
    )
  }

  const handleAdjust = (part, delta) => {
    if (adjusting[part.id]) return
    setAdjusting((a) => ({ ...a, [part.id]: true }))
    adjustMutation.mutate({ id: part.id, delta, name: part.part_name })
  }

  const handleExport = () => {
    const rows = filtered.map((p) => ({
      part_name: p.part_name || '',
      part_number: p.part_number || '',
      quantity: p.quantity ?? 0,
      unit_cost: p.unit_cost ?? 0,
      supplier: p.supplier || '',
      reorder_level: p.reorder_level ?? 0,
      location: p.location || '',
      notes: p.notes || '',
    }))
    const columns = [
      { key: 'part_name', label: 'Part Name' },
      { key: 'part_number', label: 'Part #' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'unit_cost', label: 'Unit Cost' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'reorder_level', label: 'Reorder Level' },
      { key: 'location', label: 'Location' },
      { key: 'notes', label: 'Notes' },
    ]
    downloadCSV(rows, columns, `parts-inventory-${new Date().toISOString().split('T')[0]}.csv`)
  }

  // ─── Loading ────────────────────────────────────────────────────────────────
  if (loading)
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse bg-gray-200 rounded-lg" />
          <div className="h-4 w-64 animate-pulse bg-gray-200 rounded-lg" />
        </div>
        <div className="h-64 animate-pulse bg-gray-100 dark:bg-[#1a2230] rounded-xl" />
      </div>
    )

  // ─── Migration Banner ────────────────────────────────────────────────────────
  if (tableMissing)
    return (
      <div className="max-w-3xl mx-auto mt-10 bg-amber-50 border border-amber-200 rounded-2xl p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 bg-amber-200 rounded-xl flex items-center justify-center flex-shrink-0">
            <svg
              className="w-5 h-5 text-amber-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-amber-900">Database Setup Required</h2>
            <p className="text-sm text-amber-800 mt-0.5">
              The <code className="font-mono bg-amber-100 px-1 rounded">parts</code> table is not
              set up yet. Run the SQL below in your Supabase SQL Editor, then click Retry.
            </p>
          </div>
        </div>
        <pre className="bg-amber-100 border border-amber-200 rounded-xl p-4 text-xs text-amber-900 overflow-x-auto whitespace-pre">
          {MIGRATION_SQL}
        </pre>
        <button
          onClick={() => refetch()}
          className="px-5 py-2 bg-amber-600 text-white rounded-xl text-sm font-medium hover:bg-amber-700 transition-colors"
        >
          Retry
        </button>
      </div>
    )

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader title="Parts Inventory" subtitle="Manage parts and components stock levels">
        {canExport && (
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            Export CSV
          </button>
        )}
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Refresh
        </button>
        {canAdd && (
          <Button
            onClick={() => {
              setEditingPart(null)
              setShowModal(true)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add Part
          </Button>
        )}
      </PageHeader>

      {/* Low Stock Banner */}
      {lowStockParts.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl">
          <svg
            className="w-5 h-5 text-amber-600 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm text-amber-800 flex-1">
            <span className="font-semibold">
              {lowStockParts.length} part{lowStockParts.length !== 1 ? 's are' : ' is'} low on stock
            </span>
            {' — '}
            <button
              onClick={() => setShowLowOnly((v) => !v)}
              className="underline text-amber-700 hover:text-amber-900 font-medium"
            >
              {showLowOnly ? 'Show all parts' : 'Show low stock only'}
            </button>
          </p>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-0 max-w-sm">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search part name or part number…"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <svg
            className="w-4 h-4 text-gray-500 dark:text-[#9aa4b2] absolute left-2.5 top-1/2 -translate-y-1/2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <button
          onClick={() => setShowLowOnly((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 border rounded-lg text-sm transition-colors ${showLowOnly ? 'bg-amber-50 border-amber-400 text-amber-700' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]'}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {showLowOnly ? 'Showing Low Stock' : 'Low Stock'}
          {!showLowOnly && lowStockParts.length > 0 && (
            <span className="w-4 h-4 bg-amber-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">
              {lowStockParts.length}
            </span>
          )}
        </button>
        <span className="text-sm text-gray-500 dark:text-[#9aa4b2] ml-auto">
          {filtered.length} part{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38]">
          <EmptyState
            preset="inventory"
            title="No parts found"
            description={
              search || showLowOnly ? 'No parts match your filters' : 'No parts in inventory yet'
            }
            action={
              canAdd && !search && !showLowOnly
                ? () => {
                    setEditingPart(null)
                    setShowModal(true)
                  }
                : undefined
            }
            actionLabel="Add First Part"
          />
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    <SortBtn
                      label="Part Name"
                      sortKey="part_name"
                      activeSortKey={sortKey}
                      activeSortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    Part #
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    <SortBtn
                      label="Quantity"
                      sortKey="quantity"
                      activeSortKey={sortKey}
                      activeSortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    Unit Cost
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    Supplier
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    Location
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                    Reorder Level
                  </th>
                  {canAdjust && (
                    <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                      Adjust
                    </th>
                  )}
                  {(canEdit || canDelete) && (
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-[#212a38]">
                {filtered.map((part) => {
                  const isLow = part.quantity <= part.reorder_level
                  return (
                    <tr
                      key={part.id}
                      className={`hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors ${isLow ? 'bg-amber-50/40' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {isLow && (
                            <span
                              title="Low stock"
                              className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0"
                            />
                          )}
                          <span className="font-medium text-gray-900 dark:text-[#e8ebf0]">{part.part_name}</span>
                        </div>
                        {part.notes && (
                          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5 truncate max-w-[200px]">
                            {part.notes}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] font-mono text-xs">
                        {part.part_number || '—'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${isLow ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400' : 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'}`}
                        >
                          {part.quantity ?? 0}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 dark:text-[#e8ebf0] font-medium tabular-nums">
                        ${Number(part.unit_cost ?? 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2]">{part.supplier || '—'}</td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2]">{part.location || '—'}</td>
                      <td className="px-4 py-3 text-center text-gray-500 dark:text-[#9aa4b2]">
                        {part.reorder_level ?? 0}
                      </td>
                      {canAdjust && (
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => handleAdjust(part, -1)}
                              disabled={adjusting[part.id] || part.quantity <= 0}
                              title="Remove 1"
                              aria-label="Remove 1"
                              className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 dark:border-[#212a38] text-gray-500 dark:text-[#9aa4b2] hover:bg-red-50 hover:border-red-300 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              <svg
                                className="w-3.5 h-3.5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M20 12H4"
                                />
                              </svg>
                            </button>
                            {adjusting[part.id] && <Spinner size="sm" />}
                            <button
                              onClick={() => handleAdjust(part, 1)}
                              disabled={adjusting[part.id]}
                              title="Add 1"
                              aria-label="Add 1"
                              className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 dark:border-[#212a38] text-gray-500 dark:text-[#9aa4b2] hover:bg-green-50 hover:border-green-300 hover:text-green-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                              <svg
                                className="w-3.5 h-3.5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 4v16m8-8H4"
                                />
                              </svg>
                            </button>
                          </div>
                        </td>
                      )}
                      {(canEdit || canDelete) && (
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {canEdit && (
                              <button
                                onClick={() => {
                                  setEditingPart(part)
                                  setShowModal(true)
                                }}
                                title="Edit part"
                                aria-label="Edit part"
                                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                              >
                                <svg
                                  className="w-3.5 h-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                  />
                                </svg>
                              </button>
                            )}
                            {canDelete && (
                              <button
                                onClick={() => handleDelete(part)}
                                title="Delete part"
                                aria-label="Delete part"
                                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:text-red-600 hover:bg-red-50 transition-colors"
                              >
                                <svg
                                  className="w-3.5 h-3.5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                  />
                                </svg>
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Summary footer */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between text-xs text-gray-500 dark:text-[#9aa4b2] px-1">
          <span>Total parts: {filtered.length}</span>
          <span>
            Total stock value: $
            {filtered.reduce((s, p) => s + (p.quantity ?? 0) * (p.unit_cost ?? 0), 0).toFixed(2)}
          </span>
        </div>
      )}

      {/* Part Modal */}
      {showModal && (
        <PartModal
          part={editingPart}
          onSave={handleSave}
          onClose={() => {
            setShowModal(false)
            setEditingPart(null)
          }}
          saving={saving}
        />
      )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel="Delete"
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  )
}
