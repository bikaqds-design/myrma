import { Link } from 'react-router-dom'
import React, { useState, useEffect, useMemo, useCallback, Suspense, lazy } from 'react'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { db, supabase } from '../api/supabaseClient'
import { safeStorage } from '../lib/safeStorage'
import { isPastDueLocal, daysPastDueLocal, daysUntilDueLocal } from '../lib/dates'
import {
  WIDGET_CATALOG,
  WIDGET_SIZES,
  SIZE_CLASS,
  SIZE_MIN_HEIGHT,
  resolveDashboardLayout,
  toStoredWidgetPrefs,
} from '../lib/dashboardWidgets'
import { canDo } from '../lib/permissions'
import { formatMoneyCompact } from '../lib/money'
import { useBaseCurrency } from '../hooks/useBaseCurrency'
import { useAppearance } from '../contexts/AppearanceContext'
import { Ltr } from '../components/ui'
import { TICKET_STATUS, TICKET_STATUS_LIST, ROLES } from '../lib/constants'
import { useTranslation } from 'react-i18next'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import { StatsAndTableSkeleton } from '../components/Skeleton'

const DashboardChart = lazy(() => import('./DashboardCharts'))

// Catalog moved to lib/dashboardWidgets so AccountSettings can read it without
// importing this page. Re-exported because existing imports point here.
export { WIDGET_CATALOG }
// ── Design tokens ─────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  Open:          '#3b82f6',
  'In Progress': '#6366f1',
  Pending:       '#f59e0b',
  'On Hold':     '#eab308',
  Completed:     '#14b8a6',
  Closed:        '#10b981',
  Cancelled:     '#94a3b8',
  Overdue:       '#ef4444',
}
const PRIORITY_COLOR = {
  Critical: '#ef4444',
  High:     '#f59e0b',
  Medium:   '#6366f1',
  Low:      '#94a3b8',
}
function tokens(dark) {
  return {
    accent:      dark ? '#a5b4fc' : '#4338ca',
    // Ink for text sitting *on* the accent. The dark-mode accent is light, so
    // white fails on it; the light-mode accent is deep indigo, where white is
    // the only thing that works.
    onAccent:    dark ? '#0b0f17' : '#ffffff',
    surface:     dark ? '#121823' : '#ffffff',
    surfaceInset:dark ? '#0e131c' : '#f7f8fb',
    border:      dark ? '#212a38' : '#e6e9ef',
    borderSoft:  dark ? '#1a2230' : '#eef0f4',
    text:        dark ? '#e8ebf0' : '#211f1b',
    textMuted:   dark ? '#9aa4b2' : '#6c6760',
    // textFaint at #646f7e / #a39e95 failed WCAG AA against every surface it is
    // used on — 3.49:1 on the dark card, 2.66:1 on the light one, against a 4.5:1
    // requirement for body text. These are the smallest type on the page (11px
    // captions, axis ticks, "this month" subtitles), so they were the hardest to
    // read and the least legible. Nudged until the worst pairing clears 4.5:1
    // (dark 4.56, light 4.61 against the page background) while staying visibly
    // dimmer than textMuted, which
    // already passes at 7.05 / 5.61 and is unchanged.
    textFaint:   dark ? '#768292' : '#746f66',
    track:       dark ? '#212a38' : '#eaedf2',
    grid:        dark ? '#1a2230' : '#eef1f5',
    // The light-mode semantic pair failed too, and by more than textFaint did:
    // #10b981 measured 2.54:1 and #ef4444 3.30:1 against the page. They carry the
    // numbers people actually read — "2 deals won", "43d overdue" — so they were
    // the worst offenders on the page rather than incidental. Darkened until the
    // page background, the dimmest of the three light surfaces, clears 4.5:1 —
    // and specifically against the 12%-alpha tint of themselves that the pills
    // use as a background ('1e' suffix), which is darker than the plain card and
    // was why a first pass at 4.54 still measured 4.16 in the browser.
    // The dark-mode pair already passes at 9.25 and 6.43 and is untouched.
    good:        dark ? '#34d399' : '#0a7451',
    bad:         dark ? '#f87171' : '#c61111',
    warn:        dark ? '#fbbf24' : '#f59e0b',
  }
}

// ── Primitives ────────────────────────────────────────────────────────────────

function SvgGauge({ percent, color, tk, size = 132 }) {
  const thickness = 12
  const r = (size - thickness) / 2
  const cx = size / 2
  const C = 2 * Math.PI * r
  const len = (Math.max(0, Math.min(percent, 100)) / 100) * C
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={tk.track} strokeWidth={thickness} />
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth={thickness}
        strokeLinecap="round" strokeDasharray={`${len} ${C - len}`}
        transform={`rotate(-90 ${cx} ${cx})`}
        style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(.2,.7,.3,1)' }} />
      <text x={cx} y={cx - 2} textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: 32, fontWeight: 700, letterSpacing: -0.5 }} fill={tk.text}>
        {percent}%
      </text>
      <text x={cx} y={cx + 22} textAnchor="middle"
        style={{ fontSize: 11, fontWeight: 500, letterSpacing: 0.3 }} fill={tk.textFaint}>
        on-time
      </text>
    </svg>
  )
}

function SvgDonut({ segments, tk, size = 108 }) {
  const thickness = 11
  const r = (size - thickness) / 2
  const cx = size / 2
  const C = 2 * Math.PI * r
  const total = segments.reduce((s, d) => s + d.value, 0) || 1
  const gap = 3
  let acc = 0
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={tk.track} strokeWidth={thickness} />
        {segments.map((s, i) => {
          const frac = s.value / total
          const len = Math.max(frac * C - gap, 0)
          const el = (
            <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={s.color}
              strokeWidth={thickness} strokeLinecap="round"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-acc * C}
              transform={`rotate(-90 ${cx} ${cx})`} />
          )
          acc += frac
          return el
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 21, fontWeight: 760, color: tk.text, fontVariantNumeric: 'tabular-nums' }}>
          {total}
        </span>
      </div>
    </div>
  )
}

function Sparkline({ data, color, width = 76, height = 30 }) {
  if (!data || data.length < 2) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data)
  const rng = max - min || 1
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - ((v - min) / rng) * (height - 4) - 2,
  ])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ flexShrink: 0 }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


/**
 * Text ink for a pill whose background is a 12% tint of its own colour.
 *
 * STATUS_COLOR and PRIORITY_COLOR are chart colours: vivid, tuned to be legible
 * as fills and strokes, and shared by the donuts and sparklines. Used directly
 * as *text* on `color + '1e'` they mostly fail AA — the whole palette does in
 * light mode, where mid-bright hues on near-white have nowhere to go, and half
 * of it does in dark. Measured worst case was "On Hold" at 1.78:1.
 *
 * Changing the palette would drag the charts with it, so the swatch, the dot and
 * the tint keep the original colour and only the glyphs move: lightened in dark,
 * darkened in light, just until the text clears 4.5:1 against the tint the
 * original colour produces. Hue and saturation are untouched, so a pill still
 * reads as the same colour.
 *
 * Memoised because it runs per pill per render and the inputs are a tiny set.
 */
const inkCache = new Map()
function pillInk(hex, dark) {
  const key = hex + (dark ? 'd' : 'l')
  const hit = inkCache.get(key)
  if (hit) return hit

  const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const lin = (c) => (c /= 255) <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  const rgb = toRgb(hex)
  const card = dark ? [18, 24, 35] : [255, 255, 255]
  const alpha = 0x1e / 255
  const bg = rgb.map((c, i) => c * alpha + card[i] * (1 - alpha))

  // HSL round-trip so only lightness moves.
  const [r, g, b] = rgb.map((c) => c / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l0 = (max + min) / 2
  const d = max - min
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l0 - 1))
  let hue = 0
  if (d !== 0) {
    hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  const fromHsl = (l) => {
    const c = (1 - Math.abs(2 * l - 1)) * sat
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
    const m = l - c / 2
    const t = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
            : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]
    return t.map((v) => Math.round((v + m) * 255))
  }

  let out = hex
  for (let i = 0; i <= 200; i++) {
    const l = Math.min(Math.max(l0 + (dark ? 0.004 : -0.004) * i, 0), 1)
    const cand = fromHsl(l)
    if (contrast(cand, bg) >= 4.5) {
      out = '#' + cand.map((v) => v.toString(16).padStart(2, '0')).join('')
      break
    }
  }
  inkCache.set(key, out)
  return out
}

function StatusPill({ status, dark }) {
  const color = STATUS_COLOR[status] || '#94a3b8'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999,
      fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
      color: pillInk(color, dark), background: color + '1e', flexShrink: 0,
    }}>
      {/* the dot keeps the original vivid colour — it is a swatch, not text */}
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, display: 'inline-block' }} />
      {status}
    </span>
  )
}

function CardHead({ title, action, to, tk }) {
  // `action` is a caption for most widgets — "441 units", "Top 5 by close rate"
  // — and those are correctly not interactive. But "View all" on Recent Tickets
  // rendered as the same inert <span>: it read as a link and did nothing
  // (UX-DASH-004). A `to` makes it a real link; without one it stays a caption.
  const style = { fontSize: 11.5, fontWeight: 600, color: to ? tk.accent : tk.textFaint }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
      <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: tk.text, letterSpacing: -0.1 }}>{title}</h3>
      {action &&
        (to ? (
          <Link to={to} style={{ ...style, textDecoration: 'none' }}>
            {action}
          </Link>
        ) : (
          <span style={style}>{action}</span>
        ))}
    </div>
  )
}


function DonutWithLegend({ segments, tk }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1 }}>
      <SvgDonut segments={segments} tk={tk} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1, minWidth: 0 }}>
        {segments.slice(0, 5).map((s) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ color: tk.textMuted, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
            <span style={{ color: tk.text, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
/**
 * The card around every widget.
 *
 * Owns the four things each widget used to decide for itself, inconsistently:
 * its column span, its card chrome, whether clicking it goes anywhere, and what
 * the edit controls are. Widgets now supply only their contents.
 *
 * ── On drag and drop ────────────────────────────────────────────────────────
 *
 * Native HTML5 drag rather than the @hello-pangea/dnd used by the Pipeline
 * board. That library is built for vertical lists in columns and fights a
 * 12-column CSS grid where a card can be a quarter, a half or full width.
 *
 * Native drag has no touch support, so it cannot be the only way to rearrange.
 * The arrow buttons beside it do the same job, work on a phone, and are
 * reachable from the keyboard — which drag alone never is.
 */
export function WidgetShell({
  w, tk, t, index, total, editing, isDragging, bare,
  onOpen, onMove, onCycleSize, onRemove, onDragStart, onDragEnd, onDropOn, children,
}) {
  const clickable = !editing && !!w.href
  const label = t(w.labelKey)

  return (
    <div
      className={SIZE_CLASS[w.size]}
      draggable={editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { if (editing) e.preventDefault() }}
      onDrop={(e) => { if (editing) { e.preventDefault(); onDropOn() } }}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? t('dashboard.openWidget', { widget: label }) : undefined}
      style={{
        position: 'relative',
        background: tk.surface,
        border: `1px solid ${isDragging ? tk.accent : tk.border}`,
        borderRadius: 14,
        padding: bare ? 0 : 18,
        overflow: bare ? 'hidden' : undefined,
        display: 'flex',
        flexDirection: 'column',
        minHeight: SIZE_MIN_HEIGHT[w.size],
        cursor: editing ? 'grab' : clickable ? 'pointer' : 'default',
        opacity: isDragging ? 0.45 : 1,
        transition: 'opacity .15s, border-color .15s',
      }}
    >
      {editing && (
        <div
          // Sits above the widget's own content while arranging. Clicks here
          // must not reach the card, or every control would also navigate.
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: 8, insetInlineEnd: 8, zIndex: 2,
            display: 'flex', alignItems: 'center', gap: 4,
            background: tk.surfaceInset, border: `1px solid ${tk.border}`,
            borderRadius: 9, padding: 3,
          }}
        >
          <EditBtn tk={tk} onClick={() => onMove(w.id, -1)} disabled={index === 0} title={t('dashboard.moveEarlier')}>‹</EditBtn>
          <button
            type="button"
            onClick={() => onCycleSize(w.id)}
            title={t('dashboard.changeSize')}
            style={{
              height: 24, padding: '0 8px', border: 'none', borderRadius: 6,
              background: 'transparent', color: tk.textMuted,
              fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {t(`dashboard.size.${w.size}`)}
          </button>
          <EditBtn tk={tk} onClick={() => onMove(w.id, 1)} disabled={index === total - 1} title={t('dashboard.moveLater')}>›</EditBtn>
          <EditBtn tk={tk} onClick={() => onRemove(w.id)} title={t('dashboard.removeWidget', { widget: label })} danger>×</EditBtn>
        </div>
      )}
      {children}
    </div>
  )
}

function EditBtn({ tk, onClick, disabled, title, danger, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        width: 24, height: 24, border: 'none', borderRadius: 6,
        background: 'transparent',
        color: disabled ? tk.textFaint : danger ? tk.bad : tk.textMuted,
        fontSize: 15, lineHeight: 1, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  )
}


// Shown until the first summary arrives, so every derived figure is a number.
const EMPTY_TICKET_SUMMARY = {
  total: 0, resolved: 0, overdue: 0, tracked: 0,
  status_counts: [], priority_counts: {}, technicians: [], daily_created: {},
  products: { received: 0, under_repair: 0, repaired: 0, cant_repair: 0, rma_stock: 0 },
  top_issues: [],
}
const EMPTY_CRM = { open_value: 0, open_count: 0, won_this_month: 0, leads_this_month: 0, open_by_stage: [], won_by_rep: [] }
const EMPTY_MY_OPEN = { data: [], count: 0 }

export default function Dashboard({ currentUserEmail, currentUserRole, currentUserPermissions, onNavigate }) {
  const { darkMode } = useAppearance()
  const { t } = useTranslation()
  const baseCurrency = useBaseCurrency()
  const fmtCurrency = (v) => formatMoneyCompact(v, baseCurrency)
  const tk = tokens(darkMode)
  const chartTickStyle  = { fontSize: 10, fill: tk.textFaint }
  const chartGridColor  = tk.grid
  const chartTooltipStyle = darkMode
    ? { backgroundColor: '#121823', border: `1px solid ${tk.border}`, borderRadius: 8, color: tk.text }
    : { backgroundColor: '#fff',    border: `1px solid ${tk.border}`, borderRadius: 8 }
  const storageKey = `dashboard_widgets_${currentUserEmail}`

  // Can this user read the data behind a widget? Passed into the resolver so a
  // widget whose table the role cannot read is never rendered — a technician
  // cannot read deals at all, and a CRM card showing 0 reads as a broken widget
  // rather than a permission boundary.
  const can = useCallback(
    (section, action) => canDo(currentUserRole, currentUserPermissions, section, action),
    [currentUserRole, currentUserPermissions]
  )

  // resolveDashboardLayout, not a fallback list: a stored preference records what
  // is switched *off*, so widgets added to the catalog since it was saved are on
  // rather than invisible. The old fallback was AppearanceContext's ten-id array,
  // which predated the CRM widgets and hid all four of them.
  const [layout, setLayout] = useState(() =>
    resolveDashboardLayout(safeStorage.get(storageKey, null), can)
  )
  const [range, setRange] = useState('30d')
  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState(null)

  const queryClient = useQueryClient()
  // Every ticket figure is counted in the database for the chosen range
  // (rma_dashboard_ticket_summary, 20260863). The page used to load every
  // ticket and count them here — past the Data API's 1 000-row cap, the
  // Dashboard described some of the tickets as all of them. (BUG-066.)
  const since = useMemo(() => {
    if (range === 'All') return null
    const cutoff = new Date()
    if (range === 'Today') cutoff.setHours(0, 0, 0, 0)
    else cutoff.setDate(cutoff.getDate() - parseInt(range))
    return cutoff.toISOString()
  }, [range])
  const { data: ticketSummary, isLoading: loading } = useQuery({
    queryKey: ['dashboard', 'tickets', since],
    queryFn: () => db.dashboard.ticketSummary(since),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
  const summary = ticketSummary ?? EMPTY_TICKET_SUMMARY
  const { data: invStats = null } = useQuery({
    queryKey: ['inv-stats'],
    queryFn: () => db.inventory.getStats().catch(() => null),
    staleTime: 2 * 60_000,
  })
  // A ticket change can move any figure, so every Dashboard query refetches.
  useEffect(() => {
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    const channel = supabase
      .channel('dashboard-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rma_tickets' }, refresh)
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [queryClient])

  // Re-read when the account changes. Must resolve, like the initial state and
  // the change listener below — assigning the raw stored value here is what
  // crashed the page with "enabledWidgets.includes is not a function" once the
  // stored shape became { v, off }.
  useEffect(() => {
    setLayout(resolveDashboardLayout(safeStorage.get(storageKey, null), can))
  }, [storageKey, can])

  useEffect(() => {
    const handler = () => {
      // Resolve rather than assigning the raw value: the stored shape is an
      // object, and setting it directly would leave layout something that is
      // not an array. Resolving null too, so clearing the preference falls back
      // to the default set rather than rendering nothing.
      setLayout(resolveDashboardLayout(safeStorage.get(storageKey, null), can))
    }
    window.addEventListener('dashboard-widgets-changed', handler)
    return () => window.removeEventListener('dashboard-widgets-changed', handler)
  }, [storageKey, can])

  /** Write a new layout everywhere that reads it. */
  const persistLayout = useCallback(
    (next) => {
      setLayout(next)
      safeStorage.set(storageKey, toStoredWidgetPrefs(next))
      window.dispatchEvent(new Event('dashboard-widgets-changed'))
    },
    [storageKey]
  )

  const moveWidget = useCallback(
    (id, delta) => {
      setLayout((cur) => {
        const from = cur.findIndex((w) => w.id === id)
        const to = from + delta
        if (from < 0 || to < 0 || to >= cur.length) return cur
        const next = [...cur]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        safeStorage.set(storageKey, toStoredWidgetPrefs(next))
        window.dispatchEvent(new Event('dashboard-widgets-changed'))
        return next
      })
    },
    [storageKey]
  )

  /** Drop `dragId` in front of `targetId`. */
  const dropOn = useCallback(
    (targetId) => {
      if (!dragId || dragId === targetId) return
      setLayout((cur) => {
        const from = cur.findIndex((w) => w.id === dragId)
        const to = cur.findIndex((w) => w.id === targetId)
        if (from < 0 || to < 0) return cur
        const next = [...cur]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        safeStorage.set(storageKey, toStoredWidgetPrefs(next))
        window.dispatchEvent(new Event('dashboard-widgets-changed'))
        return next
      })
      setDragId(null)
    },
    [dragId, storageKey]
  )

  const cycleSize = useCallback(
    (id) => {
      const order = WIDGET_SIZES
      persistLayout(
        layout.map((w) =>
          w.id === id ? { ...w, size: order[(order.indexOf(w.size) + 1) % order.length] } : w
        )
      )
    },
    [layout, persistLayout]
  )

  const removeWidget = useCallback(
    (id) => persistLayout(layout.filter((w) => w.id !== id)),
    [layout, persistLayout]
  )

  const on = (id) => layout.some((w) => w.id === id)

  const { data: overdueFollowupCount = 0 } = useQuery({
    queryKey: ['dashboard', 'overdue-followups', 'count'],
    queryFn: () => db.activities.countOverdue(),
    staleTime: 60_000,
    enabled: on('overdue_followups') || on('crm_kpi'),
  })
  const { data: overdueFollowups = EMPTY_ARRAY } = useQuery({
    queryKey: ['dashboard', 'overdue-followups', 'first'],
    queryFn: () => db.activities.listOverdueFirst(8),
    staleTime: 60_000,
    enabled: on('overdue_followups'),
  })

  // Open pipeline, won and leads this month, the stage and rep breakdowns — all
  // summed in the database (rma_dashboard_crm) instead of over every deal and
  // lead loaded here.
  const monthStart = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString()
  }, [])
  const crmDataEnabled = on('crm_kpi') || on('pipeline_by_stage') || on('rep_leaderboard')
  const { data: crm = EMPTY_CRM } = useQuery({
    queryKey: ['dashboard', 'crm', monthStart],
    queryFn: () => db.dashboard.crm(monthStart),
    staleTime: 60_000,
    enabled: crmDataEnabled,
  })
  const { data: crmPipelines = EMPTY_ARRAY } = useQuery({
    queryKey: ['crm-pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
    enabled: on('pipeline_by_stage'),
  })

  const { data: recentTickets = EMPTY_ARRAY } = useQuery({
    queryKey: ['dashboard', 'recent-tickets'],
    queryFn: () => db.dashboard.recentTickets(8),
    staleTime: 60_000,
    enabled: on('recent_tickets'),
  })
  const { data: overdueList = EMPTY_ARRAY } = useQuery({
    queryKey: ['dashboard', 'overdue-tickets', since],
    queryFn: () => db.dashboard.overdueTickets(since, 8),
    staleTime: 60_000,
    enabled: on('overdue_tickets'),
  })
  const showMyOpen = currentUserRole === ROLES.TECHNICIAN || currentUserRole === ROLES.VIEWER
  const { data: myOpen = EMPTY_MY_OPEN } = useQuery({
    queryKey: ['dashboard', 'my-open-tickets', currentUserEmail],
    queryFn: () => db.dashboard.myOpenTickets(currentUserEmail, 6),
    staleTime: 60_000,
    enabled: showMyOpen && !!currentUserEmail,
  })
  const myOpenTickets = showMyOpen ? myOpen.data : EMPTY_ARRAY
  const myOpenCount = showMyOpen ? myOpen.count : 0

  const totalTickets = summary.total
  const closedTickets = summary.resolved
  const overdueCount = summary.overdue

  const statusCounts = useMemo(() => {
    const counts = {}
    TICKET_STATUS_LIST.forEach((s) => { counts[s] = 0 })
    summary.status_counts.forEach(({ status, count }) => { if (counts[status] !== undefined) counts[status] = count })
    return counts
  }, [summary])

  const invProductCounts = {
    allUnits:    invStats?.total ?? 0,
    received:    summary.products.received,
    underRepair: summary.products.under_repair,
    repaired:    summary.products.repaired,
    cantRepair:  summary.products.cant_repair,
    rmaStock:    summary.products.rma_stock,
  }

  // "On schedule" = tracked tickets (a due date, not cancelled) that are not
  // overdue; every overdue ticket is tracked, since cancelled ones are resolved.
  const trackedCount = summary.tracked
  const onScheduleCount = trackedCount - overdueCount
  const slaPercent = trackedCount > 0 ? Math.round((onScheduleCount / trackedCount) * 100) : 100
  const resolutionPercent = totalTickets > 0 ? Math.round((closedTickets / totalTickets) * 100) : 0

  const weeklyTrend = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      days.push({ date: d.toLocaleDateString('en-US', { weekday: 'short' }), tickets: summary.daily_created[ds] || 0 })
    }
    return days
  }, [summary])

  const monthlyTrend = useMemo(() => {
    const days = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      days.push({
        date: i % 6 === 0 ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
        fullDate: ds,
        tickets: summary.daily_created[ds] || 0,
      })
    }
    return days
  }, [summary])

  const statusDist = useMemo(
    () => summary.status_counts.map(({ status, count }) => ({ name: status, value: count, color: STATUS_COLOR[status] || '#94a3b8' })),
    [summary]
  )

  const priorityDist = useMemo(() => {
    const order = ['Critical', 'High', 'Medium', 'Low']
    const counts = summary.priority_counts
    return order.filter((p) => counts[p]).map((name) => ({ name, value: counts[name], color: PRIORITY_COLOR[name] || '#94a3b8' }))
  }, [summary])

  const technicianPerformance = useMemo(
    () =>
      summary.technicians
        .map(({ tech, total, closed }) => ({ name: tech || 'Unassigned', total, closed, closeRate: total > 0 ? Math.round((closed / total) * 100) : 0 }))
        .sort((a, b) => b.closeRate - a.closeRate)
        .slice(0, 5),
    [summary]
  )

  const topIssues = summary.top_issues

  const crmStats = {
    openPipelineValue: crm.open_value,
    dealsWonThisMonth: crm.won_this_month,
    leadsThisMonth: crm.leads_this_month,
  }

  const pipelineByStage = useMemo(() => {
    const allStages = crmPipelines.flatMap((p) => (p.stages || []).filter((s) => !s.is_won && !s.is_lost))
    const stageMap = {}
    crm.open_by_stage.forEach(({ stage, count, value }) => {
      const st = allStages.find((s) => s.id === stage)
      const name = st?.name || stage
      const order = st?.order ?? 99
      if (!stageMap[name]) stageMap[name] = { name, count: 0, value: 0, order }
      stageMap[name].count += count
      stageMap[name].value += value
    })
    return Object.values(stageMap).sort((a, b) => a.order - b.order)
  }, [crm, crmPipelines])

  const repLeaderboard = useMemo(
    () =>
      crm.won_by_rep
        .map(({ rep, count, value }) => ({ rep: rep || '—', count, value }))
        .sort((a, b) => b.count - a.count || b.value - a.value)
        .slice(0, 5),
    [crm]
  )

  const RANK_COLORS = ['#f59e0b', '#94a3b8', '#cd7f32']

  const daysBetween = (a) => Math.ceil((new Date() - new Date(a)) / 86400000)
  const openActive = (statusCounts[TICKET_STATUS.OPEN] || 0) + (statusCounts[TICKET_STATUS.IN_PROGRESS] || 0) +
    (statusCounts[TICKET_STATUS.PENDING] || 0) + (statusCounts[TICKET_STATUS.ON_HOLD] || 0)
  const sparkWeekly = weeklyTrend.map((d) => d.tickets)

  // Payload for the currently-hidden <AIAssist> panel. Kept (underscore-prefixed
  // to satisfy lint) because the ai-assist Edge Function and ai.assist() helper
  // are retained for future re-enabling — see CLAUDE.md.
  const _dashboardAIData = useMemo(() => ({
    range,
    open: statusCounts[TICKET_STATUS.OPEN] || 0,
    in_progress: statusCounts[TICKET_STATUS.IN_PROGRESS] || 0,
    pending: statusCounts[TICKET_STATUS.PENDING] || 0,
    overdue: overdueCount,
    resolved: closedTickets,
    total: totalTickets,
    sla_percent: slaPercent,
    resolution_rate: resolutionPercent,
  }), [range, statusCounts, overdueCount, closedTickets, totalTickets, slaPercent, resolutionPercent])

  if (loading) {
    return (
      <StatsAndTableSkeleton />
    )
  }

  const hasWidgets = layout.length > 0
  // Values stay canonical English so the filtering logic below is unchanged;
  // only the label shown to the user is translated (UX-DASH-001).
  const RANGES = ['Today', '7d', '30d', 'All']
  const rangeLabel = (r) => t(`dashboard.range.${r === '7d' ? 'd7' : r === '30d' ? 'd30' : r.toLowerCase()}`)

  // ── Widget bodies ───────────────────────────────────────────────────────────
  // One entry per catalog id, returning only what goes *inside* the card. The
  // card itself — width, border, padding, link, edit controls — belongs to
  // WidgetShell, so a widget no longer decides its own column span. That split
  // is what makes user-chosen sizes possible: the old code hardcoded a
  // `col-span` on every widget, which is why the catalog's `size` field was
  // decorative and the two could disagree.
  const renderers = {
    stat_tickets: () => (
      <>
        <div className="grid grid-cols-2 lg:grid-cols-4" style={{ gap: 1, background: tk.borderSoft }}>
          {[
            { label: t('dashboard.totalTickets'), value: totalTickets, color: tk.text, spark: sparkWeekly, delta: '+8%', deltaUp: true },
            { label: t('dashboard.activeOpen'),  value: openActive,   color: tk.accent, spark: [12,14,11,17,15,16,openActive], caption: t('dashboard.across4States') },
            { label: t('dashboard.overdue'),     value: overdueCount, color: tk.bad, spark: [3,4,5,4,6,6,overdueCount], caption: t('dashboard.needsAttention') },
            { label: t('dashboard.slaOntime'),   value: `${slaPercent}%`, color: tk.good, spark: [92,93,94,95,95,96,slaPercent], delta: '+2%', deltaUp: true },
          ].map(({ label, value, color, spark, delta, deltaUp, caption }) => (
            <div key={label} style={{ background: tk.surface, padding: 18, display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: tk.textMuted, letterSpacing: 0.1 }}>{label}</span>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 8 }}>
                <span style={{ fontSize: 40, fontWeight: 780, color, letterSpacing: -1.4, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
                <Sparkline data={spark} color={color} />
              </div>
              <div style={{ marginTop: 10 }}>
                {delta ? (
                  <span style={{ fontSize: 12, fontWeight: 700, color: deltaUp ? tk.good : tk.bad, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
                      style={{ transform: deltaUp ? 'none' : 'rotate(180deg)' }}>
                      <path d="M4.5 7.5V1.5M4.5 1.5L1.5 4.5M4.5 1.5L7.5 4.5" />
                    </svg>
                    {/* UX-DASH-002: a signed number inside RTL text renders as
                        `8%+` without isolation, which reads as a different value. */}
                    <Ltr>{delta}</Ltr>
                  </span>
                ) : (
                  <span style={{ fontSize: 12, color: tk.textMuted }}>{caption}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', overflowX: 'auto', borderTop: `1px solid ${tk.borderSoft}` }}>
          {[
            { label: t('statusValues.Open'),        value: statusCounts[TICKET_STATUS.OPEN],        navPath: `/rma-tickets?status=${TICKET_STATUS.OPEN}` },
            { label: t('statusValues.In Progress'), value: statusCounts[TICKET_STATUS.IN_PROGRESS], navPath: `/rma-tickets?status=${TICKET_STATUS.IN_PROGRESS}` },
            { label: t('statusValues.Pending'),     value: statusCounts[TICKET_STATUS.PENDING],     navPath: `/rma-tickets?status=${TICKET_STATUS.PENDING}` },
            { label: t('statusValues.On Hold'),     value: statusCounts[TICKET_STATUS.ON_HOLD],     navPath: `/rma-tickets?status=${TICKET_STATUS.ON_HOLD}` },
            { label: t('statusValues.Completed'),   value: statusCounts[TICKET_STATUS.COMPLETED],   navPath: `/rma-tickets?status=${TICKET_STATUS.COMPLETED}` },
            { label: t('statusValues.Closed'),      value: statusCounts[TICKET_STATUS.CLOSED],      navPath: `/rma-tickets?status=${TICKET_STATUS.CLOSED}` },
            { label: t('statusValues.Cancelled'),   value: statusCounts[TICKET_STATUS.CANCELLED],   navPath: `/rma-tickets?status=${TICKET_STATUS.CANCELLED}` },
            { label: t('statusValues.Overdue'),     value: overdueCount,                      navPath: '/rma-tickets?overdue=true' },
          ].map(({ label, value, navPath }, i) => {
            const color = STATUS_COLOR[label] || '#94a3b8'
            return (
              // stopPropagation so a status jumps to its filtered list rather
              // than the card's own link firing straight after it.
              <button key={label} onClick={(e) => { e.stopPropagation(); onNavigate?.(navPath) }}
                style={{
                  flex: 1, minWidth: 72, padding: '16px 8px',
                  borderLeft: i ? `1px solid ${tk.borderSoft}` : 'none',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  background: 'transparent', cursor: 'pointer', transition: 'background .15s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = tk.surfaceInset}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, color: tk.textMuted, fontWeight: 550 }}>{label}</span>
                </div>
                <div style={{ fontSize: 26, fontWeight: 760, color: tk.text, letterSpacing: -0.7, fontVariantNumeric: 'tabular-nums' }}>
                  {value ?? 0}
                </div>
              </button>
            )
          })}
        </div>
      </>
    ),

    crm_kpi: () => (
      <div className="grid grid-cols-2 lg:grid-cols-4" style={{ gap: 14 }}>
        {[
          { label: t('dashboard.openPipelineValue'), value: fmtCurrency(crmStats.openPipelineValue), color: tk.accent, caption: t('dashboard.openDealsCaption') },
          { label: t('dashboard.dealsWonThisMonth'), value: crmStats.dealsWonThisMonth,              color: tk.good,   caption: t('dashboard.thisMonth') },
          { label: t('dashboard.leadsThisMonth'),    value: crmStats.leadsThisMonth,                 color: '#6366f1', caption: t('dashboard.thisMonth') },
          { label: t('dashboard.overdueFollowupsKpi'), value: overdueFollowupCount,               color: tk.bad,    caption: t('dashboard.needsAttention') },
        ].map(({ label, value, color, caption }) => (
          <div key={label} style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: tk.textMuted, letterSpacing: 0.1 }}>{label}</span>
            <div style={{ display: 'flex', alignItems: 'flex-end', marginTop: 8 }}>
              <span style={{ fontSize: 40, fontWeight: 780, color, letterSpacing: -1.4, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
            </div>
            <div style={{ marginTop: 10 }}>
              <span style={{ fontSize: 12, color: tk.textMuted }}>{caption}</span>
            </div>
          </div>
        ))}
      </div>
    ),

    stat_inventory: () => (
      <>
        <CardHead title={t('dashboard.inventorySnapshot')} action={`${invProductCounts.allUnits} ${t('dashboard.units')}`} tk={tk} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, flex: 1 }}>
          {[
            { label: t('inventory.received'),    value: invProductCounts.received,    color: '#0ea5e9' },
            { label: t('inventory.underRepair'), value: invProductCounts.underRepair, color: '#f97316' },
            { label: t('inventory.repaired'),    value: invProductCounts.repaired,    color: '#14b8a6' },
            { label: t('inventory.cantRepair'),  value: invProductCounts.cantRepair,  color: '#ef4444' },
            { label: t('inventory.rmaStock'),    value: invProductCounts.rmaStock,    color: '#6366f1' },
          ].map((c) => (
            <button key={c.label} onClick={(e) => { e.stopPropagation(); onNavigate?.('/inventory') }}
              style={{ background: tk.surfaceInset, borderRadius: 10, padding: '14px 12px', textAlign: 'left', border: 'none', cursor: 'pointer', transition: 'filter .15s' }}
              onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(0.95)'}
              onMouseLeave={(e) => e.currentTarget.style.filter = 'none'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                <span style={{ fontSize: 11, color: tk.textMuted, fontWeight: 550 }}>{c.label}</span>
              </div>
              <div style={{ fontSize: 24, fontWeight: 760, color: tk.text, letterSpacing: -0.6, fontVariantNumeric: 'tabular-nums' }}>{c.value}</div>
            </button>
          ))}
        </div>
      </>
    ),

    sla_health: () => (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <CardHead title={t('dashboard.slaHealth')} tk={tk} />
        <SvgGauge percent={slaPercent} color={slaPercent >= 80 ? tk.good : slaPercent >= 60 ? tk.warn : tk.bad} tk={tk} />
        <p style={{ margin: '10px 0 0', fontSize: 11.5, color: tk.textMuted, textAlign: 'center' }}>
          {onScheduleCount}/{trackedCount} {t('dashboard.onSchedule')}
        </p>
      </div>
    ),

    resolution_rate: () => (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <CardHead title={t('dashboard.resolutionRate')} tk={tk} />
        <SvgGauge percent={resolutionPercent} color={resolutionPercent >= 70 ? tk.good : resolutionPercent >= 40 ? tk.warn : tk.accent} tk={tk} />
        <p style={{ margin: '10px 0 0', fontSize: 11.5, color: tk.textMuted, textAlign: 'center' }}>
          {closedTickets}/{totalTickets} {t('dashboard.resolvedOrClosed')}
        </p>
      </div>
    ),

    status_distribution: () => (
      <>
        <CardHead title={t('dashboard.statusMix')} tk={tk} />
        {statusDist.length === 0
          ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>{t('common.noData')}</p>
          : <DonutWithLegend segments={statusDist} tk={tk} />}
      </>
    ),

    priority_distribution: () => (
      <>
        <CardHead title={t('dashboard.priorityMix')} tk={tk} />
        {priorityDist.length === 0
          ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', paddingTop: 20 }}>{t('common.noData')}</p>
          : <DonutWithLegend segments={priorityDist} tk={tk} />}
      </>
    ),

    pipeline_by_stage: () => (
      <>
        <CardHead title={t('dashboard.pipelineByStage')} action={t('dashboard.openDealsOnly')} tk={tk} />
        {pipelineByStage.length === 0 ? (
          <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>{t('dashboard.noOpenDeals')}</p>
        ) : (() => {
          const maxCount = Math.max(...pipelineByStage.map((s) => s.count), 1)
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {pipelineByStage.map((s) => (
                <div key={s.name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: tk.text }}>{s.name}</span>
                    <span style={{ fontSize: 12, color: tk.textMuted }}>{s.count} · {fmtCurrency(s.value)}</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: tk.track }}>
                    <div style={{ height: 6, borderRadius: 3, background: tk.accent, width: `${(s.count / maxCount) * 100}%`, transition: 'width 0.5s ease' }} />
                  </div>
                </div>
              ))}
            </div>
          )
        })()}
      </>
    ),

    rep_leaderboard: () => (
      <>
        <CardHead title={t('dashboard.repLeaderboard')} action={t('dashboard.dealsWonThisMonthLabel')} tk={tk} />
        {repLeaderboard.length === 0 ? (
          <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>{t('dashboard.noDealsWonYet')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {repLeaderboard.map((r, i) => (
              <div key={r.rep} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
                <span style={{ width: 24, height: 24, borderRadius: '50%', background: i < 3 ? RANK_COLORS[i] : tk.track, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: i < 3 ? '#1b1205' : tk.text, flexShrink: 0 }}>
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.rep}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: tk.good }}>{r.count}</div>
                  <div style={{ fontSize: 11, color: tk.textMuted }}>{fmtCurrency(r.value)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    ),

    overdue_followups: () => (
      <>
        <CardHead title={t('dashboard.overdueFollowups')} action={String(overdueFollowupCount)} tk={tk} />
        {overdueFollowupCount === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <svg className="mx-auto mb-2" width="32" height="32" fill="none" stroke={tk.good} strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p style={{ color: tk.good, fontSize: 13, fontWeight: 600, margin: 0 }}>{t('dashboard.allClear')}</p>
          </div>
        ) : overdueFollowups.slice(0, 8).map((a, i) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
              <div style={{ fontSize: 11.5, color: tk.textMuted }}>{a.assigned_rep ?? '—'}</div>
            </div>
            <span style={{ flexShrink: 0, marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, color: tk.bad, background: tk.bad + '1a' }}>
              {daysPastDueLocal(a.due_date)}d
            </span>
          </div>
        ))}
      </>
    ),

    recent_tickets: () => (
      <>
        <CardHead title={t('dashboard.recentTickets')} action={t('common.viewAll')} to="/rma-tickets" tk={tk} />
        {recentTickets.length === 0
          ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>{t('dashboard.noTicketsYet')}</p>
          : recentTickets.map((row, i) => (
            <div key={row.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 650, color: tk.text, width: 84, flexShrink: 0 }}>{row.rma_number || '—'}</span>
                <span style={{ fontSize: 12.5, color: tk.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.customer_name || '—'}</span>
              </div>
              <StatusPill status={row.ticket_status} dark={darkMode} />
            </div>
          ))}
      </>
    ),

    overdue_tickets: () => (
      <>
        <CardHead title={t('dashboard.overdueTickets')} action={String(overdueCount)} tk={tk} />
        {overdueCount === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <svg className="mx-auto mb-2" width="32" height="32" fill="none" stroke={tk.good} strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p style={{ color: tk.good, fontSize: 13, fontWeight: 600, margin: 0 }}>{t('dashboard.allClear')}</p>
          </div>
        ) : overdueList.slice(0, 8).map((row, i) => (
          <div key={row.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: i ? `1px solid ${tk.borderSoft}` : 'none' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: tk.text }}>{row.rma_number || '—'}</div>
              <div style={{ fontSize: 11.5, color: tk.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.customer_name || '—'}</div>
            </div>
            <span style={{ flexShrink: 0, marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, color: tk.bad, background: tk.bad + '1a' }}>
              {daysBetween(row.due_date)}d
            </span>
          </div>
        ))}
      </>
    ),

    top_issues: () => (
      <>
        <CardHead title={t('dashboard.topIssues')} tk={tk} />
        {topIssues.length === 0
          ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>{t('dashboard.noIssuesRecorded')}</p>
          : topIssues.map((item, idx) => {
            const maxCount = topIssues[0]?.count || 1
            return (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: idx ? 14 : 0 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: tk.textFaint, width: 14, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{idx + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, gap: 8 }}>
                    <span style={{ fontSize: 13, color: tk.text, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.issue}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: tk.textMuted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{item.count}</span>
                  </div>
                  <div style={{ height: 6, background: tk.track, borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(item.count / maxCount) * 100}%`, background: tk.accent, borderRadius: 3 }} />
                  </div>
                </div>
              </div>
            )
          })}
      </>
    ),

    technician_performance: () => (
      <>
        <CardHead title={t('dashboard.technicianPerformance')} action={t('dashboard.top5ByCloseRate')} tk={tk} />
        {technicianPerformance.length === 0
          ? <p style={{ color: tk.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>{t('dashboard.noAssignedTickets')}</p>
          : (
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', gap: 12, flex: 1, paddingTop: 6 }}>
              {technicianPerformance.map((tech) => (
                <div key={tech.name} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tk.text, fontVariantNumeric: 'tabular-nums' }}>{tech.closeRate}%</span>
                  <div style={{ width: '100%', maxWidth: 46, height: 120, background: tk.surfaceInset, borderRadius: 7, display: 'flex', alignItems: 'flex-end', overflow: 'hidden' }}>
                    <div style={{ width: '100%', height: `${tech.closeRate}%`, background: `linear-gradient(180deg, ${tk.accent}, ${tk.accent}8c)`, borderRadius: 6 }} />
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: tk.text, lineHeight: 1.3 }}>{tech.name}</div>
                    <div style={{ fontSize: 11, color: tk.textFaint }}>{tech.closed}/{tech.total} {t('dashboard.closedLabel')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
      </>
    ),

    weekly_trend: () => (
      <Suspense fallback={<div style={{ height: 196 }} />}>
        <DashboardChart kind="weekly" data={weeklyTrend} tk={tk}
          chartGridColor={chartGridColor} chartTickStyle={chartTickStyle} chartTooltipStyle={chartTooltipStyle} />
      </Suspense>
    ),

    monthly_trend: () => (
      <Suspense fallback={<div style={{ height: 196 }} />}>
        <DashboardChart kind="monthly" data={monthlyTrend} tk={tk}
          chartGridColor={chartGridColor} chartTickStyle={chartTickStyle} chartTooltipStyle={chartTooltipStyle} />
      </Suspense>
    ),
  }


  return (
    <div style={{ color: tk.text }}>
      {/* ── Page header ── */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 style={{ margin: 0, fontSize: 25, fontWeight: 750, letterSpacing: -0.5, color: tk.text }}>{t('dashboard.title')}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: tk.textMuted }}>{t('dashboard.systemOverview')} · {t('dashboard.updatedJustNow')}</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {/* Arranging your own dashboard is a personal preference, not an
              administrative act, so this is not gated on a permission. */}
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            aria-pressed={editing}
            style={{
              padding: '7px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 650,
              background: editing ? tk.accent : tk.surface,
              color: editing ? tk.onAccent : tk.textMuted,
              border: `1px solid ${editing ? tk.accent : tk.border}`,
              cursor: 'pointer', transition: 'all .15s',
            }}
          >
            {editing ? t('dashboard.doneEditing') : t('dashboard.editLayout')}
          </button>
          <span style={{ width: 1, height: 20, background: tk.border }} />
          {RANGES.map((seg) => (
            <button key={seg} onClick={() => setRange(seg)}
              style={{
                padding: '7px 14px', borderRadius: 9, fontSize: 12.5, fontWeight: 650,
                background: range === seg ? tk.accent : tk.surface,
                // Not always '#fff': in dark mode the accent is a light lavender
                // (#a5b4fc) and white on it measures 1.99:1. The selected pill was
                // the least readable control on the page. tk.onAccent flips to the
                // page ink for that case and stays white on the light-mode indigo.
                color:      range === seg ? tk.onAccent : tk.textMuted,
                border:     `1px solid ${range === seg ? tk.accent : tk.border}`,
                cursor: 'pointer', transition: 'all .15s',
              }}>
              {rangeLabel(seg)}
            </button>
          ))}
        </div>
      </div>

      {!hasWidgets && (
        <div style={{ background: tk.surface, border: `2px dashed ${tk.border}`, borderRadius: 14, padding: '56px 0', textAlign: 'center' }}>
          <p style={{ color: tk.textMuted, fontWeight: 600, margin: 0 }}>{t('dashboard.noWidgets')}</p>
          <p style={{ color: tk.textFaint, fontSize: 13, marginTop: 4 }}>{t('dashboard.noWidgetsHint')}</p>
        </div>
      )}

      {/* ── My Open Tickets (technician / viewer only) ── */}
      {myOpenTickets.length > 0 && (
        <div className="mb-4"
          style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 18 }}>
          <CardHead title={t('dashboard.myOpenTickets')} action={`${myOpenCount} ${t('common.open')}`} tk={tk} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {myOpenTickets.slice(0, 6).map((ticket) => {
              const isDue = isPastDueLocal(ticket.due_date)
              // Whole days remaining, counted to the END of the due day so
              // "due today" reads as 0 rather than -1 (BUG-038).
              const dueInDays = daysUntilDueLocal(ticket.due_date)
              return (
                <div key={ticket.id}
                  onClick={() => onNavigate?.(`/rma-tickets?ticket=${ticket.id}`)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                    borderRadius: 10, background: tk.surfaceInset, cursor: 'pointer',
                    border: `1px solid ${tk.borderSoft}`,
                  }}>
                  <StatusPill status={ticket.ticket_status} dark={darkMode} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: tk.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ticket.rma_number} · {ticket.customer_name}
                  </span>
                  {dueInDays !== null && (
                    <span style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap', color: isDue ? tk.bad : dueInDays <= 2 ? tk.warn : tk.textMuted }}>
                      {isDue ? t('dashboard.overdue') : `${t('dashboard.dueSoon')} ${dueInDays}d`}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Widget grid ───────────────────────────────────────────────────────
          One flat grid, in the order the user arranged. No CRM section, no RMA
          section — the split used to open the page on four CRM widgets and hide
          the other twelve inside a collapsed disclosure, so most of the
          dashboard was invisible until you found the toggle.

          Every card comes from the same loop: width from the user's saved size,
          link target from the catalog, edit controls when edit mode is on. */}
      <div className="grid grid-cols-12 gap-4">
        {layout.length === 0 ? (
          <div className="col-span-12" style={{ background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: 14, padding: 48, textAlign: 'center' }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: tk.text }}>{t('dashboard.noWidgets')}</p>
            <p style={{ margin: '6px 0 0', fontSize: 12.5, color: tk.textMuted }}>{t('dashboard.noWidgetsHint')}</p>
          </div>
        ) : (
          layout.map((w, index) => {
            const body = renderers[w.id]
            if (!body) return null
            return (
              <WidgetShell
                key={w.id}
                w={w}
                tk={tk}
                t={t}
                index={index}
                total={layout.length}
                editing={editing}
                isDragging={dragId === w.id}
                bare={w.id === 'stat_tickets'}
                onOpen={() => onNavigate?.(w.href)}
                onMove={moveWidget}
                onCycleSize={cycleSize}
                onRemove={removeWidget}
                onDragStart={() => setDragId(w.id)}
                onDragEnd={() => setDragId(null)}
                onDropOn={() => dropOn(w.id)}
              >
                {body()}
              </WidgetShell>
            )
          })
        )}
      </div>
    </div>
  )
}
