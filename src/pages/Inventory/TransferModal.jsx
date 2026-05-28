import React, { useState } from 'react'
import { Spinner } from '../../components/ui'

// ─── Transfer Modal ────────────────────────────────────────────────────────────
export function TransferModal({ units: unitIds, warehouses, currentWarehouseId, onConfirm, onClose }) {
  const [dest, setDest] = useState('')
  const [saving, setSaving] = useState(false)
  const handleConfirm = async () => {
    if (!dest && dest !== '__system') return
    setSaving(true)
    await onConfirm(dest === '__system' ? null : dest)
    setSaving(false)
  }
  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">Transfer Units</h3>
          <p className="text-sm text-gray-500 mt-1">
            {unitIds.length} unit{unitIds.length !== 1 ? 's' : ''} selected
          </p>
        </div>
        <div className="p-6 space-y-2">
          <label className="block text-xs font-semibold text-gray-700 mb-2">
            Select Destination Warehouse
          </label>
          <label
            className={`flex items-center gap-3 p-3 border-2 rounded-xl cursor-pointer transition-all ${dest === '__system' ? 'border-gray-400 bg-gray-50' : 'border-gray-200 hover:border-gray-300'}`}
          >
            <input
              type="radio"
              name="dest"
              value="__system"
              checked={dest === '__system'}
              onChange={() => setDest('__system')}
              className="text-indigo-600"
            />
            <div>
              <div className="font-medium text-sm text-gray-900">System Pool</div>
              <div className="text-xs text-gray-500">
                Remove from custom warehouse, return to status-based tracking
              </div>
            </div>
          </label>
          {warehouses
            .filter((w) => w.is_active && w.id !== currentWarehouseId)
            .map((wh) => (
              <label
                key={wh.id}
                className={`flex items-center gap-3 p-3 border-2 rounded-xl cursor-pointer transition-all ${dest === wh.id ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-indigo-200'}`}
              >
                <input
                  type="radio"
                  name="dest"
                  value={wh.id}
                  checked={dest === wh.id}
                  onChange={() => setDest(wh.id)}
                  className="text-indigo-600"
                />
                <div>
                  <div className="font-medium text-sm text-gray-900">{wh.name}</div>
                  {(wh.code || wh.location) && (
                    <div className="text-xs text-gray-500">
                      {[wh.code, wh.location].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              </label>
            ))}
          {warehouses.filter((w) => w.is_active && w.id !== currentWarehouseId).length === 0 &&
            warehouses.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-4">
                No custom warehouses available. Create one in the Warehouses tab.
              </p>
            )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!dest || saving}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[120px] text-center"
          >
            {saving ? <Spinner size="sm" color="white" /> : 'Confirm Transfer'}
          </button>
        </div>
      </div>
    </div>
  )
}
