import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { Toaster } from 'react-hot-toast'
import { auth, db, branding as brandingAPI, supabase } from './api/supabaseClient'
import { useAppearance } from './contexts/AppearanceContext'
import CommandPalette from './components/CommandPalette'
import NotificationBell from './components/NotificationBell'
import { Spinner } from './components/ui'

function AnnouncementBanner() {
  const [items, setItems] = useState([])
  const [dismissed, setDismissed] = useState([])
  useEffect(() => { db.announcements.listActive().then(setItems).catch(() => {}) }, [])
  const visible = items.filter(a => !dismissed.includes(a.id))
  if (!visible.length) return null
  const STYLES = { info: 'bg-blue-600', warning: 'bg-yellow-500', success: 'bg-green-600', error: 'bg-red-600' }
  const ICONS  = { info: 'ℹ️', warning: '⚠️', success: '✅', error: '🚨' }
  return (
    <div className="fixed top-0 left-0 right-0 z-50 space-y-0.5">
      {visible.map(a => (
        <div key={a.id} className={`flex items-center justify-between px-4 py-2 text-white text-sm ${STYLES[a.type] || STYLES.info}`}>
          <span>{ICONS[a.type]} <strong>{a.title}:</strong> {a.message}</span>
          <button onClick={() => setDismissed(d => [...d, a.id])} className="ml-4 opacity-75 hover:opacity-100">✕</button>
        </div>
      ))}
    </div>
  )
}
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import RMATracker from './pages/RMATracker'

const AccountSettings = React.lazy(() => import('./pages/AccountSettings'))
const Dashboard       = React.lazy(() => import('./pages/Dashboard'))
const Products        = React.lazy(() => import('./pages/Products'))
const ProductDetails  = React.lazy(() => import('./pages/ProductDetails'))
const Customers       = React.lazy(() => import('./pages/Customers'))
const CustomerDetails = React.lazy(() => import('./pages/CustomerDetails'))
const RMATickets      = React.lazy(() => import('./pages/RMATickets'))
const Inventory       = React.lazy(() => import('./pages/Inventory'))
const ControlPanel    = React.lazy(() => import('./pages/ControlPanel'))
const TechCalendar    = React.lazy(() => import('./pages/TechCalendar'))
const Invoices        = React.lazy(() => import('./pages/Invoices'))
const PartsInventory  = React.lazy(() => import('./pages/PartsInventory'))
const Reports         = React.lazy(() => import('./pages/Reports'))

const PageSpinner = () => (
  <div className="flex items-center justify-center h-64">
    <Spinner size="xl" />
  </div>
)

const ROLE_DEFAULT_PERMISSIONS = {
  manager: {
    products: { view: true, create: true, edit: true, delete: false, export: true, import: false },
    customers: { view: true, create: true, edit: true, delete: false, export: true, import: false, view_history: true },
    rma_tickets: { view_all: true, view_assigned: true, create: true, edit_all: true, edit_assigned: true, delete: false, assign: true, change_status: true, change_priority: true, add_comments: true, delete_comments: false, view_activity: true, attach_files: true, delete_files: false, print_labels: true, export: true },
    inventory: { view: true, resolve_units: true, manage_batches: true, delete: false, export: true, manage_warehouses: false, transfer: false },
    dashboard: { view_dashboard: true, view_analytics: true, view_reports: true, export_reports: true, customize_dashboard: false },
    user_management: { view_users: true, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
    settings: { view_settings: true, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: false, manage_priorities: false, manage_categories: false, view_audit_logs: false },
    invoices: { view: true, create: true, edit: true, delete: false },
    time_tracking: { log: true, view_all: true, delete: false },
    parts: { view: true, create: true, edit: true, delete: false },
    calendar: { view: true },
    reports: { view: true, export: true },
  },
  technician: {
    products: { view: true, create: false, edit: false, delete: false, export: false, import: false },
    customers: { view: true, create: false, edit: false, delete: false, export: false, import: false, view_history: true },
    rma_tickets: { view_all: true, view_assigned: true, create: false, edit_all: false, edit_assigned: true, delete: false, assign: false, change_status: true, change_priority: false, add_comments: true, delete_comments: false, view_activity: true, attach_files: true, delete_files: false, print_labels: true, export: false },
    inventory: { view: true, resolve_units: true, manage_batches: false, delete: false, export: false, manage_warehouses: false, transfer: false },
    dashboard: { view_dashboard: true, view_analytics: false, view_reports: false, export_reports: false, customize_dashboard: false },
    user_management: { view_users: false, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
    settings: { view_settings: false, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: false, manage_priorities: false, manage_categories: false, view_audit_logs: false },
    invoices: { view: true, create: false, edit: false, delete: false },
    time_tracking: { log: true, view_all: false, delete: false },
    parts: { view: true, create: false, edit: false, delete: false },
    calendar: { view: true },
    reports: { view: false, export: false },
  },
  viewer: {
    products: { view: true, create: false, edit: false, delete: false, export: false, import: false },
    customers: { view: true, create: false, edit: false, delete: false, export: false, import: false, view_history: true },
    rma_tickets: { view_all: true, view_assigned: false, create: false, edit_all: false, edit_assigned: false, delete: false, assign: false, change_status: false, change_priority: false, add_comments: false, delete_comments: false, view_activity: true, attach_files: false, delete_files: false, print_labels: false, export: false },
    inventory: { view: true, resolve_units: false, manage_batches: false, delete: false, export: true, manage_warehouses: false, transfer: false },
    dashboard: { view_dashboard: true, view_analytics: false, view_reports: false, export_reports: false, customize_dashboard: false },
    user_management: { view_users: false, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
    settings: { view_settings: false, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: false, manage_priorities: false, manage_categories: false, view_audit_logs: false },
    invoices: { view: true, create: false, edit: false, delete: false },
    time_tracking: { log: false, view_all: false, delete: false },
    parts: { view: true, create: false, edit: false, delete: false },
    calendar: { view: true },
    reports: { view: false, export: false },
  }
}

function pathToPage(path) {
  if (!path || path === '/' || path === '/dashboard') return { page: 'dashboard' }
  if (path === '/products') return { page: 'products' }
  if (path.startsWith('/products/')) return { page: 'product-details', id: path.split('/')[2] }
  if (path === '/customers') return { page: 'customers' }
  if (path.startsWith('/customers/')) return { page: 'customer-details', id: path.split('/')[2] }
  if (path === '/rma-tickets') return { page: 'rma-tickets' }
  if (path === '/inventory') return { page: 'inventory' }
  if (path === '/account') return { page: 'account' }
  if (path === '/control-panel') return { page: 'control-panel' }
  if (path === '/calendar') return { page: 'calendar' }
  if (path === '/invoices') return { page: 'invoices' }
  if (path === '/parts') return { page: 'parts' }
  if (path === '/reports') return { page: 'reports' }
  return { page: 'dashboard' }
}

function pageToPath(page, id = null) {
  if (page === 'product-details' && id) return `/products/${id}`
  if (page === 'customer-details' && id) return `/customers/${id}`
  if (page === 'dashboard') return '/'
  return `/${page}`
}

export default function App() {
  const { sidebarCompact, updateAppearance } = useAppearance()
  const [currentUser, setCurrentUser] = useState(null)
  const [currentUserRole, setCurrentUserRole] = useState(null)
  const [currentUserPermissions, setCurrentUserPermissions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(() => pathToPage(window.location.pathname).page)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [selectedProductId, setSelectedProductId] = useState(() => pathToPage(window.location.pathname).id || null)
  const [selectedCustomerId, setSelectedCustomerId] = useState(() => pathToPage(window.location.pathname).id || null)
  const [selectedTicketId, setSelectedTicketId] = useState(null)
  const [resetPasswordMode, setResetPasswordMode] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [notifMissing, setNotifMissing] = useState(false)
  const notifChannelRef = useRef(null)
  const userMenuRef = useRef(null)

  useEffect(() => {
    brandingAPI.getBranding().then(b => { if (b?.company_name) setCompanyName(b.company_name) }).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen(open => !open)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    checkAuth()
    const { data: { subscription } } = auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setResetPasswordMode(true)
        setLoading(false)
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  const checkAuth = async () => {
    try {
      const user = await auth.getCurrentUser()
      if (user) {
        setCurrentUser(user)
        const roleData = await db.userRoles.getUserRole(user.email)
        const role = roleData?.role || 'technician'
        setCurrentUserRole(role)
        setCurrentUserPermissions(roleData?.permissions || ROLE_DEFAULT_PERMISSIONS[role] || null)
      }
    } catch (error) {
      console.error('Auth check error:', error)
    } finally {
      setLoading(false)
    }
  }

  // Load notifications once and maintain a single real-time subscription
  const loadNotifsRef = useRef(null)

  useEffect(() => {
    if (!currentUser?.email || !currentUserRole || notifMissing) return

    const applyPrefs = (data) => {
      try {
        const prefs = JSON.parse(localStorage.getItem(`notif_system_prefs_${currentUser.email}`) || '{}')
        return data.filter(n => prefs[n.type] !== false)
      } catch { return data }
    }

    const loadNotifs = async () => {
      const result = await db.notifications.listForUser(currentUser.email, currentUserRole)
      if (result.missing) { setNotifMissing(true); return }
      setNotifMissing(false)
      setNotifications(applyPrefs(result.data))
    }

    loadNotifsRef.current = loadNotifs
    loadNotifs()

    const channel = supabase.channel('app_notifications')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, () => loadNotifs())
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

    // Cross-tab sync via BroadcastChannel (supported in all modern browsers)
    let bc = null
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('notif_system_prefs')
      bc.onmessage = (e) => {
        if (e.data?.type === 'notif-system-prefs-changed') {
          // Write the fresh prefs into localStorage so applyPrefs() picks them up
          if (e.data.prefs && currentUser?.email) {
            try {
              localStorage.setItem(`notif_system_prefs_${currentUser.email}`, JSON.stringify(e.data.prefs))
            } catch {}
          }
          loadNotifsRef.current?.()
        }
      }
    }

    return () => {
      window.removeEventListener('notif-system-prefs-changed', handler)
      try { bc?.close() } catch {}
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

  const markAllNotifsRead = useCallback(async () => {
    if (!currentUser?.email || !currentUserRole) return
    await db.notifications.markAllRead(currentUser.email, currentUserRole)
    setNotifications(prev => prev.map(n => ({
      ...n,
      read_by: n.read_by?.includes(currentUser.email) ? n.read_by : [...(n.read_by || []), currentUser.email]
    })))
  }, [currentUser?.email, currentUserRole])

  const handleLogin = async (email, password) => {
    const data = await auth.signIn(email, password)
    const user = data?.user || data
    setCurrentUser(user)
    const roleData = await db.userRoles.getUserRole(user.email)
    const role = roleData?.role || 'technician'
    setCurrentUserRole(role)
    setCurrentUserPermissions(roleData?.permissions || ROLE_DEFAULT_PERMISSIONS[role] || null)
    db.userActivity.create(user.email, 'login', `Signed in as ${role}`).catch(() => {})
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
    setCurrentPage('dashboard')
    window.history.replaceState({}, '', '/')
  }

  const handleNavigate = (page) => {
    window.history.pushState({ page }, '', pageToPath(page))
    setCurrentPage(page)
    setSelectedProductId(null)
    setSelectedCustomerId(null)
    setSelectedTicketId(null)
    setSidebarOpen(false)
  }

  const handleNavigateToProduct = (productId) => {
    window.history.pushState({ page: 'product-details', id: productId }, '', `/products/${productId}`)
    setSelectedProductId(productId)
    setCurrentPage('product-details')
    setSidebarOpen(false)
  }

  const handleBackFromProductDetails = () => {
    window.history.pushState({ page: 'products' }, '', '/products')
    setSelectedProductId(null)
    setCurrentPage('products')
  }

  const handleNavigateToCustomer = (customerId) => {
    window.history.pushState({ page: 'customer-details', id: customerId }, '', `/customers/${customerId}`)
    setSelectedCustomerId(customerId)
    setCurrentPage('customer-details')
    setSidebarOpen(false)
  }

  const handleBackFromCustomerDetails = () => {
    window.history.pushState({ page: 'customers' }, '', '/customers')
    setSelectedCustomerId(null)
    setCurrentPage('customers')
  }

  const handleProfileUpdate = (updatedUser) => {
    setCurrentUser(updatedUser)
  }

  useEffect(() => {
    const onPopState = () => {
      const { page, id } = pathToPage(window.location.pathname)
      setCurrentPage(page)
      setSelectedTicketId(null)
      if (page === 'product-details') { setSelectedProductId(id || null); setSelectedCustomerId(null) }
      else if (page === 'customer-details') { setSelectedCustomerId(id || null); setSelectedProductId(null) }
      else { setSelectedProductId(null); setSelectedCustomerId(null) }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const handleNavigateToTicket = (ticketId) => {
    window.history.pushState({ page: 'rma-tickets' }, '', '/rma-tickets')
    setSelectedTicketId(ticketId)
    setCurrentPage('rma-tickets')
    setSidebarOpen(false)
  }

  const handleCmdSelectTicket = useCallback((ticket) => {
    window.history.pushState({ page: 'rma-tickets' }, '', '/rma-tickets')
    setSelectedTicketId(ticket.id)
    setCurrentPage('rma-tickets')
    setSidebarOpen(false)
  }, [])

  const handleCmdSelectCustomer = useCallback((customer) => {
    setSelectedCustomerId(customer.id)
    setCurrentPage('customer-details')
    setSidebarOpen(false)
  }, [])

  const handleCmdSelectProduct = useCallback((product) => {
    setSelectedProductId(product.id)
    setCurrentPage('product-details')
    setSidebarOpen(false)
  }, [])

  const isProductsActive = currentPage === 'products' || currentPage === 'product-details'
  const isCustomersActive = currentPage === 'customers' || currentPage === 'customer-details'

  if (resetPasswordMode) {
    return (
      <>
        <ResetPassword onDone={() => {
          setResetPasswordMode(false)
          setCurrentUser(null)
        }} />
        <Toaster position="top-right" />
      </>
    )
  }

  const isTrackerPage = window.location.pathname === '/tracker'
  if (isTrackerPage) {
    return (
      <>
        <RMATracker />
        <Toaster position="top-right" />
      </>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Spinner size="xl" />
      </div>
    )
  }

  if (!currentUser) {
    return (
      <>
        <Login onLogin={handleLogin} onSignup={handleSignup} />
        <Toaster position="top-right" />
      </>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <AnnouncementBanner />
      <Toaster position="top-right" />
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onSelectTicket={handleCmdSelectTicket}
        onSelectCustomer={handleCmdSelectCustomer}
        onSelectProduct={handleCmdSelectProduct}
      />

      {sidebarOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-20 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className={`fixed lg:static inset-y-0 left-0 z-30 ${sidebarCompact ? 'w-16' : 'w-64'} bg-gradient-to-b from-gray-900 to-gray-800 text-white flex flex-col transform transition-all duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>

        <div className={`border-b border-gray-700 flex items-center ${sidebarCompact ? 'flex-col gap-2 p-3' : 'px-4 py-3 justify-between'}`}>
          {sidebarCompact ? (
            <>
              <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <button
                onClick={() => updateAppearance({ sidebarCompact: false }, currentUser?.email)}
                title="Expand sidebar"
                className="w-10 h-10 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <h1 className="text-xl font-bold">myRMA</h1>
                  <p className="text-xs text-gray-400">{companyName || 'RMA Management'}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => updateAppearance({ sidebarCompact: true }, currentUser?.email)}
                  title="Collapse sidebar"
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors lg:flex hidden"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                  </svg>
                </button>
                <button onClick={() => setSidebarOpen(false)} className="lg:hidden w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>

        <nav className={`flex-1 ${sidebarCompact ? 'p-2' : 'p-4'} space-y-1 overflow-y-auto`}>
          {[
            { page: 'dashboard', label: 'Dashboard', active: currentPage === 'dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
            { page: 'products',  label: 'Products',  active: isProductsActive, icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
            { page: 'customers', label: 'Customers', active: isCustomersActive, icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
            { page: 'rma-tickets', label: 'RMA Tickets', active: currentPage === 'rma-tickets', icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z' },
            { page: 'inventory',   label: 'Inventory',   active: currentPage === 'inventory',   icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4' },
            { page: 'calendar',    label: 'Calendar',    active: currentPage === 'calendar',    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
            { page: 'reports',     label: 'Reports',     active: currentPage === 'reports',     icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z' },
          ].map(({ page, label, active, icon }) => (
            <button key={page} onClick={() => handleNavigate(page)} title={sidebarCompact ? label : undefined}
              className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-4 py-3'} rounded-lg text-sm font-medium transition-colors ${active ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}>
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
              </svg>
              {!sidebarCompact && label}
            </button>
          ))}

          <div className="pt-2 border-t border-gray-700/60 my-1" />
          <a href="/tracker" target="_blank" rel="noopener noreferrer" title={sidebarCompact ? 'Customer Tracker' : undefined}
            className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-4 py-3'} rounded-lg text-sm font-medium transition-colors text-gray-300 hover:bg-gray-700`}>
            <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            {!sidebarCompact && (
              <span className="flex items-center gap-1.5">
                Customer Tracker
                <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
              </span>
            )}
          </a>

          {(currentUserRole === 'admin' || currentUserRole === 'super_admin') && (
            <>
              <div className="pt-2 border-t border-gray-700/60 my-1" />
              <button onClick={() => handleNavigate('control-panel')} title={sidebarCompact ? 'Control Panel' : undefined}
                className={`w-full flex items-center ${sidebarCompact ? 'justify-center px-2 py-3' : 'gap-3 px-4 py-3'} rounded-lg text-sm font-medium transition-colors ${currentPage === 'control-panel' ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}>
                <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {!sidebarCompact && 'Control Panel'}
              </button>
            </>
          )}

        </nav>


      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <div className="lg:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
          <button onClick={() => setSidebarOpen(true)} className="text-gray-600 hover:text-gray-900">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h2 className="text-lg font-semibold text-gray-900 capitalize">
            {currentPage.replace(/-/g, ' ')}
          </h2>
          <div className="flex items-center gap-1.5">
            <NotificationBell
              notifications={notifications}
              currentUserEmail={currentUser?.email}
              sidebarCompact={true}
              onNavigateToTicket={handleNavigateToTicket}
              onMarkAllRead={markAllNotifsRead}
              mobile={true}
            />
            <button
              onClick={() => handleNavigate('account')}
              title="Account Settings"
              className={`w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-semibold text-sm uppercase flex-shrink-0 ${currentPage === 'account' ? 'ring-2 ring-indigo-400' : ''}`}
            >
              {(currentUser?.user_metadata?.display_name || currentUser?.email || '?')[0]}
            </button>
          </div>
        </div>

        {/* Desktop top bar — notifications + user menu */}
        <div className="hidden lg:flex items-center justify-end gap-1 px-6 py-2 bg-white border-b border-gray-100 flex-shrink-0">
          <NotificationBell
            notifications={notifications}
            currentUserEmail={currentUser?.email}
            sidebarCompact={true}
            onNavigateToTicket={handleNavigateToTicket}
            onMarkAllRead={markAllNotifsRead}
            mobile={true}
          />
          {/* User dropdown */}
          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen(o => !o)}
              className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            >
              {currentUser?.user_metadata?.avatar_url ? (
                <img src={currentUser.user_metadata.avatar_url} alt="avatar" className="w-8 h-8 rounded-full object-cover ring-2 ring-indigo-500/30 flex-shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white font-semibold text-sm uppercase flex-shrink-0">
                  {(currentUser?.user_metadata?.display_name || currentUser?.email || '?')[0]}
                </div>
              )}
              <div className="text-left hidden xl:block">
                <div className="text-sm font-medium text-gray-900 leading-none truncate max-w-[160px]">
                  {currentUser?.user_metadata?.display_name || currentUser?.email}
                </div>
                <div className="text-xs text-gray-500 capitalize mt-0.5">{currentUserRole}</div>
              </div>
              <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-52 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <div className="text-sm font-semibold text-gray-900 truncate">
                    {currentUser?.user_metadata?.display_name || currentUser?.email}
                  </div>
                  <div className="text-xs text-gray-500 capitalize mt-0.5">{currentUserRole}</div>
                </div>
                <button
                  onClick={() => { handleNavigate('account'); setUserMenuOpen(false) }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                >
                  <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Account Settings
                </button>
                <div className="border-t border-gray-100" />
                <button
                  onClick={() => { handleLogout(); setUserMenuOpen(false) }}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors text-left"
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 main-scroll">
          <Suspense fallback={<PageSpinner />}>
          {currentPage === 'account' && (
            <AccountSettings
              currentUser={currentUser}
              currentUserRole={currentUserRole}
              onProfileUpdate={handleProfileUpdate}
            />
          )}
          {currentPage === 'dashboard' && (
            <Dashboard currentUserEmail={currentUser?.email} onNavigate={handleNavigate} />
          )}
          {currentPage === 'products' && (
            <Products
              currentUserRole={currentUserRole}
              currentUserEmail={currentUser?.email}
              currentUserPermissions={currentUserPermissions}
              onNavigateToProduct={handleNavigateToProduct}
            />
          )}
          {currentPage === 'product-details' && selectedProductId && (
            <ProductDetails
              productId={selectedProductId}
              currentUserRole={currentUserRole}
              currentUserEmail={currentUser?.email}
              currentUserPermissions={currentUserPermissions}
              onBack={handleBackFromProductDetails}
              onNavigateToTicket={handleNavigateToTicket}
            />
          )}
          {currentPage === 'customers' && (
            <Customers
              currentUserRole={currentUserRole}
              currentUserEmail={currentUser?.email}
              currentUserPermissions={currentUserPermissions}
              onNavigateToCustomer={handleNavigateToCustomer}
            />
          )}
          {currentPage === 'customer-details' && selectedCustomerId && (
            <CustomerDetails
              customerId={selectedCustomerId}
              currentUserRole={currentUserRole}
              currentUserEmail={currentUser?.email}
              currentUserPermissions={currentUserPermissions}
              onBack={handleBackFromCustomerDetails}
              onNavigateToTicket={handleNavigateToTicket}
            />
          )}
          {currentPage === 'rma-tickets' && (
            <RMATickets
              userRole={currentUserRole}
              userEmail={currentUser?.email}
              userPermissions={currentUserPermissions}
              initialTicketId={selectedTicketId}
            />
          )}
          {currentPage === 'inventory' && (
            <Inventory
              userRole={currentUserRole}
              userEmail={currentUser?.email}
              userPermissions={currentUserPermissions}
              onNavigateToTicket={handleNavigateToTicket}
            />
          )}
          {currentPage === 'control-panel' && (
            <ControlPanel
              currentUserRole={currentUserRole}
              currentUserEmail={currentUser?.email}
            />
          )}
          {currentPage === 'calendar' && (
            <TechCalendar
              userRole={currentUserRole}
              userEmail={currentUser?.email}
              userPermissions={currentUserPermissions}
              onNavigateToTicket={handleNavigateToTicket}
            />
          )}
          {currentPage === 'invoices' && (
            <Invoices
              userRole={currentUserRole}
              userEmail={currentUser?.email}
              userPermissions={currentUserPermissions}
            />
          )}
          {currentPage === 'parts' && (
            <PartsInventory
              userRole={currentUserRole}
              userEmail={currentUser?.email}
              userPermissions={currentUserPermissions}
            />
          )}
          {currentPage === 'reports' && (
            <Reports
              userRole={currentUserRole}
              userEmail={currentUser?.email}
              userPermissions={currentUserPermissions}
            />
          )}
          </Suspense>
        </div>
      </div>
    </div>
  )
}