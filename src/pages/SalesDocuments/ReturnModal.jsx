import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Input, Textarea, Label, Select, Spinner } from '../../components/ui'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { receivableWarehouses } from '../Purchasing/_receipts'
import { returnableByLine, validateReturnLines } from './_returns'

// Recording goods that come back from one delivery (P-05d over 20260902).
// A serialized line is returned by ticking the units that came back (only
// units that left on that line and have not come back yet are offered); a
// bulk line by quantity. Back to stock only (owner decision): the warehouse
// list is the sellable ones.

export default function ReturnModal({ delivery, returns, busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const { data: units, isLoading: unitsLoading } = useQuery({
    queryKey: ['delivered-units', delivery.id],
    queryFn: () => db.customerReturns.deliveredUnits(delivery.id),
  })
  const { data: warehouses = EMPTY_ARRAY } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => db.warehouses.list().then((r) => (r.missing ? [] : r.data)),
  })
  const sellable = useMemo(() => receivableWarehouses(warehouses), [warehouses])
  const rows = useMemo(() => returnableByLine(delivery, returns), [delivery, returns])
  const unitsByLine = useMemo(() => {
    const out = {}
    for (const u of units || []) (out[u.delivery_line_id] ||= []).push(u)
    return out
  }, [units])

  const [qty, setQty] = useState({})
  const [picked, setPicked] = useState({}) // lineId -> Set(unitId)
  const [wh, setWh] = useState({})
  const [reason, setReason] = useState('')
  const [error, setError] = useState(null) // { key, lineId? }

  const warehouseFor = (lineId) => wh[lineId] ?? sellable[0]?.id ?? ''
  const toggleUnit = (lineId, unitId) => {
    setError(null)
    setPicked((p) => {
      const next = new Set(p[lineId] || [])
      if (next.has(unitId)) next.delete(unitId)
      else next.add(unitId)
      return { ...p, [lineId]: next }
    })
  }

  const submit = () => {
    const res = validateReturnLines(rows.map((r) => ({
      lineId: r.line.id,
      serialized: (unitsByLine[r.line.id] || []).length > 0,
      unitIds: [...(picked[r.line.id] || [])],
      qty: qty[r.line.id],
      left: r.left,
      warehouseId: warehouseFor(r.line.id),
    })))
    if (res.error) { setError({ key: res.error, lineId: res.lineId }); return }
    onSubmit(res.lines, { reason: reason.trim() || null })
  }

  const errorText = () => {
    if (!error) return null
    const bad = error.lineId && rows.find((r) => r.line.id === error.lineId)
    return bad ? t(error.key, { product: bad.line.product_name, left: bad.left }) : t(error.key)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={t('salesDocuments.rtnCreateTitle')}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-2xl w-full"
      >
        <div className="px-5 py-4 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.rtnCreateTitle')}</h2>
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">
            {t('salesDocuments.rtnFromDelivery', { code: delivery.delivery_code || '—' })}
          </p>
        </div>
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {unitsLoading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : (
            rows.map((r) => {
              const lineUnits = unitsByLine[r.line.id] || []
              const serialized = lineUnits.length > 0
              const offer = lineUnits.filter((u) => !r.usedUnits.has(u.unit_id))
              const bad = error?.lineId === r.line.id
              return (
                <fieldset key={r.line.id} className="border border-[#e6e9ef] dark:border-[#212a38] rounded-lg p-3" aria-invalid={bad || undefined}>
                  <legend className="px-1 text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{r.line.product_name}</legend>
                  <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mb-2">
                    {t('salesDocuments.rtnLineSummary', { delivered: r.delivered, back: r.back, left: r.left })}
                  </p>
                  {r.left === 0 ? (
                    <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.rtnNothingLeft')}</p>
                  ) : (
                    <div className="flex flex-wrap items-end gap-3">
                      {serialized ? (
                        <div className="flex-1 min-w-[12rem]">
                          <Label>{t('salesDocuments.rtnUnits')}</Label>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {offer.map((u) => (
                              <label key={u.unit_id} className="inline-flex items-center gap-1.5 text-xs font-mono text-[#211f1b] dark:text-[#e8ebf0]">
                                <input
                                  type="checkbox"
                                  className="accent-[#4338ca]"
                                  checked={picked[r.line.id]?.has(u.unit_id) || false}
                                  onChange={() => toggleUnit(r.line.id, u.unit_id)}
                                />
                                {u.serial_number || u.unit_id.slice(0, 8)}
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <Label htmlFor={`rtn-qty-${r.line.id}`}>{t('salesDocuments.rtnQty')}</Label>
                          <Input
                            id={`rtn-qty-${r.line.id}`}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={r.left}
                            step={1}
                            aria-invalid={bad || undefined}
                            aria-describedby={bad ? 'rtn-error' : undefined}
                            value={qty[r.line.id] ?? ''}
                            onChange={(e) => { setError(null); setQty((q) => ({ ...q, [r.line.id]: e.target.value })) }}
                            className={`w-24 text-center ${bad ? 'border-red-500 dark:border-red-400 ring-1 ring-red-500' : ''}`}
                          />
                        </div>
                      )}
                      <div className="min-w-[10rem]">
                        <Label htmlFor={`rtn-wh-${r.line.id}`}>{t('salesDocuments.rtnWarehouse')}</Label>
                        <Select
                          id={`rtn-wh-${r.line.id}`}
                          value={warehouseFor(r.line.id)}
                          onChange={(e) => { setError(null); setWh((w) => ({ ...w, [r.line.id]: e.target.value })) }}
                        >
                          {sellable.length === 0 && <option value="">{t('salesDocuments.rtnNoWarehouse')}</option>}
                          {sellable.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </Select>
                      </div>
                    </div>
                  )}
                </fieldset>
              )
            })
          )}

          <div>
            <Label htmlFor="rtn-reason">{t('salesDocuments.rtnReason')}</Label>
            <Textarea id="rtn-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>

          {error && (
            <p id="rtn-error" role="alert" className="text-xs text-red-600 dark:text-red-400">{errorText()}</p>
          )}

          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={submit} loading={busy} disabled={unitsLoading}>{t('salesDocuments.rtnCreate')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
