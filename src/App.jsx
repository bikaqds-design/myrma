import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Toaster, toast } from 'react-hot-toast'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { auth, db, branding as brandingAPI, supabase } from './api/supabaseClient'
import { useAppearance } from './contexts/AppearanceContext'
import { resolvePermissions, canDo } from './lib/permissions'
import { ROLES } from './lib/constants'
import { safeStorage } from './lib/safeStorage'
import { registerTicketEventHandlers } from './lib/events/ticketEventHandlers'
import { registerCrmEventHandlers } from './lib/events/crmEventHandlers'

// Register notification event handlers once at module load
registerTicketEventHandlers()
registerCrmEventHandlers()
import NotificationBell from './components/NotificationBell'
import Breadcrumb from './components/Breadcrumb'
import { RouteSkeleton } from './components/Skeleton'
import OnboardingWizard from './components/OnboardingWizard'
import { Spinner } from './components/ui'
import { captureException } from './lib/sentry'

function PreviewBanner({ previewUser, onExit }) {
  const { t } = useTranslation()
  if (!previewUser) return null
  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-3 px-4 py-2 bg-amber-500 text-white text-sm">
      <span>
        {t('preview.banner', { email: previewUser.email, role: previewUser.role })}
        {' — '}
        <span className="opacity-90">{t('preview.dataDisclaimer')}</span>
      </span>
      <button
        onClick={onExit}
        className="flex-shrink-0 px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 font-medium transition-colors"
      >
        {t('preview.exit')}
      </button>
    </div>
  )
}

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
import KnowledgeBasePublic from './pages/KnowledgeBasePublic'

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
const Reports = lazyWithReload(() => import('./pages/Reports'))
const Leads = lazyWithReload(() => import('./pages/Leads'))
const LeadDetails = lazyWithReload(() => import('./pages/Leads/LeadDetails'))
const Pipeline = lazyWithReload(() => import('./pages/Pipeline'))
const DealDetails = lazyWithReload(() => import('./pages/Pipeline/DealDetail'))
const Activities = lazyWithReload(() => import('./pages/Activities'))
const SalesDocuments = lazyWithReload(() => import('./pages/SalesDocuments'))
const SalesDocumentDetail = lazyWithReload(() => import('./pages/SalesDocuments/SalesDocumentDetail'))
const Accounting = lazyWithReload(() => import('./pages/Accounting'))
const Purchasing = lazyWithReload(() => import('./pages/Purchasing'))
const PurchaseDocumentDetail = lazyWithReload(() => import('./pages/Purchasing/PurchaseDocumentDetail'))
const VendorDetails = lazyWithReload(() => import('./pages/Purchasing/VendorDetails'))
const NotFoundPage = lazyWithReload(() => import('./pages/NotFoundPage'))
import CommandPalette from './components/CommandPalette'
import { EMPTY_ARRAY } from './lib/stableEmpty'

const PageSpinner = () => <RouteSkeleton />

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

function LeadDetailsRoute({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <LeadDetails
      leadId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      currentUserPermissions={currentUserPermissions}
      onBack={() => navigate('/leads')}
    />
  )
}

function DealDetailsRoute({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <DealDetails
      dealId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      currentUserPermissions={currentUserPermissions}
      onBack={() => navigate('/pipeline')}
    />
  )
}

function SalesDocumentDetailRoute({ currentUserRole, currentUserEmail }) {
  const { type, id } = useParams()
  const navigate = useNavigate()
  return (
    <SalesDocumentDetail
      docType={type}
      docId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      onBack={() => navigate('/sales')}
    />
  )
}

// Declared as a static segment so it out-ranks /purchasing/:type/:id — React
// Router scores a literal above a dynamic param, so "vendor" never falls through
// to the document-detail route.
function VendorDetailsRoute({ currentUserRole, currentUserPermissions }) {
  const { id } = useParams()
  const navigate = useNavigate()
  return (
    <VendorDetails
      vendorId={id}
      canEdit={canDo(currentUserRole, currentUserPermissions, 'deals', 'edit')}
      onBack={() => navigate('/purchasing?tab=vendors')}
      onOpenDocument={(doc) => navigate(`/purchasing/${doc.doc_type}/${doc.id}`)}
      onEditVendor={() => navigate('/purchasing?tab=vendors')}
    />
  )
}

function PurchaseDocumentDetailRoute({ currentUserRole, currentUserEmail }) {
  const { type, id } = useParams()
  const navigate = useNavigate()
  return (
    <PurchaseDocumentDetail
      docType={type}
      docId={id}
      currentUserRole={currentUserRole}
      currentUserEmail={currentUserEmail}
      onBack={() => navigate('/purchasing')}
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
            className={`w-full text-center text-2xl font-mono tracking-[0.5em] rounded-lg border px-4 py-3 outline-none focus:ring-2 focus:ring-indigo-500 ${darkMode ? 'bg-[#0f1520] border-[#212a38] text-[#e8ebf0] placeholder-[#768292]' : 'bg-white border-gray-300 text-gray-900 placeholder-gray-400'}`}
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
  const { t } = useTranslation()
  const toastOptions = darkMode
    ? { style: { background: '#121823', color: '#e8ebf0', border: '1px solid #212a38', borderRadius: 12 } }
    : { style: { borderRadius: 12 } }

  const [currentUser, setCurrentUser] = useState(null)
  const [currentUserRole, setCurrentUserRole] = useState(null)
  const [currentUserPermissions, setCurrentUserPermissions] = useState(null)
  // FT-09: permission preview — lets an admin temporarily see the app as another
  // user's role+permissions would render it. Does NOT swap the real Supabase
  // session, so RLS-scoped data (e.g. that user's own notifications) is unaffected —
  // this is a UI/canDo() gating preview only, never real impersonation.
  const [previewUser, setPreviewUser] = useState(null) // { email, role, permissions } | null
  const effectiveUserRole = previewUser ? previewUser.role : currentUserRole
  const effectiveUserPermissions = previewUser ? previewUser.permissions : currentUserPermissions
  const [loading, setLoading] = useState(true)
  const [mfaPending, setMfaPending] = useState(null) // { user, factorId } — waiting for TOTP code
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // selectedTicketId: open a specific ticket when navigating to /rma-tickets
  // (e.g. from the notification bell or command palette)
  const [selectedTicketId, setSelectedTicketId] = useState(null)
  const [resetPasswordMode, setResetPasswordMode] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const cmdSearchRef = useRef(null)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
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
        cmdSearchRef.current?.focus()
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
    // Show onboarding wizard for admins who haven't completed it yet
    if (role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN) {
      const done = safeStorage.get(`mrma_onboarding_v1_${user.email}`, null)
      if (!done) setShowOnboarding(true)
    }
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

  const startPreview = (user) => {
    setPreviewUser({
      email: user.user_email,
      role: user.role,
      permissions: resolvePermissions(user.role, user.permissions),
    })
    db.auditLog
      .log(
        currentUser?.email,
        'permission_preview_started',
        `Started permission preview as ${user.user_email} (${user.role})`
      )
      .catch(() => {})
  }

  const stopPreview = () => {
    if (previewUser) {
      db.auditLog
        .log(
          currentUser?.email,
          'permission_preview_stopped',
          `Stopped permission preview as ${previewUser.email}`
        )
        .catch(() => {})
    }
    setPreviewUser(null)
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

  // ── Overdue activities count — drives the sidebar badge ──────────────────
  const { data: overdueActivities = EMPTY_ARRAY } = useQuery({
    queryKey: ['activities', 'overdue-count'],
    queryFn: () => db.activities.listOverdue(),
    staleTime: 60_000,
    enabled: !!currentUser,
  })
  const overdueActivityCount = overdueActivities.length

  // ── Active state derived from URL ─────────────────────────────────────────
  const isProductsActive = pathname === '/products' || pathname.startsWith('/products/')
  const isCustomersActive = pathname === '/customers' || pathname.startsWith('/customers/')
  // Uses effectiveUserRole (not currentUserRole) so sidebar visibility respects
  // permission preview — these gate what's rendered, not what's authenticated.
  const isAdminOrManagerRole =
    effectiveUserRole === ROLES.ADMIN ||
    effectiveUserRole === ROLES.SUPER_ADMIN ||
    effectiveUserRole === ROLES.MANAGER

  const rawNavItems = [
    {
      path: '/',
      label: t('nav.dashboard'),
      active: pathname === '/' || pathname === '/dashboard',
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
      // No requiredPermission — Dashboard is the universal home route, shown
      // to every authenticated role regardless of section-level permissions.
    },
    {
      path: '/products',
      label: t('nav.products'),
      active: isProductsActive,
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
      tabParam: 'tab',
      requiredPermission: ['products', 'view'],
      children: [
        { tabId: 'products', label: t('products.tabProducts') },
        { tabId: 'hierarchy', label: t('products.tabHierarchy') },
      ],
    },
    {
      path: '/customers',
      label: t('nav.customers'),
      active: isCustomersActive,
      icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
      requiredPermission: ['customers', 'view'],
    },
    {
      path: '/leads',
      label: t('nav.leads'),
      active: pathname === '/leads',
      icon: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z M15 11a3 3 0 11-6 0 3 3 0 016 0z',
      requiredPermission: ['leads', 'view'],
    },
    {
      path: '/pipeline',
      label: t('nav.pipeline'),
      active: pathname === '/pipeline',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14',
      requiredPermission: ['deals', 'view'],
    },
    {
      path: '/activities',
      label: t('nav.activities'),
      active: pathname === '/activities',
      icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
      badge: overdueActivityCount > 0 ? overdueActivityCount : null,
      requiredPermission: ['deals', 'view'],
    },
    {
      path: '/sales',
      label: t('nav.sales'),
      active: pathname === '/sales',
      icon: 'M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z',
      requiredPermission: ['deals', 'view'],
    },
    {
      path: '/accounting',
      label: t('nav.accounting'),
      active: pathname === '/accounting',
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V6m0 10v2m9-8a9 9 0 11-18 0 9 9 0 0118 0z',
      requiredPermission: ['deals', 'view'],
    },
    {
      path: '/purchasing',
      label: t('nav.purchasing'),
      active: pathname === '/purchasing',
      icon: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
      requiredPermission: ['deals', 'view'],
    },
    {
      path: '/rma-tickets',
      label: t('nav.rmaTickets'),
      active: pathname === '/rma-tickets',
      icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z',
      requiredPermission: ['rma_tickets', 'view_all'],
    },
    {
      path: '/inventory',
      label: t('nav.inventory'),
      active: pathname === '/inventory',
      icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
      tabParam: 'tab',
      requiredPermission: ['inventory', 'view'],
      children: [
        { tabId: 'overview', label: t('inventory.overview') },
        { tabId: 'by-product', label: t('inventory.allUnits') },
        { tabId: 'stock-movements', label: t('inventory.stockMovements') },
        { tabId: 'warehouses', label: t('inventory.warehouses') },
      ],
    },
    {
      path: '/calendar',
      label: t('nav.calendar'),
      active: pathname === '/calendar',
      icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
      requiredPermission: ['calendar', 'view'],
    },
    {
      path: '/reports',
      label: t('nav.reports'),
      active: pathname === '/reports',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
      tabParam: 'tab',
      requiredPermission: ['reports', 'view'],
      children: [
        { tabId: 'tickets', label: t('reports.tabTickets') },
        ...(isAdminOrManagerRole
          ? [
              { tabId: 'customers', label: t('reports.tabCustomers') },
              { tabId: 'technicians', label: t('reports.tabTechnicians') },
              { tabId: 'financial', label: t('reports.tabFinancial') },
            ]
          : []),
      ],
    },
    ...(effectiveUserRole === ROLES.ADMIN || effectiveUserRole === ROLES.SUPER_ADMIN
      ? [
          {
            path: '/control-panel',
            label: t('nav.controlPanel'),
            active: pathname === '/control-panel',
            icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
            separator: true,
            tabParam: 'section',
            children: [
              {
                tabId: 'rmaconfig',
                label: t('cp.groupTickets'),
                activeSections: ['rmaconfig', 'customfields', 'pdflayout'],
              },
              {
                tabId: 'users',
                label: t('cp.groupUsers'),
                activeSections: ['users', 'announcements', 'broadcast'],
              },
              {
                tabId: 'appearance',
                label: t('cp.groupAppearance'),
                activeSections: ['appearance', 'email'],
              },
              {
                tabId: 'sla',
                label: t('cp.groupAutomation'),
                activeSections: ['sla', 'automation', 'webhooks', 'integrations'],
              },
              {
                tabId: 'wa-settings',
                label: t('cp.groupMessaging'),
                activeSections: ['wa-settings', 'wa-templates', 'wa-logs', 'wa-test'],
              },
              {
                tabId: 'audit',
                label: t('cp.groupData'),
                activeSections: ['audit', 'cleanup', 'backup'],
              },
            ],
          },
        ]
      : []),
  ]

  // Hide any nav item the current role has zero access to, rather than
  // showing a link that leads to an empty/blocked page. control-panel is
  // already gated above (only spread into the array for admin/super_admin),
  // so it has no requiredPermission and passes through unfiltered.
  const navItems = rawNavItems.filter(
    (item) =>
      !item.requiredPermission ||
      canDo(effectiveUserRole, effectiveUserPermissions, ...item.requiredPermission)
  )

  // ── Derive page title for mobile header ───────────────────────────────────
  // Runs through t() so the header matches the rest of the chrome — it used to
  // be a hardcoded English map, which left the bar reading "Deal Details" while
  // the whole page beneath it was Arabic (found in manual QA 2026-08-05,
  // WAREHOUSE_R1_TEST_CHECKLIST.md §E). Reuses the existing `nav.*` keys so the
  // header and the sidebar entry for a page always agree.
  const mobileTitle = (() => {
    if (pathname.startsWith('/products/')) return t('nav.productDetails')
    if (pathname.startsWith('/customers/')) return t('nav.customerDetails')
    if (pathname.startsWith('/leads/')) return t('nav.leadDetails')
    if (pathname.startsWith('/pipeline/')) return t('nav.dealDetails')
    if (pathname.startsWith('/purchasing/vendor/')) return t('purchasing.vendorDetails')
    const MAP = {
      '/': t('nav.dashboard'),
      '/dashboard': t('nav.dashboard'),
      '/products': t('nav.products'),
      '/customers': t('nav.customers'),
      '/leads': t('nav.leads'),
      '/pipeline': t('nav.pipeline'),
      '/activities': t('nav.activities'),
      '/sales': t('nav.salesDocuments'),
      '/sales/': t('nav.salesDocument'),
      '/accounting': t('nav.accounting'),
      '/purchasing': t('nav.purchasing'),
      '/rma-tickets': t('nav.rmaTickets'),
      '/inventory': t('nav.inventory'),
      '/account': t('nav.accountSettings'),
      '/control-panel': t('nav.controlPanel'),
      '/calendar': t('nav.calendar'),
      '/reports': t('nav.reports'),
    }
    // Unmapped routes fall back to a title-cased slug — English-shaped, but it
    // only ever fires for a route nobody has added a key for yet.
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

  if (pathname === '/kb') {
    return (
      <>
        <KnowledgeBasePublic />
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
      <PreviewBanner previewUser={previewUser} onExit={stopPreview} />
      <Toaster position="top-right" />
      {showOnboarding && (
        <OnboardingWizard
          userEmail={currentUser?.email}
          onClose={() => setShowOnboarding(false)}
          onNavigate={(path) => { navigate(path) }}
        />
      )}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        id="app-sidebar"
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
                className="w-10 h-10 flex items-center justify-center rounded-lg text-[#777268] dark:text-[#768292] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
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
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-[#777268] dark:text-[#768292] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors lg:flex hidden"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Close navigation"
                  className="lg:hidden w-8 h-8 flex items-center justify-center text-[#777268] dark:text-[#768292] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
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
          {navItems.map(({ path, label, active, icon, separator, badge }) => {
            return (
              <div key={path}>
                {separator && (
                  <div className="pt-2 border-t border-[#e6e9ef] dark:border-[#212a38] my-1" />
                )}
                <button
                  onClick={() => handleNavigate(path)}
                  title={sidebarCompact ? label : undefined}
                  className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2.5'} rounded-[10px] text-[13.5px] font-[600] transition-colors ${active ? 'bg-[rgba(67,56,202,0.11)] dark:bg-[rgba(165,180,252,0.16)] text-[#4338ca] dark:text-[#a5b4fc]' : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
                >
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={active ? 2.2 : 1.7} d={icon} />
                  </svg>
                  {!sidebarCompact && (
                    <>
                      <span className="flex-1 text-start">{label}</span>
                      {badge != null && (
                        <span className="w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center flex-shrink-0">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </>
                  )}
                </button>
              </div>
            )
          })}

          <div className="pt-2 border-t border-[#e6e9ef] dark:border-[#212a38] my-1" />
          <a
            href="/tracker"
            target="_blank"
            rel="noopener noreferrer"
            title={sidebarCompact ? t('nav.customerTracker') : undefined}
            className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-3 py-2.5'} rounded-[10px] text-[13.5px] font-[600] transition-colors text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230]`}
          >
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            {!sidebarCompact && (
              <span className="flex items-center gap-1.5">
                {t('nav.customerTracker')}
                <svg className="w-3 h-3 text-[#777268] dark:text-[#768292]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </span>
            )}
          </a>

        </nav>

      </div>

      {/* UX-4: inert disables all keyboard/pointer interaction behind the open sidebar on mobile */}
      {/* min-w-0 is required here: a flex item's implicit min-width is "auto" (its content
          width), so without it a wide page (e.g. the Pipeline Kanban board) forces this whole
          column wider than the viewport instead of scrolling internally — dragging the sidebar
          along with it. min-w-0 lets this column shrink to the available space so only the
          page's own overflow-x-auto containers scroll, not the app shell. */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0" {...(sidebarOpen ? { inert: '' } : {})}>
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
          <CommandPalette
            inputRef={cmdSearchRef}
            onSelectTicket={handleCmdSelectTicket}
            onSelectProduct={handleCmdSelectProduct}
          />
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
                className="w-4 h-4 text-[#777268] dark:text-[#768292] flex-shrink-0"
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

        {/* ── Breadcrumb — only renders when there's a trail ───────────────── */}
        <Breadcrumb />

        {/* ── Page content — React Router <Routes> ─────────────────────────
            <main>, not <div>: every routed page lived outside any landmark, so
            axe reported "Some page content is not contained by landmarks" on
            every load and screen-reader users had no main-content region to
            jump to. The two <nav>s already existed; this was the missing one.
            Block-level either way, so the flex/scroll layout is unchanged. */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 main-scroll">
          <Suspense fallback={<PageSpinner />}>
            <Routes>
              <Route
                path="/"
                element={
                  <Dashboard currentUserEmail={currentUser?.email} currentUserRole={effectiveUserRole} onNavigate={handleNavigate} />
                }
              />
              <Route path="/dashboard" element={<Navigate to="/" replace />} />

              <Route
                path="/products"
                element={
                  <Products
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                    onNavigateToProduct={(id) => navigate(`/products/${id}`)}
                  />
                }
              />
              <Route
                path="/products/:id"
                element={
                  <ProductDetailsRoute
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/customers"
                element={
                  <Customers
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                    onNavigateToCustomer={(id) => navigate(`/customers/${id}`)}
                  />
                }
              />
              <Route
                path="/customers/:id"
                element={
                  <CustomerDetailsRoute
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/leads"
                element={
                  <Leads
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                  />
                }
              />

              <Route
                path="/leads/:id"
                element={
                  <LeadDetailsRoute
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                  />
                }
              />

              <Route
                path="/pipeline"
                element={
                  <Pipeline
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                  />
                }
              />

              <Route
                path="/pipeline/:id"
                element={
                  <DealDetailsRoute
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                  />
                }
              />

              <Route
                path="/activities"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ||
                  canDo(effectiveUserRole, effectiveUserPermissions, 'leads', 'view') ? (
                    <Activities
                      currentUserRole={effectiveUserRole}
                      currentUserEmail={currentUser?.email}
                      currentUserPermissions={effectiveUserPermissions}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/sales"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ? (
                    <SalesDocuments
                      currentUserRole={effectiveUserRole}
                      currentUserEmail={currentUser?.email}
                      currentUserPermissions={effectiveUserPermissions}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/accounting"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ? (
                    <Accounting currentUserEmail={currentUser?.email} />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/purchasing"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ? (
                    <Purchasing
                      currentUserRole={effectiveUserRole}
                      currentUserEmail={currentUser?.email}
                      currentUserPermissions={effectiveUserPermissions}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/purchasing/vendor/:id"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ? (
                    <VendorDetailsRoute
                      currentUserRole={effectiveUserRole}
                      currentUserPermissions={effectiveUserPermissions}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/purchasing/:type/:id"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ? (
                    <PurchaseDocumentDetailRoute
                      currentUserRole={effectiveUserRole}
                      currentUserEmail={currentUser?.email}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/sales/:type/:id"
                element={
                  canDo(effectiveUserRole, effectiveUserPermissions, 'deals', 'view') ? (
                    <SalesDocumentDetailRoute
                      currentUserRole={effectiveUserRole}
                      currentUserEmail={currentUser?.email}
                    />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              <Route
                path="/rma-tickets"
                element={
                  <RMATickets
                    userRole={effectiveUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={effectiveUserPermissions}
                    initialTicketId={selectedTicketId}
                  />
                }
              />

              <Route
                path="/inventory"
                element={
                  <Inventory
                    userRole={effectiveUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={effectiveUserPermissions}
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
                  effectiveUserRole === ROLES.ADMIN || effectiveUserRole === ROLES.SUPER_ADMIN ? (
                    <ControlPanel
                      currentUserRole={effectiveUserRole}
                      currentUserEmail={currentUser?.email}
                      currentUserPermissions={effectiveUserPermissions}
                      onStartPreview={startPreview}
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
                    userRole={effectiveUserRole}
                    userEmail={currentUser?.email}
                    userPermissions={effectiveUserPermissions}
                    onNavigateToTicket={handleNavigateToTicket}
                  />
                }
              />

              <Route
                path="/reports"
                element={
                  <Reports
                    currentUserRole={effectiveUserRole}
                    currentUserEmail={currentUser?.email}
                    currentUserPermissions={effectiveUserPermissions}
                  />
                }
              />

              {/* A-1: catch-all 404 — previously typo URLs silently landed on Dashboard */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  )
}
