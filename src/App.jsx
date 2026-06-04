import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom'
import { Toaster, toast } from 'react-hot-toast'
import { useQueryClient } from '@tanstack/react-query'
import { auth, db, branding as brandingAPI, supabase } from './api/supabaseClient'
import { useAppearance } from './contexts/AppearanceContext'
import { resolvePermissions } from './lib/permissions'
import { ROLES } from './lib/constants'
import { safeStorage } from './lib/safeStorage'
import { registerTicketEventHandlers } from './lib/events/ticketEventHandlers'

// Register notification event handlers once at module load
registerTicketEventHandlers()
import NotificationBell from './components/NotificationBell'
import { Spinner } from './components/ui'
import { captureException } from './lib/sentry'

function AnnouncementBanner() {
  const [items, setItems] = useState([])
  const [dismissed, setDismissed] = useState([])
  useEffect(() => {
    db.announcements
      .listActive()
      .then(setItems)
      .catch(() => {})
  }, [])
  const visible = items.filter((a) => !dismissed.includes(a.id))
  if (!visible.length) return null
  const STYLES = {
    info: 'bg-blue-600',
    warning: 'bg-yellow-500',
    success: 'bg-green-600',
    error: 'bg-red-600',
  }
  const ICONS = { info: 'ℹ️', warning: '⚠️', success: '✅', error: '🚨' }
  return (
    <div className="fixed top-0 left-0 right-0 z-50 space-y-0.5">
      {visible.map((a) => (
        <div
          key={a.id}
          className={`flex items-center justify-between px-4 py-2 text-white text-sm ${STYLES[a.type] || STYLES.info}`}
        >
          <span>
            {ICONS[a.type]} <strong>{a.title}:</strong> {a.message}
          </span>
          <button
            onClick={() => setDismissed((d) => [...d, a.id])}
            className="ml-4 opacity-75 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import RMATracker from './pages/RMATracker'

// When Vite redeploys, content-hashed chunk filenames change. A user who still
// has the old index.html cached will try to fetch old chunk URLs that no longer
// exist → "Failed to fetch dynamically imported module". Auto-reload on that
// specific error so the browser picks up the new index.html and correct chunks.
function lazyWithReload(importFn) {
  return React.lazy(() =>
    importFn().catch((err) => {
      // Only reload for chunk-fetch failures, not genuine module errors
      if (err?.message?.includes('Failed to fetch dynamically imported module') ||
          err?.message?.includes('Importing a module script failed')) {
        window.location.reload()
        return new Promise(() => {}) // suspend forever — reload takes over
      }
      throw err
    })
  )
}

const AccountSettings = lazyWithReload(() => import('./pages/AccountSettings'))
const Dashboard = lazyWithReload(() => import('./pages/Dashboard'))
const Products = lazyWithReload(() => import('./pages/Products'))
const ProductDetails = lazyWithReload(() => import('./pages/ProductDetails'))
const Customers = lazyWithReload(() => import('./pages/Customers'))
const CustomerDetails = lazyWithReload(() => import('./pages/CustomerDetails'))
const RMATickets = lazyWithReload(() => import('./pages/RMATickets'))
const Inventory = lazyWithReload(() => import('./pages/Inventory'))
const ControlPanel = lazyWithReload(() => import('./pages/ControlPanel'))
const TechCalendar = lazyWithReload(() => import('./pages/TechCalendar'))
const Invoices = lazyWithReload(() => import('./pages/Invoices'))
const PartsInventory = lazyWithReload(() => import('./pages/PartsInventory'))
const Reports = lazyWithReload(() => import('./pages/Reports'))
const NotFoundPage = lazyWithReload(() => import('./pages/NotFoundPage'))
const CommandPalette = lazyWithReload(() => import('./components/CommandPalette'))

const PageSpinner = () => (
  <div className="flex items-center justify-center h-64">
    <Spinner size="xl" />
  </div>
)

// ── Thin route wrappers — extract useParams() so page components stay unchanged ──
function ProductDetailsRoute({
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onNavigateToTicket,
}) {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <ProductDetails
      productId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      currentUserPermissions={currentUserPermissions}
      onBack={() => navigate('/products')}
      onNavigateToTicket={onNavigateToTicket}
    />
  )
}

function CustomerDetailsRoute({
  currentUserRole,
  currentUserEmail,
  currentUserPermissions,
  onNavigateToTicket,
}) {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <CustomerDetails
      customerId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      currentUserPermissions={currentUserPermissions}
      onBack={() => navigate('/customers')}
      onNavigateToTicket={onNavigateToTicket}
    />
  )
}

// ── MFA challenge screen (shown after password login when 2FA is enrolled) ───
function MfaChallenge({ onVerify, onCancel }) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { darkMode } = useAppearance()

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (code.length !== 6) return
    setLoading(true)
    setError('')
    try {
      await onVerify(code)
    } catch (err) {
      setError(err?.message || 'Invalid code — please try again')
      setCode('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`min-h-screen flex items-center justify-center ${darkMode ? 'bg-[#0b0f17]' : 'bg-[#f4f6f9]'}`}>
      <div className={`w-full max-w-sm rounded-2xl border p-8 shadow-sm ${darkMode ? 'bg-[#121823] border-[#212a38]' : 'bg-white border-[#e6e9ef]'}`}>
        <div className="flex justify-center mb-5">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${darkMode ? 'bg-indigo-900/40' : 'bg-indigo-50'}`}>
            <svg className="w-6 h-6 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
        </div>
        <h1 className={`text-lg font-semibold text-center mb-1 ${darkMode ? 'text-[#e8ebf0]' : 'text-gray-900'}`}>
          Two-Factor Authentication
        </h1>
        <p className={`text-sm text-center mb-6 ${darkMode ? 'text-[#9aa4b2]' : 'text-gray-500'}`}>
          Enter the 6-digit code from your authenticator app
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="\d{6}"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            autoFocus
            className={`w-full text-center text-2xl font-mono tracking-[0.5em] rounded-lg border px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500 ${darkMode ? 'bg-[#0f1520] border-[#212a38] text-[#e8ebf0] placeholder-[#4a5568]' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'}`}
          />
          {error && <p className="text-xs text-red-500 text-center">{error}</p>}
          <button
            type="submit"
            disabled={code.length !== 6 || loading}
            className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {loading ? 'Verifying…' : 'Verify'}
          </button>
        </form>
        <button
          onClick={onCancel}
          className={`mt-4 w-full text-xs text-center ${darkMode ? 'text-[#9aa4b2] hover:text-[#e8ebf0]' : 'text-gray-400 hover:text-gray-600'}`}
        >
          Cancel — sign out
        </button>
      </div>
    </div>
  )
}

// ── Main app ──────────────────────────────────────────────────────────────────
export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const pathname = location.pathname
  const queryClient = useQueryClient()

  const { sidebarCompact, updateAppearance, darkMode } = useAppearance()
  const toastOptions = darkMode
    ? { style: { background: '#121823', color: '#e8ebf0', border: '1px solid #212a38', borderRadius: 12 } }
    : { style: { borderRadius: 12 } }

  const [currentUser, setCurrentUser] = useState(null)
  const [currentUserRole, setCurrentUserRole] = useState(null)
  const [currentUserPermissions, setCurrentUserPermissions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [mfaPending, setMfaPending] = useState(null) // { user, factorId } — waiting for TOTP code
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // selectedTicketId: open a specific ticket when navigating to /rma-tickets
  // (e.g. from the notification bell or command palette)
  const [selectedTicketId, setSelectedTicketId] = useState(null)
  const [resetPasswordMode, setResetPasswordMode] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [notifMissing, setNotifMissing] = useState(false)
  const notifChannelRef = useRef(null)
  const userMenuRef = useRef(null)
  const hamburgerRef = useRef(null)

  useEffect(() => {
    brandingAPI
      .getBranding()
      .then((b) => {
        if (b?.company_name) setCompanyName(b.company_name)
      })
      .catch(() => {})
    // H-9: flush any audit events that failed to write in a previous session
    db.auditLog.flushQueue().catch((err) => captureException(err, { context: 'auditLog.flushQueue' }))
  }, [])

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen((open) => !open)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    checkAuth()
    const {
      data: { subscription },
    } = auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setResetPasswordMode(true)
        setLoading(false)
      }
      if (event === 'SIGNED_OUT') {
        setCurrentUser(null)
        setCurrentUserRole(null)
        setCurrentUserPermissions(null)
        setMfaPending(null)
        navigate('/')
      }
    })
    return () => subscription?.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const finishLogin = async (user) => {
    setCurrentUser(user)
    const roleData = await db.userRoles.getUserRole(user.email)
    queryClient.setQueryData(['user-role', user.email], roleData)
    const role = roleData?.role || 'technician'
    setCurrentUserRole(role)
    setCurrentUserPermissions(resolvePermissions(role, roleData?.permissions))
  }

  const checkAuth = async () => {
    try {
      const user = await auth.getCurrentUser()
      if (user) {
        const { data: aalData } = await auth.mfa.getLevel()
        if (aalData?.nextLevel === 'aal2' && aalData?.currentLevel !== 'aal2') {
          const { data: factors } = await auth.mfa.listFactors()
          const totp = factors?.all?.find((f) => f.factor_type === 'totp' && f.status === 'verified')
          if (totp) { setMfaPending({ user, factorId: totp.id }); return }
        }
        await finishLogin(user)
      }
    } catch (error) {
      captureException(error, { page: 'App', context: 'checkAuth' })
    } finally {
      setLoading(false)
    }
  }

  // Load notifications once and maintain a single real-time subscription
  const loadNotifsRef = useRef(null)

  useEffect(() => {
    if (!currentUser?.email || !currentUserRole || notifMissing) return

    const applyPrefs = (data) => {
      const prefs = safeStorage.get(`notif_system_prefs_${currentUser.email}`, {})
      return data.filter((n) => prefs[n.type] !== false)
    }

    const loadNotifs = async () => {
      const result = await db.notifications.listForUser(currentUser.email, currentUserRole)
      if (result.missing) {
        setNotifMissing(true)
        return
      }
      setNotifMissing(false)
      setNotifications(applyPrefs(result.data))
    }

    // A-3: seed localStorage from DB on first load (DB is source of truth; localStorage = cache)
    db.userPreferences
      .get(currentUser.email)
      .then((result) => {
        if (!result.missing && result.prefs?.notifSystem) {
          safeStorage.set(`notif_system_prefs_${currentUser.email}`, result.prefs.notifSystem)
        }
      })
      .catch(() => {})

    loadNotifsRef.current = loadNotifs
    loadNotifs()

    const channel = supabase
      .channel('app_notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => {
          loadNotifs()
          // UX-5: toast for incoming notifications — RLS on postgres_changes already ensures
          // only rows this user can SELECT reach the client; no client-side targeting check needed.
          const n = payload.new
          if (!n) return
          const myEmail = currentUser?.email
          const prefs = safeStorage.get(`notif_system_prefs_${myEmail}`, {})
          if (prefs[n.type] === false) return
          const icons = {
            info: 'ℹ️',
            warning: '⚠️',
            success: '✅',
            error: '🚨',
            announcement: '📢',
          }
          toast(`${icons[n.type] || '🔔'} ${n.title}`, {
            duration: 5000,
            style: { maxWidth: 380 },
          })
        }
      )
      .subscribe()
    notifChannelRef.current = channel

    return () => {
      if (notifChannelRef.current) {
        supabase.removeChannel(notifChannelRef.current)
        notifChannelRef.current = null
      }
    }
  }, [currentUser?.email, currentUserRole, notifMissing])

  // Re-filter when user changes notification preferences (same-tab and cross-tab)
  useEffect(() => {
    const handler = () => loadNotifsRef.current?.()
    window.addEventListener('notif-system-prefs-changed', handler)

    let bc = null
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('notif_system_prefs')
      bc.onmessage = (e) => {
        if (e.data?.type === 'notif-system-prefs-changed') {
          if (e.data.prefs && currentUser?.email) {
            safeStorage.set(`notif_system_prefs_${currentUser.email}`, e.data.prefs)
          }
          loadNotifsRef.current?.()
        }
      }
    }

    return () => {
      window.removeEventListener('notif-system-prefs-changed', handler)
      try {
        bc?.close()
      } catch {}
    }
  }, [currentUser?.email])

  useEffect(() => {
    if (!userMenuOpen) return
    const handler = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [userMenuOpen])

  // UX-4: close mobile sidebar on Escape, return focus to hamburger button
  useEffect(() => {
    if (!sidebarOpen) return
    const handler = (e) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false)
        hamburgerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [sidebarOpen])

  // Clear selectedTicketId when navigating away from /rma-tickets
  useEffect(() => {
    if (pathname !== '/rma-tickets') setSelectedTicketId(null)
  }, [pathname])

  const markAllNotifsRead = useCallback(async () => {
    if (!currentUser?.email || !currentUserRole) return
    await db.notifications.markAllRead(currentUser.email, currentUserRole)
    setNotifications((prev) =>
      prev.map((n) => ({
        ...n,
        read_by: n.read_by?.includes(currentUser.email)
          ? n.read_by
          : [...(n.read_by || []), currentUser.email],
      }))
    )
  }, [currentUser?.email, currentUserRole])

  const handleLogin = async (email, password) => {
    const data = await auth.signIn(email, password)
    const user = data?.user || data
    const { data: aalData } = await auth.mfa.getLevel()
    if (aalData?.nextLevel === 'aal2' && aalData?.currentLevel !== 'aal2') {
      const { data: factors } = await auth.mfa.listFactors()
      const totp = factors?.all?.find((f) => f.factor_type === 'totp' && f.status === 'verified')
      if (totp) { setMfaPending({ user, factorId: totp.id }); return }
    }
    await finishLogin(user)
    db.userActivity.create(user.email, 'login', `Signed in as ${currentUserRole || 'user'}`).catch(() => {})
  }

  const handleMfaVerify = async (code) => {
    const { error } = await auth.mfa.challengeAndVerify(mfaPending.factorId, code)
    if (error) throw error
    const user = mfaPending.user
    setMfaPending(null)
    await finishLogin(user)
    db.userActivity.create(user.email, 'login', 'Signed in with 2FA').catch(() => {})
  }

  const handleSignup = async (email, password) => {
    const data = await auth.signUp(email, password)
    const user = data?.user || data
    setCurrentUser(user)
    setCurrentUserRole('technician')
  }

  const handleLogout = async () => {
    const email = currentUser?.email
    await auth.signOut()
    if (email) db.userActivity.create(email, 'logout', 'Signed out').catch(() => {})
    setCurrentUser(null)
    setCurrentUserRole(null)
    setCurrentUserPermissions(null)
    navigate('/')
  }

  // A-1: React Router navigation — replaces window.history.pushState + currentPage state
  const handleNavigate = useCallback(
    (path) => {
      navigate(path)
      setSelectedTicketId(null)
      setSidebarOpen(false)
    },
    [navigate]
  )

  const handleNavigateToTicket = useCallback(
    (ticketId) => {
      setSelectedTicketId(ticketId)
      navigate('/rma-tickets')
      setSidebarOpen(false)
    },
    [navigate]
  )

  const handleCmdSelectTicket = useCallback(
    (ticket) => {
      setSelectedTicketId(ticket.id)
      navigate('/rma-tickets')
      setSidebarOpen(false)
    },
    [navigate]
  )

  const handleCmdSelectProduct = useCallback(
    (product) => {
      navigate(`/products/${product.id}`)
      setSidebarOpen(false)
    },
    [navigate]
  )

  const handleProfileUpdate = (updatedUser) => {
    setCurrentUser(updatedUser)
  }

  // ── Active state derived from URL ─────────────────────────────────────────
  const isProductsActive = pathname === '/products' || pathname.startsWith('/products/')
  const isCustomersActive = pathname === '/customers' || pathname.startsWith('/customers/')

  // ── Derive page title for mobile header ───────────────────────────────────
  const mobileTitle = (() => {
    if (pathname.startsWith('/products/')) return 'Product Details'
    if (pathname.startsWith('/customers/')) return 'Customer Details'
    const MAP = {
      '/': 'Dashboard',
      '/dashboard': 'Dashboard',
      '/products': 'Products',
      '/customers': 'Customers',
      '/rma-tickets': 'RMA Tickets',
      '/inventory': 'Inventory',
      '/account': 'Account Settings',
      '/control-panel': 'Control Panel',
      '/calendar': 'Calendar',
      '/invoices': 'Invoices',
      '/parts': 'Parts Inventory',
      '/reports': 'Reports',
    }
    return MAP[pathname] ?? pathname.slice(1).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  })()

  // ── Special routes — no auth needed ──────────────────────────────────────
  if (pathname === '/tracker') {
    return (
      <>
        <RMATracker />
        <Toaster position="top-right" toastOptions={toastOptions} />
      </>
    )
  }

  if (resetPasswordMode) {
    return (
      <>
        <ResetPassword
          onDone={() => {
            setResetPasswordMode(false)
            setCurrentUser(null)
          }}
        />
        <Toaster position="top-right" toastOptions={toastOptions} />
      </>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f4f6f9] dark:bg-[#0b0f17]">
        <Spinner size="xl" />
      </div>
    )
  }

  if (mfaPending) {
    return (
      <>
        <MfaChallenge onVerify={handleMfaVerify} onCancel={() => { auth.signOut(); setMfaPending(null) }} />
        <Toaster position="top-right" toastOptions={toastOptions} />
      </>
    )
  }

  if (!currentUser) {
    return (
      <>
        <Login onLogin={handleLogin} onSignup={handleSignup} />
        <Toaster position="top-right" toastOptions={toastOptions} />
      </>
    )
  }

  // ── Authenticated app shell ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f4f6f9] dark:bg-[#0b0f17] flex">
      <AnnouncementBanner />
      <Toaster position="top-right" />
      {/* CommandPalette is React.lazy — needs its own Suspense boundary.
          null fallback: it's a hidden modal until Ctrl+K, no placeholder needed. */}
      <Suspense fallback={null}>
        <CommandPalette
          open={cmdPaletteOpen}
          onClose={() => setCmdPaletteOpen(false)}
          onSelectTicket={handleCmdSelectTicket}
          onSelectProduct={handleCmdSelectProduct}
        />
      </Suspense>

      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed lg:static inset-y-0 left-0 z-30 ${sidebarCompact ? 'w-16' : 'w-64'} bg-white dark:bg-[#121823] border-r border-[#e6e9ef] dark:border-[#212a38] flex flex-col transform transition-all duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div
          className={`border-b border-[#e6e9ef] dark:border-[#212a38] flex items-center ${sidebarCompact ? 'flex-col gap-2 p-3' : 'px-4 py-3 justify-between'}`}
        >
          {sidebarCompact ? (
            <>
              <button
                onClick={() => handleNavigate('/')}
                title="Go to Dashboard"
                aria-label="Go to Dashboard"
                className="w-10 h-10 bg-[#4338ca] rounded-lg flex items-center justify-center flex-shrink-0 hover:bg-[#3730a3] transition-colors"
              >
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </button>
              <button
                onClick={() => updateAppearance({ sidebarCompact: false }, currentUser?.email)}
                title="Expand sidebar"
                aria-label="Expand sidebar"
                className="w-10 h-10 flex items-center justify-center rounded-lg text-[#a39e95] dark:text-[#646f7e] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => handleNavigate('/')}
                title="Go to Dashboard"
                aria-label="Go to Dashboard"
                className="flex items-center gap-3 hover:opacity-80 transition-opacity"
              >
                <div className="w-10 h-10 bg-[#4338ca] rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div className="text-left">
                  <h1 className="text-[15px] font-[750] tracking-tight text-[#211f1b] dark:text-[#e8ebf0] leading-none">myRMA</h1>
                  <p className="text-[12px] text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{companyName || 'RMA Management'}</p>
                </div>
              </button>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => updateAppearance({ sidebarCompact: true }, currentUser?.email)}
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#a39e95] dark:text-[#646f7e] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors lg:flex hidden"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close navigation"
                  className="lg:hidden w-8 h-8 flex items-center justify-center text-[#a39e95] dark:text-[#646f7e] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>

        <nav className={`flex-1 ${sidebarCompact ? 'p-2' : 'p-4'} space-y-0.5 overflow-y-auto`}>
          {[
            { path: '/', label: 'Dashboard', active: pathname === '/' || pathname === '/dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
            { path: '/products', label: 'Products', active: isProductsActive, icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
            { path: '/customers', label: 'Customers', active: isCustomersActive, icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
            { path: '/rma-tickets', label: 'RMA Tickets', active: pathname === '/rma-tickets', icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z' },
            { path: '/inventory', label: 'Inventory', active: pathname === '/inventory', icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
            { path: '/calendar', label: 'Calendar', active: pathname === '/calendar', icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
            { path: '/invoices', label: 'Invoices', active: pathname === '/invoices', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
            { path: '/parts', label: 'Parts Inventory', active: pathname === '/parts', icon: 'M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z' },
            { path: '/reports', label: 'Reports', active: pathname === '/reports', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
          ].map(({ path, label, active, icon }) => (
            <button
              key={path}
              onClick={() => handleNavigate(path)}
              title={sidebarCompact ? label : undefined}
              className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2.5'} rounded-[10px] text-[13.5px] font-[600] transition-colors ${active ? 'bg-[rgba(67,56,202,0.11)] dark:bg-[rgba(165,180,252,0.16)] text-[#4338ca] dark:text-[#a5b4fc]' : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.7} d={icon} />
              </svg>
              {!sidebarCompact && label}
            </button>
          ))}

          <div className="pt-2 border-t border-[#e6e9ef] dark:border-[#212a38] my-1" />
          <a
            href="/tracker"
            target="_blank"
            rel="noopener noreferrer"
            title={sidebarCompact ? 'Customer Tracker' : undefined}
            className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2.5'} rounded-[10px] text-[13.5px] font-[600] transition-colors text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            {!sidebarCompact && (
              <span className="flex items-center gap-1.5">
                Customer Tracker
                <svg className="w-3 h-3 text-[#a39e95] dark:text-[#646f7e]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </span>
            )}
          </a>

          {(currentUserRole === ROLES.ADMIN || currentUserRole === ROLES.SUPER_ADMIN) && (
            <>
              <div className="pt-2 border-t border-[#e6e9ef] dark:border-[#212a38] my-1" />
              <button
                onClick={() => handleNavigate('/control-panel')}
                title={sidebarCompact ? 'Control Panel' : undefined}
                className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2.5'} rounded-[10px] text-[13.5px] font-[600] transition-colors ${pathname === '/control-panel' ? 'bg-[rgba(67,56,202,0.11)] dark:bg-[rgba(165,180,252,0.16)] text-[#4338ca] dark:text-[#a5b4fc]' : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
              >
                <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={pathname === '/control-panel' ? 2.2 : 1.7} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={pathname === '/control-panel' ? 2.2 : 1.7} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {!sidebarCompact && 'Control Panel'}
              </button>
            </>
          )}
        </nav>

      </div>

      {/* UX-4: inert disables all keyboard/pointer interaction behind the open sidebar on mobile */}
      <div className="flex-1 flex flex-col min-h-0" {...(sidebarOpen ? { inert: '' } : {})}>
        {/* Mobile header */}
        <div className="lg:hidden bg-white dark:bg-[#121823] border-b border-[#e6e9ef] dark:border-[#212a38] px-4 py-3 flex items-center justify-between">
          <button
            ref={hamburgerRef}
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
            className="text-gray-600 hover:text-gray-900"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          <h2 className="text-[15px] font-[700] text-[#211f1b] dark:text-[#e8ebf0] capitalize">{mobileTitle}</h2>
          <div className="flex items-center gap-1.5">
            <NotificationBell
              notifications={notifications}
              currentUserEmail={currentUser?.email}
              sidebarCompact={true}
              onNavigateToTicket={handleNavigateToTicket}
              onMarkAllRead={markAllNotifsRead}
              mobile={true}
            />
            {/* Dark mode toggle */}
            <button
              onClick={() => updateAppearance({ darkMode: !darkMode }, currentUser?.email)}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-600 dark:text-[#9aa4b2]"
            >
              {darkMode ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            <button
              onClick={() => handleNavigate('/account')}
              title="Account Settings"
              aria-label="Account Settings"
              className={`w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-semibold text-sm uppercase flex-shrink-0 ${pathname === '/account' ? 'ring-2 ring-indigo-400' : ''}`}
            >
              {(currentUser?.user_metadata?.display_name || currentUser?.email || '?')[0]}
            </button>
          </div>
        </div>

        {/* Desktop top bar — notifications + user menu */}
        <div className="hidden lg:flex items-center justify-between gap-1 px-6 py-2 bg-white dark:bg-[#121823] border-b border-[#e6e9ef] dark:border-[#212a38] flex-shrink-0">
          {/* Search trigger */}
          <button
            onClick={() => setCmdPaletteOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#f4f6f9] dark:bg-[#0f1520] border border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] hover:border-[#4338ca] dark:hover:border-[#a5b4fc] transition-colors text-sm w-64"
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="flex-1 text-left text-xs">Search tickets, products…</span>
            <kbd className="text-[10px] px-1.5 py-0.5 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded font-mono">⌘K</kbd>
          </button>
          <div className="flex items-center gap-1">
          <NotificationBell
            notifications={notifications}
            currentUserEmail={currentUser?.email}
            onNavigateToTicket={handleNavigateToTicket}
            onMarkAllRead={markAllNotifsRead}
            mobile={true}
            iconOnly={true}
          />
          {/* Dark mode toggle */}
          <button
            onClick={() => updateAppearance({ darkMode: !darkMode }, currentUser?.email)}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-100 dark:hover:bg-[#1a2230] transition-colors"
          >
            {darkMode ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          {/* User dropdown */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen((o) => !o)}
              className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
            >
              {currentUser?.user_metadata?.avatar_url ? (
                <img
                  src={currentUser.user_metadata.avatar_url}
                  alt="avatar"
                  className="w-8 h-8 rounded-full object-cover ring-2 ring-indigo-500/30 flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-semibold text-sm uppercase flex-shrink-0">
                  {(currentUser?.user_metadata?.display_name || currentUser?.email || '?')[0]}
                </div>
              )}
              <div className="text-left hidden xl:block">
                <div className="text-[13px] font-[600] text-[#211f1b] dark:text-[#e8ebf0] leading-none truncate max-w-[160px]">
                  {currentUser?.user_metadata?.display_name || currentUser?.email}
                </div>
                <div className="text-[11px] text-[#6c6760] dark:text-[#9aa4b2] capitalize mt-0.5">{currentUserRole}</div>
              </div>
              <svg
                className="w-4 h-4 text-[#a39e95] dark:text-[#646f7e] flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 bg-white dark:bg-[#121823] rounded-[14px] shadow-lg border border-[#e6e9ef] dark:border-[#212a38] z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-[#eef0f4] dark:border-[#1a2230]">
                  <div className="text-[13px] font-[600] text-[#211f1b] dark:text-[#e8ebf0] truncate">
                    {currentUser?.user_metadata?.display_name || currentUser?.email}
                  </div>
                  <div className="text-[11px] text-[#6c6760] dark:text-[#9aa4b2] capitalize mt-0.5">{currentUserRole}</div>
                </div>
                <button
                  onClick={() => {
                    handleNavigate('/account')
                    setUserMenuOpen(false)
                  }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-[#211f1b] dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors text-left"
                >
                  <svg
                    className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
                  </svg>
                  Account Settings
                </button>
                <div className="border-t border-[#eef0f4] dark:border-[#1a2230]" />
                <button
                  onClick={() => {
                    handleLogout()
                    setUserMenuOpen(false)
                  }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left"
                >
                  <svg
                    className="w-4 h-4 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                    />
                  </svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* ── Page content — React Router <Routes> ────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 main-scroll">
          <Suspense fallback={<PageSpinner />}>
            <Routes>
              <Route
                path="/"
                element={
                  <Dashboard currentUserEmail={currentUser?.email} onNavigate={handleNavigate} />
                }
              />
              <Route path="/dashboard" element={<Navigate to="/" replace />} />

              <Route
                path="/products"
                element={
                  <Products
                    currentUserRole={currentUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={currentUserPermissions}
                    onNavigateToProduct={(id) => navigate(`/products/${id}`)}
                  />
                }
              />
              <Route
                path="/products/:id"
                element={
                  <ProductDetailsRoute
                    currentUserRole={currentUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={currentUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/customers"
                element={
                  <Customers
                    currentUserRole={currentUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={currentUserPermissions}
                    onNavigateToCustomer={(id) => navigate(`/customers/${id}`)}
                  />
                }
              />
              <Route
                path="/customers/:id"
                element={
                  <CustomerDetailsRoute
                    currentUserRole={currentUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={currentUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/rma-tickets"
                element={
                  <RMATickets
                    userRole={currentUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={currentUserPermissions}
                    initialTicketId={selectedTicketId}
                  />
                }
              />

              <Route
                path="/inventory"
                element={
                  <Inventory
                    userRole={currentUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={currentUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/account"
                element={
                  <AccountSettings
                    currentUser={currentUser}
                    currentUserRole={currentUserRole}
                    onProfileUpdate={handleProfileUpdate}
                  />
                }
              />

              <Route
                path="/control-panel"
                element={
                  currentUserRole === ROLES.ADMIN || currentUserRole === ROLES.SUPER_ADMIN ? (
                    <ControlPanel
                      currentUserRole={currentUserRole}
                      currentUserEmail={currentUser?.email}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/calendar"
                element={
                  <TechCalendar
                    userRole={currentUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={currentUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/invoices"
                element={
                  <Invoices
                    userRole={currentUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={currentUserPermissions}
                  />
                }
              />

              <Route
                path="/parts"
                element={
                  <PartsInventory
                    userRole={currentUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={currentUserPermissions}
                  />
                }
              />

              <Route
                path="/reports"
                element={
                  <Reports
                    userRole={currentUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={currentUserPermissions}
                  />
                }
              />

              {/* A-1: catch-all 404 — previously typo URLs silently landed on Dashboard */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </div>
      </div>
    </div>
  )
}
