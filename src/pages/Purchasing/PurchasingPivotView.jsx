import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DIMENSIONS, dimensionKey, docTotalBase, isLiveDocument, sortDimensionKeys } from './_shared'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'

/**
 * PurchasingPivotView — purchase documents crossed by two dimensions at once.
 *
 * The chart view answers one-dimensional questions: what do we spend per vendor,
 * how much sits in each status. The questions that actually come up in purchasing
 * are two-dimensional — how much of each vendor's spend is still unreceived,
 * which months a particular vendor was active — and answering those from a bar
 * chart means switching the group-by back and forth and holding the first answer
 * in your head.
 *
 * Rows and columns both draw from the same dimension list as the chart, and both
 * bucket documents through the same shared dimensionKey, so "group by month"
 * means one thing across the module. Cancelled and voided documents are excluded
 * here for the same reason they are excluded there.
 *
 * Empty cells are rendered blank rather than as zero: on a sparse grid a screen
 * of zeroes hides the handful of cells that carry the data.
 */
export default function PurchasingPivotView({ documents, vendorName }) {
  const { t } = useTranslation()
  // Every spend cell is a sum across documents, so all of them are in base
  // currency and the footnote has to name it.
  const baseCurrency = useBaseCurrency()

  const [measure, setMeasure] = useState('spend')
  const [rowDim, setRowDim] = useState('vendor')
  const [colDim, setColDim] = useState('status')

  const live = useMemo(() => (documents || []).filter(isLiveDocument), [documents])

  const pivot = useMemo(() => {
    // cells[rowKey][colKey] = { count, spend }
    const cells = new Map()
    const rowTotals = new Map()
    const colTotals = new Map()
    const grand = { count: 0, spend: 0 }

    const bump = (bucket, doc) => {
      bucket.count += 1
      bucket.spend += docTotalBase(doc)
    }
    const ensure = (map, key) => {
      if (!map.has(key)) map.set(key, { count: 0, spend: 0 })
      return map.get(key)
    }

    for (const doc of live) {
      const r = dimensionKey(doc, rowDim, { vendorName, t })
      const c = dimensionKey(doc, colDim, { vendorName, t })
      if (!cells.has(r)) cells.set(r, new Map())
      bump(ensure(cells.get(r), c), doc)
      bump(ensure(rowTotals, r), doc)
      bump(ensure(colTotals, c), doc)
      bump(grand, doc)
    }

    const rowKeys = sortDimensionKeys([...rowTotals.keys()], rowDim, (k) => rowTotals.get(k)[measure])
    const colKeys = sortDimensionKeys([...colTotals.keys()], colDim, (k) => colTotals.get(k)[measure])

    return { cells, rowKeys, colKeys, rowTotals, colTotals, grand }
  }, [live, rowDim, colDim, measure, vendorName, t])

  const fmt = (bucket) => {
    if (!bucket || bucket[measure] === 0) return ''
    return measure === 'spend'
      ? Number(bucket.spend).toLocaleString()
      : String(bucket.count)
  }

  // Shades a cell by its share of the largest cell, so the heavy combinations
  // are findable without reading every number.
  const maxCell = useMemo(() => {
    let max = 0
    for (const row of pivot.cells.values()) {
      for (const bucket of row.values()) max = Math.max(max, bucket[measure])
    }
    return max
  }, [pivot, measure])

  const cellStyle = (bucket) => {
    if (!bucket || !maxCell || bucket[measure] === 0) return undefined
    // Capped low so text stays readable in both themes.
    const intensity = (bucket[measure] / maxCell) * 0.18
    return { backgroundColor: `rgba(99, 102, 241, ${intensity.toFixed(3)})` }
  }

  const selectCls =
    'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none'
  const th = 'px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2]'
  const td = 'px-3 py-2.5 text-sm text-[#211f1b] dark:text-[#e8ebf0] tabular-nums'

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-4">
        <div className="flex items-center gap-2 flex-wrap mb-4">
          <label className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.graphMeasure')}</label>
          <select value={measure} onChange={(e) => setMeasure(e.target.value)} className={selectCls}>
            <option value="count">{t('purchasing.graphMeasureCount')}</option>
            <option value="spend">{t('purchasing.graphMeasureSpend')}</option>
          </select>

          <label className="text-xs text-[#6c6760] dark:text-[#9aa4b2] ml-2">{t('purchasing.pivotRows')}</label>
          <select value={rowDim} onChange={(e) => setRowDim(e.target.value)} className={selectCls}>
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>{t(`purchasing.graphGroup_${d}`)}</option>
            ))}
          </select>

          <label className="text-xs text-[#6c6760] dark:text-[#9aa4b2] ml-2">{t('purchasing.pivotColumns')}</label>
          <select value={colDim} onChange={(e) => setColDim(e.target.value)} className={selectCls}>
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>{t(`purchasing.graphGroup_${d}`)}</option>
            ))}
          </select>

          {rowDim === colDim && (
            // Not blocked — the diagonal is a valid, if useless, view — but the
            // reader should know why every off-diagonal cell is empty.
            <span className="text-xs text-amber-600 dark:text-amber-400 ml-2">
              {t('purchasing.pivotSameDimension')}
            </span>
          )}
        </div>

        {pivot.rowKeys.length === 0 ? (
          <div className="py-12 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
            {t('purchasing.graphEmpty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <th className={`${th} text-left sticky left-0 bg-[#f8f9fb] dark:bg-[#0f1520]`}>
                    {t(`purchasing.graphGroup_${rowDim}`)}
                  </th>
                  {pivot.colKeys.map((c) => (
                    <th key={c} className={`${th} text-right whitespace-nowrap`} dir="auto">{c}</th>
                  ))}
                  <th className={`${th} text-right whitespace-nowrap`}>{t('purchasing.pivotTotal')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
                {pivot.rowKeys.map((r) => (
                  <tr key={r} className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]">
                    <td className={`${td} font-medium sticky left-0 bg-white dark:bg-[#121823]`} dir="auto">{r}</td>
                    {pivot.colKeys.map((c) => {
                      const bucket = pivot.cells.get(r)?.get(c)
                      return (
                        <td key={c} className={`${td} text-right`} style={cellStyle(bucket)}>
                          {fmt(bucket)}
                        </td>
                      )
                    })}
                    <td className={`${td} text-right font-semibold`}>{fmt(pivot.rowTotals.get(r))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <td className={`${td} font-semibold sticky left-0 bg-[#f8f9fb] dark:bg-[#0f1520]`}>
                    {t('purchasing.pivotTotal')}
                  </td>
                  {pivot.colKeys.map((c) => (
                    <td key={c} className={`${td} text-right font-semibold`}>{fmt(pivot.colTotals.get(c))}</td>
                  ))}
                  <td className={`${td} text-right font-bold text-indigo-600 dark:text-[#a5b4fc]`}>
                    {fmt(pivot.grand)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
        {measure === 'spend' && `${baseCurrency} · `}
        {t('purchasing.graphExcludesCancelled')}
      </p>
    </div>
  )
}
