import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts'
import { useAppearance } from '../../contexts/AppearanceContext'
import { DIMENSIONS, groupBuckets, sortDimensionKeys, summarizeBuckets } from './_shared'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'

/**
 * PurchasingGraphView — spend analytics over purchase documents.
 *
 * Mirrors PipelineGraphView's shape (measure / group-by / chart-type toggle,
 * same Recharts setup and theme handling) so the two analytics screens behave
 * identically. What differs is the question being asked: the pipeline reports
 * revenue coming in, this reports spend going out.
 *
 * Group-by 'vendor' is the one that earns this screen — "who are we spending the
 * most with" is not answerable anywhere else in the app; AP Aging only shows what
 * is still owed, not what has been ordered.
 *
 * Cancelled documents are excluded from spend: money on a cancelled PO or a
 * voided vendor invoice was never committed, and counting it would overstate
 * every total. The count measure excludes them too, so the two measures always
 * describe the same population.
 *
 * It reads `buckets` — the matching documents counted and summed in the
 * database per type × status × vendor × month (BUG-066) — not the documents
 * themselves, so its numbers cover every document and not the first 1 000.
 */

const MEASURES = ['count', 'spend']
const PIE_COLORS = [
  '#4338ca',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
]

function ChartTypeBtn({ active, onClick, children, title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 flex items-center justify-center rounded-lg text-sm transition-colors ${
        active
          ? 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]'
          : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520]'
      }`}
    >
      {children}
    </button>
  )
}

export default function PurchasingGraphView({ buckets }) {
  const { t } = useTranslation()
  // Spend is summed in base currency, so the axis and tooltips have to be
  // labelled with the base currency rather than a fixed string in the locale
  // file — that said EGP whatever the system was actually configured to use.
  const baseCurrency = useBaseCurrency()
  const { darkMode } = useAppearance()

  const [measure, setMeasure] = useState('spend')
  const [groupBy, setGroupBy] = useState('vendor')
  const [chartType, setChartType] = useState('bar')

  const chartData = useMemo(() => {
    const groups = groupBuckets(buckets, groupBy, t)
    return sortDimensionKeys([...groups.keys()], groupBy, (k) => groups.get(k)[measure]).map(
      (k) => ({ name: k, ...groups.get(k) })
    )
  }, [buckets, groupBy, measure, t])

  const totals = useMemo(() => {
    const s = summarizeBuckets(buckets)
    return { docs: s.liveDocuments, spend: s.spend, vendors: s.vendors }
  }, [buckets])

  const axisColor = darkMode ? '#9aa4b2' : '#6c6760'
  const gridColor = darkMode ? '#212a38' : '#e6e9ef'
  const barColor = darkMode ? '#a5b4fc' : '#4338ca'
  const tooltipBg = darkMode ? '#121823' : '#ffffff'
  const tooltipLabel = darkMode ? '#e8ebf0' : '#211f1b'

  const measureLabel =
    measure === 'count' ? t('purchasing.graphMeasureCount') : t('purchasing.graphMeasureSpend')

  const yFmt = (v) => (measure === 'spend' ? Number(v).toLocaleString() : v)
  const tooltipFmt = (v) =>
    measure === 'spend'
      ? [`${Number(v).toLocaleString()} ${baseCurrency}`, measureLabel]
      : [v, measureLabel]

  const tooltipStyle = { backgroundColor: tooltipBg, border: `1px solid ${gridColor}`, borderRadius: 8 }
  const sharedGrid = <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
  const sharedXAxis = (
    <XAxis dataKey="name" tick={{ fill: axisColor, fontSize: 11 }} angle={-25} textAnchor="end" interval={0} height={50} />
  )
  const sharedYAxis = <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickFormatter={yFmt} width={55} />
  const sharedTooltip = (
    <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: tooltipLabel, fontWeight: 600, fontSize: 12 }} formatter={tooltipFmt} />
  )

  const renderChart = () => {
    if (chartData.length === 0) {
      return (
        <div className="h-[360px] flex items-center justify-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
          {t('purchasing.graphEmpty')}
        </div>
      )
    }

    if (chartType === 'bar') {
      return (
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={chartData} margin={{ top: 10, right: 20, bottom: 50, left: 10 }}>
            {sharedGrid}
            {sharedXAxis}
            {sharedYAxis}
            {sharedTooltip}
            <Bar dataKey={measure} fill={barColor} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )
    }

    if (chartType === 'line') {
      return (
        <ResponsiveContainer width="100%" height={360}>
          <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 50, left: 10 }}>
            {sharedGrid}
            {sharedXAxis}
            {sharedYAxis}
            {sharedTooltip}
            <Line
              type="monotone"
              dataKey={measure}
              stroke={barColor}
              strokeWidth={2}
              dot={{ r: 4, fill: barColor, strokeWidth: 0 }}
              activeDot={{ r: 6 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )
    }

    return (
      <ResponsiveContainer width="100%" height={360}>
        <PieChart>
          <Pie data={chartData} dataKey={measure} nameKey="name" cx="50%" cy="50%" outerRadius={120} label>
            {chartData.map((entry, i) => (
              <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: tooltipLabel, fontWeight: 600, fontSize: 12 }} formatter={tooltipFmt} />
          <Legend wrapperStyle={{ fontSize: 12, color: axisColor }} />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  const selectCls =
    'px-3 py-1.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none'

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.graphMeasure')}</label>
            <select value={measure} onChange={(e) => setMeasure(e.target.value)} className={selectCls}>
              {MEASURES.map((m) => (
                <option key={m} value={m}>
                  {m === 'count' ? t('purchasing.graphMeasureCount') : t('purchasing.graphMeasureSpend')}
                </option>
              ))}
            </select>
            <label className="text-xs text-[#6c6760] dark:text-[#9aa4b2] ms-2">{t('purchasing.graphGroupBy')}</label>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={selectCls}>
              {DIMENSIONS.map((g) => (
                <option key={g} value={g}>
                  {t(`purchasing.graphGroup_${g}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <ChartTypeBtn active={chartType === 'bar'} onClick={() => setChartType('bar')} title={t('purchasing.graphBar')}>▊</ChartTypeBtn>
            <ChartTypeBtn active={chartType === 'line'} onClick={() => setChartType('line')} title={t('purchasing.graphLine')}>⟋</ChartTypeBtn>
            <ChartTypeBtn active={chartType === 'pie'} onClick={() => setChartType('pie')} title={t('purchasing.graphPie')}>◕</ChartTypeBtn>
          </div>
        </div>

        <h3 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-2">
          {measureLabel} · {t(`purchasing.graphGroup_${groupBy}`)}
        </h3>
        {renderChart()}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile label={t('purchasing.statDocuments')} value={totals.docs.toLocaleString()} />
        <StatTile label={t('purchasing.statTotalSpend')} value={`${totals.spend.toLocaleString()} ${baseCurrency}`} />
        <StatTile label={t('purchasing.statVendors')} value={totals.vendors.toLocaleString()} />
      </div>

      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.graphExcludesCancelled')}</p>
    </div>
  )
}

function StatTile({ label, value }) {
  return (
    <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-4">
      <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mb-1">{label}</div>
      <div className="text-xl font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{value}</div>
    </div>
  )
}
