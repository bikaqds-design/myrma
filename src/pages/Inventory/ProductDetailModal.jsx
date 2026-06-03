import React, { useState, useEffect } from 'react'
import { supabase, db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { Spinner } from '../../components/ui'
import {
  BrandAvatar,
  WarrantyBadge,
  StatusBadge,
  ResolutionBadge,
  daysSince,
} from './_shared'
import { TransferModal } from './TransferModal'
import { CreateBatchModal } from './ManufacturerTab'

// ─── Ticket Preview Modal ─────────────────────────────────────────────────────
export function TicketPreviewModal({ rmaNumber, onClose, onOpenFull }) {
  const [ticket, setTicket] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    db.rmaTracker.getTicketByRmaNumber(rmaNumber).then((data) => {
      setTicket(data || null)
      setLoading(false)
    })
  }, [rmaNumber])

  const priorityColor = {
    Critical: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
    High: 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400',
    Medium: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    Low: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]',
  }
  const statusColor = {
    New: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    'In Progress': 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
    'On Hold': 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400',
    Completed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    Cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]',
  }
  const fmt = (d) => (d ? new Date(d).toLocaleDateString() : '—')

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <p className="text-xs text-gray-500 font-mono mb-0.5">{rmaNumber}</p>
            <h3 className="text-base font-bold text-gray-900">
              {loading ? 'Loading…' : ticket?.products?.[0]?.product_name || 'Ticket Details'}
            </h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
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
        <div className="p-5">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-500">
              <Spinner size="sm" />
              <span className="text-sm">Loading ticket…</span>
            </div>
          )}
          {!loading && !ticket && (
            <p className="text-center text-sm text-gray-500 py-6">
              Ticket not found for {rmaNumber}
            </p>
          )}
          {!loading && ticket && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {ticket.ticket_status && (
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold ${statusColor[ticket.ticket_status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                  >
                    {ticket.ticket_status}
                  </span>
                )}
                {ticket.priority && (
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold ${priorityColor[ticket.priority] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                  >
                    {ticket.priority}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <p className="text-xs text-gray-500">Customer</p>
                  <p className="font-medium text-gray-800">{ticket.customer_name || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Assigned To</p>
                  <p className="font-medium text-gray-800">{ticket.assigned_to || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Created</p>
                  <p className="font-medium text-gray-800">{fmt(ticket.created_date)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Due Date</p>
                  <p className="font-medium text-gray-800">{fmt(ticket.due_date)}</p>
                </div>
              </div>
              {ticket.general_description && (
                <div className="bg-gray-50 rounded-xl p-3 text-sm text-gray-700 line-clamp-3">
                  {ticket.general_description}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="px-5 pb-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50"
          >
            Close
          </button>
          {!loading && ticket && onOpenFull && (
            <button
              onClick={() => onOpenFull(ticket.id)}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700"
            >
              Open Ticket →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Product Detail Modal ──────────────────────────────────────────────────────
export function ProductDetailModal({
  group,
  mode,
  warehouses,
  canManageBatches,
  canTransfer,
  userEmail,
  onClose,
  onReload,
  onNavigateToTicket,
}) {
  const [tickets, setTickets] = useState({})
  const [selected, setSelected] = useState([])
  const [showBatch, setShowBatch] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [loadingTickets, setLoadingTickets] = useState(true)
  const [previewRma, setPreviewRma] = useState(null)

  const isStock = mode === 'stock'
  const stockUnits = isStock ? group.units.filter((u) => !u.manufacturer_batch_id) : []
  const batchedUnits = isStock ? group.units.filter((u) => u.manufacturer_batch_id) : []

  useEffect(() => {
    const nums = [...new Set(group.units.map((u) => u.rma_number).filter(Boolean))]
    if (!nums.length) {
      setLoadingTickets(false)
      return
    }
    supabase
      .from('rma_tickets')
      .select(
        'id,rma_number,ticket_status,customer_name,customer_type,product_name,priority,assigned_to,description,created_date,due_date'
      )
      .in('rma_number', nums)
      .then(({ data }) => {
        const m = {}
        for (const t of data || []) m[t.rma_number] = t
        setTickets(m)
        setLoadingTickets(false)
      })
  }, [group.units])

  const toggleUnit = (id) =>
    setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const toggleAll = () =>
    setSelected(selected.length === stockUnits.length ? [] : stockUnits.map((u) => u.id))

  const handleCreateBatch = async (brandName) => {
    try {
      await db.inventory.createBatch(selected, brandName, userEmail)
      toast.success('Batch created!')
      db.auditLog
        .log(
          userEmail,
          'inventory_batch_created',
          `Created batch with ${selected.length} unit${selected.length !== 1 ? 's' : ''} for ${brandName}`
        )
        .catch(() => {})
      setSelected([])
      setShowBatch(false)
      onClose()
      onReload()
    } catch {
      toast.error('Failed to create batch')
    }
  }

  const handleTransfer = async (warehouseId) => {
    const ids = selected.length > 0 ? selected : group.units.map((u) => u.id)
    try {
      await db.inventory.transferUnits(ids, warehouseId)
      toast.success(`${ids.length} unit(s) transferred`)
      db.auditLog
        .log(
          userEmail,
          'inventory_units_transferred',
          `Transferred ${ids.length} unit(s) to warehouse ${warehouseId}`
        )
        .catch(() => {})
      setSelected([])
      setShowTransfer(false)
      onReload()
    } catch {
      toast.error('Transfer failed')
    }
  }

  const tsCls = {
    New: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    'In Progress': 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400',
    'On Hold': 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400',
    Completed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    Cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]',
  }
  const wName = (id) => warehouses.find((w) => w.id === id)?.name

  const unitRows = isStock ? stockUnits : group.units
  const allIds = isStock ? stockUnits.map((u) => u.id) : group.units.map((u) => u.id)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <BrandAvatar name={group.brand || '?'} size="lg" />
            <div>
              <h3 className="text-lg font-bold text-gray-900">{group.product_name}</h3>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-sm text-gray-500">{group.brand || 'Unknown Brand'}</span>
                <span className="text-gray-300">·</span>
                <span className="text-sm text-gray-500">
                  {group.units.length} unit{group.units.length !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canTransfer && (
              <button
                onClick={() => setShowTransfer(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-300 text-indigo-700 rounded-xl text-xs font-medium hover:bg-indigo-50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
                  />
                </svg>
                Transfer{selected.length > 0 ? ` (${selected.length})` : ' All'}
              </button>
            )}
            <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Stock summary */}
        {isStock && (
          <div className="flex gap-3 px-6 py-3 bg-gray-50 border-b border-gray-100 flex-wrap">
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400">
              {group.replacement} Replacement
            </span>
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400">
              {group.credit_note} Credit Note
            </span>
            {group.units.length - group.replacement - group.credit_note > 0 && (
              <span className="px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]">
                {group.units.length - group.replacement - group.credit_note} Other
              </span>
            )}
          </div>
        )}

        {/* Batch / select bar */}
        {isStock && canManageBatches && stockUnits.length > 0 && (
          <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 bg-indigo-50/50">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={stockUnits.length > 0 && selected.length === stockUnits.length}
                onChange={toggleAll}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-sm text-gray-600">
                {selected.length > 0 ? `${selected.length} selected` : 'Select to batch'}
              </span>
            </div>
            {selected.length > 0 && (
              <button
                onClick={() => setShowBatch(true)}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                  />
                </svg>
                Send to Manufacturer ({selected.length})
              </button>
            )}
          </div>
        )}

        {/* Units table */}
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {loadingTickets && (
            <div className="flex items-center gap-2 text-sm text-gray-500 mb-2">
              <Spinner size="sm" />
              Loading RMA details...
            </div>
          )}

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            {isStock && stockUnits.length > 0 && (
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Pending Batch ({stockUnits.length})
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {isStock && canManageBatches && <th className="px-4 py-3 w-10" />}
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                    Serial #
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                    Warranty
                  </th>
                  {!isStock && (
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                      Status
                    </th>
                  )}
                  {isStock && (
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                      Resolution
                    </th>
                  )}
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">RMA #</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                    Ticket Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                    Customer
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">
                    Warehouse
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {unitRows.map((u) => {
                  const tk = tickets[u.rma_number]
                  const age = daysSince(u.resolved_date || u.created_date)
                  return (
                    <tr
                      key={u.id}
                      className={`hover:bg-gray-50 transition-colors ${selected.includes(u.id) ? 'bg-indigo-50/60' : ''}`}
                    >
                      {isStock && canManageBatches && (
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected.includes(u.id)}
                            onChange={() => toggleUnit(u.id)}
                            className="rounded border-gray-300 text-indigo-600"
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">
                        {u.serial_number || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <WarrantyBadge status={u.warranty_status} />
                      </td>
                      {!isStock && (
                        <td className="px-4 py-3">
                          <StatusBadge status={u.status} />
                        </td>
                      )}
                      {isStock && (
                        <td className="px-4 py-3">
                          <ResolutionBadge type={u.resolution_type} />
                        </td>
                      )}
                      <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                        {u.rma_number ? (
                          <button
                            onClick={() => setPreviewRma(u.rma_number)}
                            className="text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer"
                          >
                            {u.rma_number}
                          </button>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {tk ? (
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${tsCls[tk.ticket_status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                          >
                            {tk.ticket_status}
                          </span>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td
                        className="px-4 py-3 text-gray-700 text-xs max-w-[120px] truncate"
                        title={tk?.customer_name || ''}
                      >
                        {tk?.customer_name || '—'}
                      </td>
                      <td className="px-4 py-3">
                        {u.warehouse_id ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400">
                            {wName(u.warehouse_id) || 'Custom'}
                          </span>
                        ) : (
                          <span className="text-gray-300 text-xs">System</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`text-xs font-semibold ${age > 30 ? 'text-red-600' : age > 14 ? 'text-amber-600' : 'text-gray-500'}`}
                        >
                          {age}d
                        </span>
                      </td>
                    </tr>
                  )
                })}
                {unitRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500 text-sm">
                      No units
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {isStock && batchedUnits.length > 0 && (
            <div className="rounded-xl border border-purple-200 overflow-hidden">
              <div className="px-4 py-2 bg-purple-50 border-b border-purple-100 text-xs font-semibold text-purple-700 uppercase tracking-wider">
                In Manufacturer Batch ({batchedUnits.length})
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-50">
                  {batchedUnits.map((u) => {
                    const tk = tickets[u.rma_number]
                    return (
                      <tr key={u.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">
                          {u.serial_number || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <WarrantyBadge status={u.warranty_status} />
                        </td>
                        <td className="px-4 py-3">
                          <ResolutionBadge type={u.resolution_type} />
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {u.rma_number ? (
                            <button
                              onClick={() => setPreviewRma(u.rma_number)}
                              className="text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer"
                            >
                              {u.rma_number}
                            </button>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">
                          {tk?.customer_name || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400">
                            Batched
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50"
          >
            Close
          </button>
        </div>
      </div>

      {showBatch && (
        <CreateBatchModal
          count={selected.length}
          brands={[]}
          onConfirm={handleCreateBatch}
          onClose={() => setShowBatch(false)}
        />
      )}
      {showTransfer && (
        <TransferModal
          units={selected.length > 0 ? selected : allIds}
          warehouses={warehouses}
          onConfirm={handleTransfer}
          onClose={() => setShowTransfer(false)}
        />
      )}
      {previewRma && (
        <TicketPreviewModal
          rmaNumber={previewRma}
          onClose={() => setPreviewRma(null)}
          onOpenFull={
            onNavigateToTicket
              ? (ticketId) => {
                  setPreviewRma(null)
                  onClose()
                  onNavigateToTicket(ticketId)
                }
              : null
          }
        />
      )}
    </div>
  )
}
