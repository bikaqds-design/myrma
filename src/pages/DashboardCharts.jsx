import React from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Area, AreaChart, ResponsiveContainer } from 'recharts'

export default function DashboardCharts({ on, nav, weeklyTrend, monthlyTrend, chartGridColor, chartTickStyle, chartTooltipStyle, tk }) {
  const { t } = useTranslation()
  const cardStyle = {
    background: tk?.surface || '#fff',
    border: `1px solid ${tk?.border || '#e6e9ef'}`,
    borderRadius: 14,
    padding: 18,
  }
  const headStyle = { margin: '0 0 14px', fontSize: 13.5, fontWeight: 650, color: tk?.text || '#211f1b', letterSpacing: -0.1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }
  const accent = tk?.accent || '#4338ca'

  return (
    <>
      {on('weekly_trend') && (
        <div
          className="col-span-12 lg:col-span-6"
          style={{ ...cardStyle, cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          aria-label={t('dashboard.weeklyTrend')}
          onClick={nav('/rma-tickets')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav('/rma-tickets')(e) } }}
        >
          <h3 style={headStyle}>
            {t('dashboard.weeklyTrend')}
            <span style={{ fontSize: 11.5, fontWeight: 600, color: tk?.textFaint || '#777268' }}>{t('dashboard.last7Days')}</span>
          </h3>
          <ResponsiveContainer width="100%" height={196}>
            <AreaChart data={weeklyTrend}>
              <defs>
                <linearGradient id="wArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accent} stopOpacity="0.15" />
                  <stop offset="100%" stopColor={accent} stopOpacity="0" />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="" stroke={chartGridColor} vertical={false} />
              <XAxis dataKey="date" tick={chartTickStyle} axisLine={false} tickLine={false} />
              <YAxis tick={chartTickStyle} axisLine={false} tickLine={false} allowDecimals={false} width={24} />
              <Tooltip contentStyle={chartTooltipStyle} />
              <Area type="monotone" dataKey="tickets" stroke={accent} strokeWidth={2}
                fill="url(#wArea)" dot={{ fill: accent, r: 2.6 }} activeDot={{ r: 4 }} name={t('dashboard.ticketsLabel')} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {on('monthly_trend') && (
        <div
          className="col-span-12 lg:col-span-6"
          style={{ ...cardStyle, cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          aria-label={t('dashboard.monthlyTrend')}
          onClick={nav('/rma-tickets')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav('/rma-tickets')(e) } }}
        >
          <h3 style={headStyle}>
            {t('dashboard.monthlyTrend')}
            <span style={{ fontSize: 11.5, fontWeight: 600, color: tk?.textFaint || '#777268' }}>{t('dashboard.last30Days')}</span>
          </h3>
          <ResponsiveContainer width="100%" height={196}>
            <BarChart data={monthlyTrend}>
              <CartesianGrid strokeDasharray="" stroke={chartGridColor} vertical={false} />
              <XAxis dataKey="date" tick={{ ...chartTickStyle, fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis tick={chartTickStyle} axisLine={false} tickLine={false} allowDecimals={false} width={24} />
              <Tooltip contentStyle={chartTooltipStyle}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ''} />
              <Bar dataKey="tickets" fill={accent} fillOpacity={0.85} radius={[3, 3, 0, 0]} name={t('dashboard.ticketsLabel')} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  )
}
