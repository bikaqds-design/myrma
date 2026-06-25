import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

const DIMENSIONS = ['stage', 'salesperson', 'created_month', 'close_month']
const MEASURES = ['count', 'sum_revenue', 'avg_revenue']

function getDimValue(deal, dim, stageMap, t) {
  switch (dim) {
    case 'stage':
      return stageMap[deal.stage]?.name ?? t('common.unknown')
    case 'salesperson':
      return deal.assigned_rep || t('pipeline.unassigned')
    case 'created_month':
      return deal.created_at
        ? new Date(deal.created_at).toLocaleDateString('en', { year: 'numeric', month: 'short' })
        : t('common.unknown')
    case 'close_month':
      return deal.expected_close_date
        ? new Date(deal.expected_close_date).toLocaleDateString('en', {
            year: 'numeric',
            month: 'short',
          })
        : t('common.noDate')
    default:
      return t('common.unknown')
  }
}

function calcMeasure(values, measure) {
  if (!values || values.length === 0) return null
  if (measure === 'count') return values.length
  const sum = values.reduce((s, v) => s + v, 0)
  if (measure === 'sum_revenue') return sum
  if (measure === 'avg_revenue') return sum / values.length
  return 0
}

function DimSelect({ value, onChange, exclude, t }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs rounded-lg border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
    >
      {DIMENSIONS.filter((d) => d !== exclude).map((d) => (
        <option key={d} value={d}>
          {t(`pipeline.pivotDim_${d}`)}
        </option>
      ))}
    </select>
  )
}

export default function PipelinePivotView({ deals, stages }) {
  const { t } = useTranslation()

  const [rowDim, setRowDim] = useState('stage')
  const [colDim, setColDim] = useState('status')
  const [measure, setMeasure] = useState('count')

  const stageMap = useMemo(() => Object.fromEntries(stages.map((s) => [s.id, s])), [stages])

  const { rowKeys, colKeys, cells, rowTotals, colTotals, grandTotal } = useMemo(() => {
    const raw = {}
    const rowSet = new Set()
    const colSet = new Set()

    for (const deal of deals) {
      const rk = getDimValue(deal, rowDim, stageMap, t)
      const ck = getDimValue(deal, colDim, stageMap, t)
      rowSet.add(rk)
      colSet.add(ck)
      const key = `${rk}\x00${ck}`
      if (!raw[key]) raw[key] = []
      raw[key].push(Number(deal.value) || 0)
    }

    // Sort keys (stage order preserved, others alphabetical)
    const stageOrder = Object.fromEntries(stages.map((s, i) => [s.name, i]))
    const sortKeys = (keys, dim) => {
      const arr = [...keys]
      if (dim === 'stage') return arr.sort((a, b) => (stageOrder[a] ?? 999) - (stageOrder[b] ?? 999))
      return arr.sort()
    }

    const rowKeys = sortKeys(rowSet, rowDim)
    const colKeys = sortKeys(colSet, colDim)

    const cells = {}
    const rowValBuckets = {}
    const colValBuckets = {}

    for (const rk of rowKeys) {
      rowValBuckets[rk] = []
      for (const ck of colKeys) {
        const key = `${rk}\x00${ck}`
        const vals = raw[key] || []
        cells[`${rk}\x00${ck}`] = calcMeasure(vals, measure)
        rowValBuckets[rk] = [...rowValBuckets[rk], ...vals]
        if (!colValBuckets[ck]) colValBuckets[ck] = []
        colValBuckets[ck] = [...colValBuckets[ck], ...vals]
      }
    }

    const rowTotals = Object.fromEntries(
      rowKeys.map((rk) => [rk, calcMeasure(rowValBuckets[rk], measure)])
    )
    const colTotals = Object.fromEntries(
      colKeys.map((ck) => [ck, calcMeasure(colValBuckets[ck], measure)])
    )
    const allVals = deals.map((d) => Number(d.value) || 0)
    const grandTotal = calcMeasure(allVals, measure)

    return { rowKeys, colKeys, cells, rowTotals, colTotals, grandTotal }
  }, [deals, rowDim, colDim, measure, stageMap, stages, t])

  const fmt = (v) => {
    if (v === null || v === undefined) return '—'
    if (measure === 'count') return v.toLocaleString()
    return `${Math.round(v).toLocaleString()} ${t('pipeline.currency')}`
  }

  const BORDER = 'border-[#e6e9ef] dark:border-[#212a38]'
  const SURFACE = 'bg-white dark:bg-[#121823]'

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.pivotRows')}:
          </span>
          <DimSelect value={rowDim} onChange={setRowDim} exclude={colDim} t={t} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.pivotCols')}:
          </span>
          <DimSelect value={colDim} onChange={setColDim} exclude={rowDim} t={t} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.pivotMeasure')}:
          </span>
          <div className="flex gap-1 bg-[#f4f6f9] dark:bg-[#0f1520] rounded-lg p-1">
            {MEASURES.map((m) => (
              <button
                key={m}
                onClick={() => setMeasure(m)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  measure === m
                    ? 'bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] shadow-sm'
                    : 'text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'
                }`}
              >
                {t(`pipeline.pivotMeasure_${m}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Pivot table */}
      <div className={`${SURFACE} border ${BORDER} rounded-[14px] overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={`border-b ${BORDER} bg-[#f8f9fb] dark:bg-[#0f1520]`}>
                <th
                  className={`px-4 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] min-w-[160px] border-r ${BORDER}`}
                >
                  <span>{t(`pipeline.pivotDim_${rowDim}`)}</span>
                  <span className="mx-1 opacity-40">/</span>
                  <span>{t(`pipeline.pivotDim_${colDim}`)}</span>
                </th>
                {colKeys.map((ck) => (
                  <th
                    key={ck}
                    className="px-4 py-3 text-right text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap"
                  >
                    {ck}
                  </th>
                ))}
                <th
                  className={`px-4 py-3 text-right text-xs font-bold text-[#211f1b] dark:text-[#e8ebf0] whitespace-nowrap border-l ${BORDER}`}
                >
                  {t('pipeline.pivotTotal')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rowKeys.length === 0 ? (
                <tr>
                  <td
                    colSpan={colKeys.length + 2}
                    className="px-4 py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]"
                  >
                    {t('pipeline.listEmpty')}
                  </td>
                </tr>
              ) : (
                rowKeys.map((rk, ri) => (
                  <tr
                    key={rk}
                    className={`border-t ${BORDER} ${ri % 2 === 1 ? 'bg-[#f8f9fb] dark:bg-[#0f1520]' : ''}`}
                  >
                    <td
                      className={`px-4 py-2.5 text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0] border-r ${BORDER}`}
                    >
                      {rk}
                    </td>
                    {colKeys.map((ck) => {
                      const v = cells[`${rk}\x00${ck}`]
                      return (
                        <td
                          key={ck}
                          className={`px-4 py-2.5 text-right text-xs ${
                            v !== null
                              ? 'text-[#211f1b] dark:text-[#e8ebf0]'
                              : 'text-[#6c6760] dark:text-[#9aa4b2]'
                          }`}
                        >
                          {fmt(v)}
                        </td>
                      )
                    })}
                    <td
                      className={`px-4 py-2.5 text-right text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0] border-l ${BORDER}`}
                    >
                      {fmt(rowTotals[rk])}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rowKeys.length > 0 && (
              <tfoot>
                <tr
                  className={`border-t-2 ${BORDER} bg-[#f8f9fb] dark:bg-[#0f1520]`}
                >
                  <td
                    className={`px-4 py-2.5 text-xs font-bold text-[#211f1b] dark:text-[#e8ebf0] border-r ${BORDER}`}
                  >
                    {t('pipeline.pivotTotal')}
                  </td>
                  {colKeys.map((ck) => (
                    <td
                      key={ck}
                      className="px-4 py-2.5 text-right text-xs font-bold text-[#211f1b] dark:text-[#e8ebf0]"
                    >
                      {fmt(colTotals[ck])}
                    </td>
                  ))}
                  <td
                    className={`px-4 py-2.5 text-right text-xs font-bold text-[#4338ca] dark:text-[#a5b4fc] border-l ${BORDER}`}
                  >
                    {fmt(grandTotal)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
        {t('pipeline.pivotHint')}
      </p>
    </div>
  )
}
