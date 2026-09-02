import React from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Area, AreaChart, ResponsiveContainer } from 'recharts'

/**
 * One trend chart body — no card, no grid column.
 *
 * This used to render both charts complete with their own `col-span` wrappers
 * and card chrome, which meant the dashboard could not control their width or
 * position: they were two fixed half-width cards wherever the component was
 * placed. Now the widget shell owns the card and the size, and this renders
 * only what goes inside it, so a trend chart resizes like every other widget.
 *
 * Kept lazy-loaded — recharts is the single largest dependency on the page.
 */
export default function DashboardChart({
  kind,
  data,
  chartGridColor,
  chartTickStyle,
  chartTooltipStyle,
  tk,
  height = 196,
}) {
  const { t } = useTranslation()
  const accent = tk?.accent || '#4338ca'
  const headStyle = {
    margin: '0 0 14px',
    fontSize: 13.5,
    fontWeight: 650,
    color: tk?.text || '#211f1b',
    letterSpacing: -0.1,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  }
  const captionStyle = { fontSize: 11.5, fontWeight: 600, color: tk?.textFaint || '#777268' }

  if (kind === 'monthly') {
    return (
      <>
        <h3 style={headStyle}>
          {t('dashboard.monthlyTrend')}
          <span style={captionStyle}>{t('dashboard.last30Days')}</span>
        </h3>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="" stroke={chartGridColor} vertical={false} />
            <XAxis dataKey="date" tick={{ ...chartTickStyle, fontSize: 9 }} axisLine={false} tickLine={false} />
            <YAxis tick={chartTickStyle} axisLine={false} tickLine={false} allowDecimals={false} width={24} />
            <Tooltip contentStyle={chartTooltipStyle}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ''} />
            <Bar dataKey="tickets" fill={accent} fillOpacity={0.85} radius={[3, 3, 0, 0]} name={t('dashboard.ticketsLabel')} />
          </BarChart>
        </ResponsiveContainer>
      </>
    )
  }

  return (
    <>
      <h3 style={headStyle}>
        {t('dashboard.weeklyTrend')}
        <span style={captionStyle}>{t('dashboard.last7Days')}</span>
      </h3>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data}>
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
    </>
  )
}
