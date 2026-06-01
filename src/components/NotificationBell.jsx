import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'

const TYPE_META = {
  // Tickets
  ticket_created: { icon: '🎫', color: 'bg-blue-100 text-blue-700' },
  ticket_updated: { icon: '✏️', color: 'bg-yellow-100 text-yellow-700' },
  ticket_deleted: { icon: '🗑️', color: 'bg-red-100 text-red-700' },
  ticket_assigned: { icon: '👤', color: 'bg-indigo-100 text-indigo-700' },
  ticket_status_changed: { icon: '🔄', color: 'bg-purple-100 text-purple-700' },
  ticket_overdue: { icon: '⏰', color: 'bg-red-100 text-red-800' },
  due_date_warning: { icon: '⚠️', color: 'bg-yellow-100 text-yellow-800' },
  comment_added: { icon: '💬', color: 'bg-sky-100 text-sky-700' },
  // Customers
  customer_created: { icon: '🏢', color: 'bg-green-100 text-green-700' },
  customer_updated: { icon: '✏️', color: 'bg-yellow-100 text-yellow-700' },
  customer_deleted: { icon: '🗑️', color: 'bg-red-100 text-red-700' },
  // Products
  product_created: { icon: '📦', color: 'bg-teal-100 text-teal-700' },
  product_updated: { icon: '✏️', color: 'bg-yellow-100 text-yellow-700' },
  product_deleted: { icon: '🗑️', color: 'bg-red-100 text-red-700' },
  inventory_low: { icon: '📉', color: 'bg-orange-100 text-orange-700' },
  // Users
  user_created: { icon: '👤', color: 'bg-blue-100 text-blue-700' },
  user_role_changed: { icon: '🔑', color: 'bg-indigo-100 text-indigo-700' },
  user_suspended: { icon: '🔒', color: 'bg-orange-100 text-orange-700' },
  user_locked: { icon: '🔒', color: 'bg-red-100 text-red-700' },
  user_activated: { icon: '✅', color: 'bg-green-100 text-green-700' },
  user_deleted: { icon: '🗑️', color: 'bg-red-100 text-red-700' },
  // System
  system_announcement: { icon: '📢', color: 'bg-indigo-100 text-indigo-700' },
  custom_alert: { icon: '🔔', color: 'bg-amber-100 text-amber-700' },
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function NotificationBell({
  notifications = [],
  currentUserEmail,
  sidebarCompact,
  onNavigateToTicket,
  onMarkAllRead,
  mobile = false,
  iconOnly = false,
}) {
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState({})
  const btnRef = useRef(null)
  const panelRef = useRef(null)

  const normalizedEmail = useMemo(() => currentUserEmail?.toLowerCase() || '', [currentUserEmail])
  const readSets = useMemo(
    () =>
      new Map(
        notifications.map((n) => [n.id, new Set((n.read_by || []).map((e) => e.toLowerCase()))])
      ),
    [notifications]
  )
  const isRead = (n) => readSets.get(n.id)?.has(normalizedEmail) || false
  const unread = notifications.filter((n) => !isRead(n)).length

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      )
        setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Recalculate panel position on scroll/resize
  useEffect(() => {
    if (!open) return
    const reposition = () => {
      if (!btnRef.current) return
      const r = btnRef.current.getBoundingClientRect()
      if (mobile) {
        setPanelStyle({
          position: 'fixed',
          top: r.bottom + 6,
          right: 8,
          width: 340,
          maxHeight: 480,
          zIndex: 9999,
        })
      } else {
        // Anchor to the right edge of the sidebar button, vertically centered on button
        const panelH = Math.min(520, window.innerHeight - 32)
        let top = r.top
        if (top + panelH > window.innerHeight - 16) top = window.innerHeight - panelH - 16
        if (top < 16) top = 16
        setPanelStyle({
          position: 'fixed',
          top,
          left: r.right + 8,
          width: 360,
          maxHeight: panelH,
          zIndex: 9999,
        })
      }
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, mobile])

  const handleToggle = async () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      if (mobile) {
        setPanelStyle({
          position: 'fixed',
          top: r.bottom + 6,
          right: 8,
          width: 340,
          maxHeight: 480,
          zIndex: 9999,
        })
      } else {
        const panelH = Math.min(520, window.innerHeight - 32)
        let top = r.top
        if (top + panelH > window.innerHeight - 16) top = window.innerHeight - panelH - 16
        if (top < 16) top = 16
        setPanelStyle({
          position: 'fixed',
          top,
          left: r.right + 8,
          width: 360,
          maxHeight: panelH,
          zIndex: 9999,
        })
      }
    }
    const next = !open
    setOpen(next)
    if (next && unread > 0) onMarkAllRead?.()
  }

  const handleClickNotif = (n) => {
    setOpen(false)
    if (n.entity_type === 'ticket' && n.entity_id && onNavigateToTicket) {
      onNavigateToTicket(n.entity_id)
    }
  }

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          style={panelStyle}
          className="bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Notifications</h3>
              {notifications.length > 0 && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {notifications.length} total · {unread} unread
                </p>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-3">
                  <svg
                    className="w-6 h-6 text-gray-500"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                    />
                  </svg>
                </div>
                <p className="text-sm font-medium text-gray-500">No notifications yet</p>
                <p className="text-xs text-gray-500 mt-1">You'll see activity here as it happens</p>
              </div>
            ) : (
              notifications.map((n) => {
                const isUnread = !isRead(n)
                const meta = TYPE_META[n.type] || { icon: '🔔', color: 'bg-gray-100 text-gray-700' }
                const clickable = n.entity_type === 'ticket' && n.entity_id
                return (
                  <div
                    key={n.id}
                    onClick={() => handleClickNotif(n)}
                    className={`flex gap-3 px-4 py-3 border-b border-gray-50 last:border-0 transition-colors ${clickable ? 'cursor-pointer hover:bg-indigo-50' : ''} ${isUnread ? 'bg-blue-50/40' : ''}`}
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm ${meta.color}`}
                    >
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className={`text-sm leading-snug ${isUnread ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}
                        >
                          {n.title}
                        </p>
                        {isUnread && (
                          <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-gray-500">{timeAgo(n.created_date)}</span>
                        {n.entity_ref && (
                          <>
                            <span className="text-gray-300">·</span>
                            <span className="text-xs font-mono text-indigo-600">
                              {n.entity_ref}
                            </span>
                          </>
                        )}
                        {clickable && (
                          <>
                            <span className="text-gray-300">·</span>
                            <span className="text-xs text-indigo-500">View →</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>,
        document.body
      )
    : null

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleToggle}
        title="Notifications"
        aria-label="Notifications"
        className={iconOnly ? 'relative p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors flex items-center justify-center' : `w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-4 py-3'} rounded-lg transition-colors relative ${mobile ? 'text-gray-600 hover:bg-gray-100' : 'text-gray-300 hover:bg-gray-700'}`}
      >
        <div className="relative flex-shrink-0">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-60" />
              <span className="relative min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
                {unread > 99 ? '99+' : unread}
              </span>
            </span>
          )}
        </div>
        {!sidebarCompact && <span className="flex-1 text-left">Notifications</span>}
        {!sidebarCompact && unread > 0 && (
          <span className="px-1.5 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full leading-none">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {panel}
    </>
  )
}
