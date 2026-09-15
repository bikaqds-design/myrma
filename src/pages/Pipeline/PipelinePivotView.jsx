import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { monthLabel } from '../../lib/pipelineBuckets'

const DIMENSIONS = ['stage', 'salesperson', 'created_month', 'close_month']
const MEASURES = ['count', 'sum_revenue', 'avg_revenue']

// The pivot is built from `buckets` — deal count and value per stage, rep,
// status and month, summed in the database over every matching deal — rather
// than from a list of deals the Data API caps at 1 000 rows. (BUG-066.)
function getDimValue(bucket, dim, stageMap, t) {
  switch (dim) {
    case 'stage':
      return stageMap[bucket.stage]?.name ?? t('common.unknown')
    case 'salesperson':
      return bucket.assigned_rep || t('pipeline.unassigned')
    case 'created_month':
      return monthLabel(bucket.created_month) ?? t('common.unknown')
    case 'close_month':
      return monthLabel(bucket.close_month) ?? t('common.noDate')
    default:
      return t('common.unknown')
  }
}

/** A cell's measure from its deal count and value sum; null for an empty cell. */
function calcMeasure(acc, measure) {
  if (!acc || acc.count === 0) return null
  if (measure === 'count') return acc.count
  if (measure === 'sum_revenue') return acc.sum
  if (measure === 'avg_revenue') return acc.sum / acc.count
  return 0
}

function add(acc, bucket) {
  const out = acc ?? { count: 0, sum: 0 }
  out.count += Number(bucket.deal_count) || 0
  out.sum += Number(bucket.value_sum) || 0
  return out
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

export default function PipelinePivotView({ buckets, stages }) {
  const { t } = useTranslation()

  const [rowDim, setRowDim] = useState('stage')
  // Was 'status', which is not one of the dimensions: the picker showed
  // "Salesperson" while the grid put every deal in a single "Unknown" column.
  const [colDim, setColDim] = useState('salesperson')
  const [measure, setMeasure] = useState('count')

  const stageMap = useMemo(() => Object.fromEntries(stages.map((s) => [s.id, s])), [stages])

  const { rowKeys, colKeys, cells, rowTotals, colTotals, grandTotal } = useMemo(() => {
    const raw = {}
    const rowSet = new Set()
    const colSet = new Set()

    const all = { count: 0, sum: 0 }
    for (const bucket of buckets) {
      const rk = getDimValue(bucket, rowDim, stageMap, t)
      const ck = getDimValue(bucket, colDim, stageMap, t)
      rowSet.add(rk)
      colSet.add(ck)
      const key = `${rk}\x00${ck}`
      raw[key] = add(raw[key], bucket)
      add(all, bucket)
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
    const rowAcc = {}
    const colAcc = {}

    for (const rk of rowKeys) {
      for (const ck of colKeys) {
        const key = `${rk}\x00${ck}`
        const acc = raw[key]
        cells[key] = calcMeasure(acc, measure)
        if (!acc) continue
        rowAcc[rk] = add(rowAcc[rk], { deal_count: acc.count, value_sum: acc.sum })
        colAcc[ck] = add(colAcc[ck], { deal_count: acc.count, value_sum: acc.sum })
      }
    }

    const rowTotals = Object.fromEntries(rowKeys.map((rk) => [rk, calcMeasure(rowAcc[rk], measure)]))
    const colTotals = Object.fromEntries(colKeys.map((ck) => [ck, calcMeasure(colAcc[ck], measure)]))
    const grandTotal = calcMeasure(all, measure)

    return { rowKeys, colKeys, cells, rowTotals, colTotals, grandTotal }
  }, [buckets, rowDim, colDim, measure, stageMap, stages, t])

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
                  className={`px-4 py-3 text-start text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] min-w-[160px] border-r ${BORDER}`}
                >
                  <span>{t(`pipeline.pivotDim_${rowDim}`)}</span>
                  <span className="mx-1 opacity-40">/</span>
                  <span>{t(`pipeline.pivotDim_${colDim}`)}</span>
                </th>
                {colKeys.map((ck) => (
                  <th
                    key={ck}
                    className="px-4 py-3 text-end text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] whitespace-nowrap"
                  >
                    {ck}
                  </th>
                ))}
                <th
                  className={`px-4 py-3 text-end text-xs font-bold text-[#211f1b] dark:text-[#e8ebf0] whitespace-nowrap border-l ${BORDER}`}
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
                          className={`px-4 py-2.5 text-end text-xs ${
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
                      className={`px-4 py-2.5 text-end text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0] border-l ${BORDER}`}
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
                      className="px-4 py-2.5 text-end text-xs font-bold text-[#211f1b] dark:text-[#e8ebf0]"
                    >
                      {fmt(colTotals[ck])}
                    </td>
                  ))}
                  <td
                    className={`px-4 py-2.5 text-end text-xs font-bold text-[#4338ca] dark:text-[#a5b4fc] border-l ${BORDER}`}
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
