import React from 'react'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

const COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#ef4444',
  '#14b8a6',
]
const PRIORITY_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#10b981']

function WidgetCard({ title, icon, onClick, children, className = '' }) {
  return (
    <div
      onClick={onClick}
      className={`bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 p-6 ${onClick ? 'cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-500 transition-all' : ''} ${className}`}
    >
      {title && (
        <h2 className="text-base font-semibold text-gray-900 dark:text-slate-100 mb-4 flex items-center gap-2">
          {icon && <span className="text-indigo-600 dark:text-indigo-400">{icon}</span>}
          {title}
          {onClick && (
            <svg
              className="w-3.5 h-3.5 text-gray-500 dark:text-slate-500 ml-auto flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </h2>
      )}
      {children}
    </div>
  )
}

export default function DashboardCharts({
  on,
  nav,
  weeklyTrend,
  monthlyTrend,
  statusDist,
  priorityDist,
  technicianPerformance,
  chartGridColor,
  chartTickStyle,
  chartTooltipStyle,
}) {
  return (
    <>
      {on('weekly_trend') && (
        <WidgetCard
          className="lg:col-span-2"
          title="Weekly Trend"
          onClick={nav('/rma-tickets')}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
              />
            </svg>
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={weeklyTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
              <XAxis dataKey="date" tick={chartTickStyle} />
              <YAxis tick={chartTickStyle} allowDecimals={false} />
              <Tooltip contentStyle={chartTooltipStyle} />
              <Line
                type="monotone"
                dataKey="tickets"
                stroke="#6366f1"
                strokeWidth={2}
                dot={{ fill: '#6366f1', r: 3 }}
                name="Tickets"
              />
            </LineChart>
          </ResponsiveContainer>
        </WidgetCard>
      )}

      {on('monthly_trend') && (
        <WidgetCard
          className="lg:col-span-2"
          title="Monthly Trend (30 days)"
          onClick={nav('/rma-tickets')}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
          }
        >
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
              <XAxis dataKey="date" tick={{ ...chartTickStyle, fontSize: 10 }} />
              <YAxis tick={chartTickStyle} allowDecimals={false} />
              <Tooltip
                contentStyle={chartTooltipStyle}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ''}
              />
              <Bar dataKey="tickets" fill="#6366f1" radius={[2, 2, 0, 0]} name="Tickets" />
            </BarChart>
          </ResponsiveContainer>
        </WidgetCard>
      )}

      {on('status_distribution') && (
        <WidgetCard
          title="Status Distribution"
          onClick={nav('/rma-tickets')}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"
              />
            </svg>
          }
        >
          {statusDist.length === 0 ? (
            <p className="text-center text-gray-500 py-8 text-sm">No data</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={statusDist}
                  cx="50%"
                  cy="50%"
                  outerRadius={85}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {statusDist.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={chartTooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </WidgetCard>
      )}

      {on('priority_distribution') && (
        <WidgetCard
          title="Priority Distribution"
          onClick={nav('/rma-tickets')}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"
              />
            </svg>
          }
        >
          {priorityDist.length === 0 ? (
            <p className="text-center text-gray-500 py-8 text-sm">No data</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={priorityDist}
                  cx="50%"
                  cy="50%"
                  outerRadius={85}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  labelLine={false}
                >
                  {priorityDist.map((_, i) => (
                    <Cell key={i} fill={PRIORITY_COLORS[i % PRIORITY_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={chartTooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </WidgetCard>
      )}

      {on('technician_performance') && (
        <WidgetCard
          className="lg:col-span-3"
          title="Technician Performance"
          onClick={nav('/rma-tickets')}
          icon={
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          }
        >
          {technicianPerformance.length === 0 ? (
            <p className="text-center text-gray-500 py-8 text-sm">No assigned tickets</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={technicianPerformance} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} horizontal={false} />
                <XAxis type="number" tick={chartTickStyle} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={chartTickStyle} width={110} />
                <Tooltip contentStyle={chartTooltipStyle} />
                <Legend />
                <Bar dataKey="total" fill="#6366f1" name="Total Tickets" radius={[0, 2, 2, 0]} />
                <Bar dataKey="closed" fill="#10b981" name="Closed" radius={[0, 2, 2, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </WidgetCard>
      )}
    </>
  )
}
