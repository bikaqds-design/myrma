import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { Spinner } from '../../components/ui'
import { BATCH_STATUS } from '../../lib/constants'
import { BrandAvatar, BATCH_STATUS_META, WarrantyBadge, ResolutionBadge, fmt } from './_shared'

// ─── Manufacturer Returns ──────────────────────────────────────────────────────
export function ManufacturerTab({
  batches,
  units,
  brands,
  userEmail: _userEmail,
  canManageBatches,
  onReload,
}) {
  const { t } = useTranslation()
  const [selectedBrand, setSelectedBrand] = useState(null)
  const [selectedBatch, setSelectedBatch] = useState(null)
  const getBatchUnits = (batchId) => units.filter((u) => u.manufacturer_batch_id === batchId)
  const getBrandBatches = (name) =>
    batches.filter((b) => b.manufacturer_name?.toLowerCase() === name?.toLowerCase())
  const getBrandStats = (name) => {
    const bb = getBrandBatches(name)
    return {
      total: bb.length,
      draft: bb.filter((b) => b.status === BATCH_STATUS.DRAFT).length,
      sent: bb.filter((b) => b.status === BATCH_STATUS.SENT).length,
      resolved: bb.filter((b) => b.status === BATCH_STATUS.RESOLVED).length,
      units: bb.reduce((s, b) => s + (getBatchUnits(b.id).length || b.unit_count || 0), 0),
    }
  }
  const knownNames = brands.map((b) => b.brand_name?.toLowerCase())
  const otherBatches = batches.filter(
    (b) => !knownNames.includes(b.manufacturer_name?.toLowerCase())
  )
  const displayBatches =
    selectedBrand === '__other'
      ? otherBatches
      : selectedBrand
        ? getBrandBatches(selectedBrand)
        : batches

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0]">{t('inventory.brandWarehouses')}</h3>
          {selectedBrand && (
            <button
              onClick={() => setSelectedBrand(null)}
              className="text-xs text-indigo-600 hover:underline"
            >
              {t('inventory.clearFilter')}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {brands.map((brand) => {
            const s = getBrandStats(brand.brand_name)
            const isA = selectedBrand === brand.brand_name
            return (
              <button
                key={brand.id}
                onClick={() => setSelectedBrand(isA ? null : brand.brand_name)}
                className={`rounded-2xl border p-4 text-start transition-all ${isA ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-300' : 'border-gray-200 dark:border-[#212a38] bg-white dark:bg-[#121823] hover:border-indigo-200 hover:bg-indigo-50 dark:hover:bg-[#1a2230]/40'}`}
              >
                <BrandAvatar name={brand.brand_name} size="md" />
                <div className="mt-3">
                  <div className="font-semibold text-sm text-gray-900 dark:text-[#e8ebf0] truncate">
                    {brand.brand_name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                    {t('inventory.batchesCount', { count: s.total })} · {t('inventory.unitsSelected', { count: s.units })}
                  </div>
                </div>
                {s.total > 0 ? (
                  <div className="flex gap-1 mt-2 flex-wrap">
                    {s.draft > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]">
                        {s.draft} {t('inventory.batchDraft')}
                      </span>
                    )}
                    {s.sent > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-700">
                        {s.sent} {t('inventory.batchSent')}
                      </span>
                    )}
                    {s.resolved > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                        {s.resolved} {t('inventory.batchDone')}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] text-gray-300 font-medium">{t('inventory.noBatchesYet')}</div>
                )}
              </button>
            )
          })}
          {otherBatches.length > 0 && (
            <button
              onClick={() => setSelectedBrand(selectedBrand === '__other' ? null : '__other')}
              className={`rounded-2xl border p-4 text-start transition-all ${selectedBrand === '__other' ? 'border-gray-400 bg-gray-50 dark:bg-[#0f1520] ring-2 ring-gray-300' : 'border-dashed border-gray-300 bg-white dark:bg-[#121823] hover:border-gray-400'}`}
            >
              <div className="w-9 h-9 bg-gray-200 rounded-xl flex items-center justify-center text-gray-500 dark:text-[#9aa4b2] text-base font-bold">
                ?
              </div>
              <div className="mt-3">
                <div className="font-semibold text-sm text-gray-900 dark:text-[#e8ebf0]">{t('inventory.otherLabel')}</div>
                <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                  {t('inventory.batchesCount', { count: otherBatches.length })}
                </div>
              </div>
            </button>
          )}
        </div>
      </div>

      {displayBatches.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] space-y-3">
          <div className="w-14 h-14 bg-purple-100 rounded-2xl flex items-center justify-center mx-auto">
            <svg
              className="w-7 h-7 text-purple-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
              />
            </svg>
          </div>
          <p className="text-gray-600 dark:text-[#9aa4b2] font-medium">
            {selectedBrand ? t('inventory.noBatchesForBrand', { brand: selectedBrand }) : t('inventory.noBatchesYet')}
          </p>
          <p className="text-gray-500 dark:text-[#9aa4b2] text-sm">
            {t('inventory.noBatchesHintStock')}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] overflow-hidden">
          {selectedBrand && selectedBrand !== '__other' && (
            <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 dark:border-[#212a38] bg-indigo-50/60">
              <BrandAvatar name={selectedBrand} size="md" />
              <div>
                <div className="font-semibold text-gray-900 dark:text-[#e8ebf0]">{selectedBrand} — {t('inventory.returnBatches')}</div>
                <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">
                  {t('inventory.batchesCount', { count: displayBatches.length })}
                </div>
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                <tr>
                  {[
                    t('inventory.colBatchNum'),
                    t('inventory.colManufacturer'),
                    t('inventory.colUnits'),
                    t('inventory.colStatus'),
                    t('inventory.colSentDate'),
                    t('inventory.colTracking'),
                    t('inventory.colResolution'),
                    t('inventory.colCreated'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 text-start text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                  <th className="px-4 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {displayBatches.map((b) => {
                  const sm = BATCH_STATUS_META[b.status] || {
                    label: b.status,
                    cls: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
                  }
                  const resLabel =
                    b.resolution_type === 'replacement_received'
                      ? { label: t('inventory.resolutionReplacementRcvd'), cls: 'bg-green-100 text-green-700' }
                      : b.resolution_type === 'credit_note_received'
                        ? { label: t('inventory.resolutionCreditNoteRcvd'), cls: 'bg-blue-100 text-blue-700' }
                        : null
                  return (
                    <tr
                      key={b.id}
                      className="hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] cursor-pointer"
                      onClick={() => setSelectedBatch(b)}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-bold text-indigo-600">
                        {b.batch_number}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <BrandAvatar name={b.manufacturer_name} size="xs" />
                          <span className="text-gray-900 dark:text-[#e8ebf0] font-medium text-sm">
                            {b.manufacturer_name}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">
                        {getBatchUnits(b.id).length || b.unit_count || 0}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>
                          {sm.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] whitespace-nowrap">
                        {fmt(b.sent_date)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-[#9aa4b2]">
                        {b.tracking_number || '—'}
                      </td>
                      <td className="px-4 py-3">
                        {resLabel ? (
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${resLabel.cls}`}
                          >
                            {resLabel.label}
                          </span>
                        ) : (
                          <span className="text-gray-500 dark:text-[#9aa4b2] text-xs">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs whitespace-nowrap">
                        {fmt(b.created_date)}
                      </td>
                      <td className="px-4 py-3 text-end">
                        <span className="text-xs text-indigo-600 hover:underline">{t('inventory.viewLink')}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {selectedBatch && (
        <BatchDetailModal
          batch={selectedBatch}
          batchUnits={getBatchUnits(selectedBatch.id)}
          canEdit={canManageBatches}
          onClose={() => setSelectedBatch(null)}
          onReload={() => {
            setSelectedBatch(null)
            onReload()
          }}
        />
      )}
    </div>
  )
}

// ─── Resolve Modal ─────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
function ResolveModal({ count, onConfirm, onClose }) {
  const { t } = useTranslation()
  const [resolution, setResolution] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const options = [
    {
      value: 'return_to_customer',
      label: t('inventory.resolveReturnToCustomer'),
      desc: t('inventory.resolveReturnToCustomerDesc'),
      active: 'border-green-400 bg-green-50',
    },
    {
      value: 'credit_note',
      label: t('inventory.resolveCreditNote'),
      desc: t('inventory.resolveCreditNoteDesc'),
      active: 'border-orange-400 bg-orange-50',
    },
    {
      value: 'replacement',
      label: t('inventory.resolveReplacement'),
      desc: t('inventory.resolveReplacementDesc'),
      active: 'border-indigo-400 bg-indigo-50',
    },
  ]
  const handleConfirm = async () => {
    if (!resolution) return
    setSaving(true)
    await onConfirm(resolution, notes)
    setSaving(false)
  }
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#121823] rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-6 border-b border-gray-100 dark:border-[#212a38]">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('inventory.setResolutionTitle')}</h3>
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1">
            {t('inventory.unitsSelected', { count })}
          </p>
        </div>
        <div className="p-6 space-y-3">
          {options.map((o) => (
            <label
              key={o.value}
              className={`flex items-start gap-3 p-4 border-2 rounded-xl cursor-pointer transition-all ${resolution === o.value ? o.active : 'border-gray-200 dark:border-[#212a38] hover:border-gray-300 bg-white dark:bg-[#121823]'}`}
            >
              <input
                type="radio"
                name="resolution"
                value={o.value}
                checked={resolution === o.value}
                onChange={() => setResolution(o.value)}
                className="mt-0.5 text-indigo-600"
              />
              <div>
                <div className="font-medium text-sm text-gray-900 dark:text-[#e8ebf0]">{o.label}</div>
                <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">{o.desc}</div>
              </div>
            </label>
          ))}
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('inventory.notesOptional')}
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm resize-none focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
          />
        </div>
        <div className="px-6 py-4 border-t border-gray-100 dark:border-[#212a38] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 dark:text-[#e8ebf0] rounded-xl text-sm hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!resolution || saving}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[140px] text-center"
          >
            {saving ? <Spinner size="sm" color="white" /> : t('inventory.confirmResolution')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Create Batch Modal ────────────────────────────────────────────────────────
export function CreateBatchModal({ count, brands, onConfirm, onClose }) {
  const { t } = useTranslation()
  const [brandName, setBrandName] = useState('')
  const [customName, setCustomName] = useState('')
  const [saving, setSaving] = useState(false)
  const effectiveName = brandName === '__custom' ? customName.trim() : brandName
  const handleConfirm = async () => {
    if (!effectiveName) return
    setSaving(true)
    await onConfirm(effectiveName)
    setSaving(false)
  }
  return (
    <div className="fixed inset-0 bg-black/50 z-modal flex items-center justify-center p-4">
      <div className="bg-white dark:bg-[#121823] rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="p-6 border-b border-gray-100 dark:border-[#212a38]">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('inventory.createMfrBatch')}</h3>
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1">
            {t('inventory.unitsWillBeAdded', { count })}
          </p>
        </div>
        <div className="p-6 space-y-4">
          <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-2">{t('inventory.mfrNameLabel')}</label>
          {brands.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {brands.map((b) => (
                <button
                  key={b.id || b.brand_name}
                  type="button"
                  onClick={() => setBrandName(b.brand_name || b)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all text-start ${brandName === (b.brand_name || b) ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 dark:border-[#212a38] hover:border-indigo-200 text-gray-700 dark:text-[#e8ebf0]'}`}
                >
                  <BrandAvatar name={b.brand_name || b} size="xs" />
                  {b.brand_name || b}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setBrandName('__custom')}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all ${brandName === '__custom' ? 'border-gray-400 bg-gray-50 dark:bg-[#0f1520]' : 'border-dashed border-gray-300 hover:border-gray-400 text-gray-500 dark:text-[#9aa4b2]'}`}
              >
                <div className="w-5 h-5 bg-gray-200 rounded flex items-center justify-center text-xs font-bold">
                  +
                </div>
                {t('inventory.otherLabel')}
              </button>
            </div>
          ) : null}
          {(brands.length === 0 || brandName === '__custom') && (
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={t('inventory.mfrNamePlaceholder')}
              autoFocus
              className="w-full px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600"
              onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
            />
          )}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 dark:border-[#212a38] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 dark:text-[#e8ebf0] rounded-xl text-sm hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!effectiveName || saving}
            className="px-5 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 min-w-[120px] text-center"
          >
            {saving ? <Spinner size="sm" color="white" /> : t('inventory.createBatch')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Batch Detail Modal ────────────────────────────────────────────────────────
function BatchDetailModal({ batch, batchUnits, canEdit, onClose, onReload }) {
  const { t } = useTranslation()
  const [sentDate, setSentDate] = useState(
    batch.sent_date || new Date().toISOString().split('T')[0]
  )
  const [tracking, setTracking] = useState(batch.tracking_number || '')
  const [resType, setResType] = useState(batch.resolution_type || '')
  const [resDate, setResDate] = useState(
    batch.resolution_date || new Date().toISOString().split('T')[0]
  )
  const [resNotes, setResNotes] = useState(batch.resolution_notes || '')
  const [saving, setSaving] = useState(false)
  const sm = BATCH_STATUS_META[batch.status] || {
    label: batch.status,
    cls: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  }

  const handleMarkSent = async () => {
    setSaving(true)
    try {
      await db.inventory.markBatchSent(batch.id, sentDate, tracking)
      toast.success(t('inventory.batchMarkedSent'))
      onReload()
    } catch {
      toast.error(t('inventory.genericFailed'))
    } finally {
      setSaving(false)
    }
  }
  const handleMarkResolved = async () => {
    if (!resType) return
    setSaving(true)
    try {
      await db.inventory.markBatchResolved(batch.id, resType, resDate, resNotes)
      toast.success(t('inventory.batchResolved'))
      onReload()
    } catch {
      toast.error(t('inventory.genericFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white dark:bg-[#121823] rounded-2xl shadow-2xl w-full max-w-2xl my-4">
        <div className="flex items-center justify-between p-6 border-b border-gray-100 dark:border-[#212a38]">
          <div className="flex items-center gap-3">
            <BrandAvatar name={batch.manufacturer_name} size="lg" />
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-[#e8ebf0] font-mono">{batch.batch_number}</h3>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-sm text-gray-600 dark:text-[#9aa4b2] font-medium">{batch.manufacturer_name}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sm.cls}`}>
                  {sm.label}
                </span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 dark:text-[#9aa4b2] hover:text-gray-600 dark:text-[#9aa4b2]">
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
        {(batch.sent_date || batch.tracking_number) && (
          <div className="px-6 py-3 bg-gray-50 dark:bg-[#0f1520] border-b border-gray-100 dark:border-[#212a38] flex gap-6 text-sm">
            {batch.sent_date && (
              <div>
                <span className="text-gray-500 dark:text-[#9aa4b2] text-xs">{t('inventory.sentDate')}:</span>{' '}
                <span className="font-medium text-gray-700 dark:text-[#e8ebf0]">{fmt(batch.sent_date)}</span>
              </div>
            )}
            {batch.tracking_number && (
              <div>
                <span className="text-gray-500 dark:text-[#9aa4b2] text-xs">{t('inventory.trackingNum')}:</span>{' '}
                <span className="font-mono font-medium text-gray-700 dark:text-[#e8ebf0]">{batch.tracking_number}</span>
              </div>
            )}
          </div>
        )}
        <div className="p-6 border-b border-gray-100 dark:border-[#212a38]">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] mb-3">
            {t('inventory.unitsBatchCount', { count: batchUnits.length })}
          </h4>
          {batchUnits.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('inventory.noUnitsInBatch')}</p>
          ) : (
            <div className="rounded-xl border border-gray-100 dark:border-[#212a38] overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-[#0f1520]">
                  <tr>
                    {[t('inventory.colProduct'), t('inventory.colSerialNum'), t('inventory.colWarranty'), 'RMA Source', t('inventory.colResolution')].map((h, i) => (
                      <th
                        key={i}
                        className="px-3 py-2.5 text-start text-xs font-semibold text-gray-500 dark:text-[#9aa4b2]"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {batchUnits.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]">
                      <td className="px-3 py-2.5 text-gray-900 dark:text-[#e8ebf0] font-medium">
                        {u.product_name || '—'}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-gray-500 dark:text-[#9aa4b2]">
                        {u.serial_number || '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <WarrantyBadge status={u.warranty_status} />
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-indigo-600">
                        {u.rma_number || '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <ResolutionBadge type={u.resolution_type} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {canEdit && batch.status === 'draft' && (
          <div className="p-6 border-b border-gray-100 dark:border-[#212a38]">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
              <h4 className="text-sm font-semibold text-blue-900">{t('inventory.markAsSentTitle')}</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">{t('inventory.sentDate')}</label>
                  <input
                    type="date"
                    value={sentDate}
                    onChange={(e) => setSentDate(e.target.value)}
                    className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white dark:bg-[#121823] focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-blue-700 mb-1">
                    {t('inventory.trackingNumberLabel')}
                  </label>
                  <input
                    value={tracking}
                    onChange={(e) => setTracking(e.target.value)}
                    placeholder={t('inventory.awbPlaceholder')}
                    className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm bg-white dark:bg-[#121823] focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <button
                onClick={handleMarkSent}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? (
                  <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
                {t('inventory.markAsSentBtn')}
              </button>
            </div>
          </div>
        )}
        {canEdit && batch.status === 'sent' && (
          <div className="p-6 border-b border-gray-100 dark:border-[#212a38]">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
              <h4 className="text-sm font-semibold text-green-900">{t('inventory.markBatchResolvedTitle')}</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-green-700 mb-1">
                    {t('inventory.resolutionTypeLabel')}
                  </label>
                  <select
                    value={resType}
                    onChange={(e) => setResType(e.target.value)}
                    className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm bg-white dark:bg-[#121823] focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">{t('inventory.selectResolution')}</option>
                    <option value="replacement_received">{t('inventory.replacementUnitsReceived')}</option>
                    <option value="credit_note_received">{t('inventory.creditNoteReceived')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-green-700 mb-1">
                    {t('inventory.resolutionDateLabel')}
                  </label>
                  <input
                    type="date"
                    value={resDate}
                    onChange={(e) => setResDate(e.target.value)}
                    className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm bg-white dark:bg-[#121823] focus:ring-2 focus:ring-green-500"
                  />
                </div>
              </div>
              <textarea
                value={resNotes}
                onChange={(e) => setResNotes(e.target.value)}
                placeholder={t('inventory.notesPlaceholder')}
                rows={2}
                className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm bg-white dark:bg-[#121823] resize-none focus:ring-2 focus:ring-green-500"
              />
              <button
                onClick={handleMarkResolved}
                disabled={!resType || saving}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? (
                  <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                )}
                {t('inventory.markAsResolvedBtn')}
              </button>
            </div>
          </div>
        )}
        {batch.status === 'resolved' && (
          <div className="p-6 border-b border-gray-100 dark:border-[#212a38]">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-1.5">
              <div className="flex items-center gap-2 mb-2">
                <svg
                  className="w-5 h-5 text-green-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span className="font-semibold text-green-900">{t('inventory.batchResolvedTitle')}</span>
              </div>
              <p className="text-sm text-green-800">
                {t('inventory.resolutionLabelColon')}{' '}
                <strong>
                  {batch.resolution_type === 'replacement_received'
                    ? t('inventory.replacementUnitsReceived')
                    : t('inventory.creditNoteReceived')}
                </strong>
              </p>
              {batch.resolution_date && (
                <p className="text-sm text-green-800">
                  {t('inventory.dateLabelColon')} <strong>{fmt(batch.resolution_date)}</strong>
                </p>
              )}
              {batch.resolution_notes && (
                <p className="text-sm text-green-800">
                  {t('inventory.notesLabelColon')} <strong>{batch.resolution_notes}</strong>
                </p>
              )}
            </div>
          </div>
        )}
        <div className="px-6 py-4 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 dark:text-[#e8ebf0] rounded-xl text-sm hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520]"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
