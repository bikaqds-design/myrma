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

const MEASURES = ['count', 'revenue']
const GROUP_BY = ['stage', 'salesperson', 'month']
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

export default function PipelineGraphView({ deals, stages }) {
  const { t } = useTranslation()
  const { darkMode } = useAppearance()

  const [measure, setMeasure] = useState('count')
  const [groupBy, setGroupBy] = useState('stage')
  const [chartType, setChartType] = useState('bar')

  const stageMap = useMemo(() => Object.fromEntries(stages.map((s) => [s.id, s])), [stages])

  const chartData = useMemo(() => {
    const groups = {}
    for (const deal of deals) {
      let key
      if (groupBy === 'stage') key = stageMap[deal.stage]?.name ?? t('common.unknown')
      else if (groupBy === 'salesperson') key = deal.assigned_rep || t('pipeline.unassigned')
      else if (groupBy === 'month')
        key = deal.created_at
          ? new Date(deal.created_at).toLocaleDateString('en', { year: 'numeric', month: 'short' })
          : t('common.unknown')

      if (!groups[key]) groups[key] = { name: key, count: 0, revenue: 0 }
      groups[key].count += 1
      groups[key].revenue += Number(deal.value) || 0
    }

    if (groupBy === 'stage') {
      const stageOrder = {}
      stages.forEach((s, i) => {
        stageOrder[s.name] = i
      })
      return Object.values(groups).sort(
        (a, b) => (stageOrder[a.name] ?? 999) - (stageOrder[b.name] ?? 999)
      )
    }
    return Object.values(groups).sort((a, b) => b[measure] - a[measure])
  }, [deals, groupBy, stageMap, stages, measure, t])

  const axisColor = darkMode ? '#768292' : '#9aa4b2'
  const gridColor = darkMode ? '#212a38' : '#e6e9ef'
  const barColor = darkMode ? '#a5b4fc' : '#4338ca'
  const tooltipBg = darkMode ? '#121823' : '#fff'
  const tooltipLabel = darkMode ? '#e8ebf0' : '#211f1b'

  const measureLabel =
    measure === 'count' ? t('pipeline.graphMeasureCount') : t('pipeline.graphMeasureRevenue')
  const yFmt = (v) =>
    measure === 'revenue'
      ? v >= 1000
        ? `${(v / 1000).toFixed(0)}k`
        : String(v)
      : String(v)
  const tooltipFmt = (v) =>
    measure === 'revenue'
      ? [`${Number(v).toLocaleString()} ${t('pipeline.currency')}`, measureLabel]
      : [v, measureLabel]

  const tooltipStyle = {
    backgroundColor: tooltipBg,
    border: `1px solid ${gridColor}`,
    borderRadius: 8,
  }

  const sharedXAxis = (
    <XAxis
      dataKey="name"
      tick={{ fill: axisColor, fontSize: 11 }}
      angle={-25}
      textAnchor="end"
      interval={0}
      height={50}
    />
  )
  const sharedYAxis = (
    <YAxis tick={{ fill: axisColor, fontSize: 11 }} tickFormatter={yFmt} width={45} />
  )
  const sharedGrid = <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
  const sharedTooltip = (
    <Tooltip
      contentStyle={tooltipStyle}
      labelStyle={{ color: tooltipLabel, fontWeight: 600, fontSize: 12 }}
      formatter={tooltipFmt}
    />
  )

  const renderChart = () => {
    if (chartData.length === 0) {
      return (
        <div className="h-[360px] flex items-center justify-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
          {t('pipeline.listEmpty')}
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

    // pie
    return (
      <ResponsiveContainer width="100%" height={360}>
        <PieChart>
          <Pie
            data={chartData}
            dataKey={measure}
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={130}
            label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
            labelLine={false}
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} formatter={tooltipFmt} />
          <Legend wrapperStyle={{ fontSize: 12, color: axisColor }} />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  const wonCount = deals.filter((d) => d.status === 'won').length
  const totalCount = deals.length
  const winRate = totalCount > 0 ? ((wonCount / totalCount) * 100).toFixed(0) : 0
  const totalRevenue = deals.reduce((s, d) => s + (Number(d.value) || 0), 0)
  const wonRevenue = deals
    .filter((d) => d.status === 'won')
    .reduce((s, d) => s + (Number(d.value) || 0), 0)

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Measures */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.graphMeasures')}:
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
                {m === 'count' ? t('pipeline.graphMeasureCount') : t('pipeline.graphMeasureRevenue')}
              </button>
            ))}
          </div>
        </div>

        {/* Group by */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.graphGroupBy')}:
          </span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            className="text-xs rounded-lg border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          >
            {GROUP_BY.map((g) => (
              <option key={g} value={g}>
                {t(`pipeline.graphGroup_${g}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Chart type */}
        <div className="flex gap-1 ms-auto">
          <ChartTypeBtn active={chartType === 'bar'} onClick={() => setChartType('bar')} title="Bar chart">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <rect x="1" y="6" width="3" height="9" rx="1" />
              <rect x="6" y="3" width="3" height="12" rx="1" />
              <rect x="11" y="1" width="3" height="14" rx="1" />
            </svg>
          </ChartTypeBtn>
          <ChartTypeBtn active={chartType === 'line'} onClick={() => setChartType('line')} title="Line chart">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <polyline points="1,12 5,7 9,9 15,3" />
            </svg>
          </ChartTypeBtn>
          <ChartTypeBtn active={chartType === 'pie'} onClick={() => setChartType('pie')} title="Pie chart">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2v5h5a5 5 0 01-5 5V3z" />
            </svg>
          </ChartTypeBtn>
        </div>
      </div>

      {/* Chart card */}
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-6">
        <h3 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-4">
          {measureLabel} {t('pipeline.graphBy')} {t(`pipeline.graphGroup_${groupBy}`)}
        </h3>
        {renderChart()}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: t('pipeline.statTotalDeals'), value: totalCount },
          {
            label: t('pipeline.statTotalRevenue'),
            value: `${totalRevenue.toLocaleString()} ${t('pipeline.currency')}`,
          },
          {
            label: t('pipeline.statWonDeals'),
            value: `${wonCount} (${winRate}%)`,
          },
          {
            label: t('pipeline.statWonRevenue'),
            value: `${wonRevenue.toLocaleString()} ${t('pipeline.currency')}`,
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4"
          >
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{stat.label}</p>
            <p className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0] mt-1">{stat.value}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
