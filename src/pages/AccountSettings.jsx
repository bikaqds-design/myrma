import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { auth, db, storage, notifications } from '../api/supabaseClient'
import { captureException } from '../lib/sentry'
import { resetPasswordSchema, getFirstError } from '../lib/schemas'
import { safeStorage } from '../lib/safeStorage'
import { WIDGET_CATALOG } from './Dashboard'
import toast from 'react-hot-toast'
import { Spinner, PageHeader, Button, Input } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'
import { ROLES } from '../lib/constants'
import { useAppearance } from '../contexts/AppearanceContext'

function EyeIcon({ visible }) {
  return visible ? (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
      />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
      />
    </svg>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${checked ? 'bg-indigo-600' : 'bg-gray-200'}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 ${checked ? 'translate-x-4' : 'translate-x-0'}`}
      />
    </button>
  )
}

const NOTIF_ITEMS = [
  { key: 'ticket_created', label: 'New ticket created', desc: 'When a new RMA ticket is opened' },
  {
    key: 'ticket_assigned',
    label: 'Ticket assigned to you',
    desc: 'When a ticket is assigned to your account',
  },
  {
    key: 'ticket_status_changed',
    label: 'Status changed',
    desc: 'When a ticket moves to a new status',
  },
  {
    key: 'ticket_priority_changed',
    label: 'Priority changed',
    desc: 'When a ticket priority is updated',
  },
  { key: 'comment_added', label: 'New comment', desc: 'When someone adds a comment on a ticket' },
  { key: 'ticket_due_soon', label: 'Due soon', desc: '24 hours before a ticket is due' },
  { key: 'ticket_overdue', label: 'Overdue', desc: 'When a ticket passes its due date' },
  { key: 'daily_summary', label: 'Daily summary', desc: 'A morning digest of all open tickets' },
]

const SYSTEM_NOTIF_CATEGORIES = [
  {
    cat: 'Tickets',
    items: [
      {
        key: 'ticket_created',
        label: 'Ticket created',
        desc: 'New RMA ticket opened in the system',
      },
      {
        key: 'ticket_updated',
        label: 'Ticket updated',
        desc: 'Ticket details or fields were modified',
      },
      { key: 'ticket_deleted', label: 'Ticket deleted', desc: 'An RMA ticket was removed' },
      { key: 'ticket_assigned', label: 'Ticket assigned', desc: 'A ticket was assigned to a user' },
      {
        key: 'ticket_status_changed',
        label: 'Status changed',
        desc: 'Ticket moved to a new status',
      },
      { key: 'ticket_overdue', label: 'Ticket overdue', desc: 'Ticket has passed its due date' },
      {
        key: 'due_date_warning',
        label: 'Due date warning',
        desc: '24 hours before a ticket is due',
      },
      { key: 'comment_added', label: 'New comment', desc: 'Someone commented on a ticket' },
    ],
  },
  {
    cat: 'Customers',
    items: [
      {
        key: 'customer_created',
        label: 'Customer created',
        desc: 'New customer added to the system',
      },
      {
        key: 'customer_updated',
        label: 'Customer updated',
        desc: 'Customer information was modified',
      },
      { key: 'customer_deleted', label: 'Customer deleted', desc: 'A customer record was removed' },
    ],
  },
  {
    cat: 'Products',
    items: [
      { key: 'product_created', label: 'Product created', desc: 'New product added to inventory' },
      {
        key: 'product_updated',
        label: 'Product updated',
        desc: 'Product information was modified',
      },
      { key: 'product_deleted', label: 'Product deleted', desc: 'A product was removed' },
      { key: 'inventory_low', label: 'Low inventory', desc: 'Stock level fell below threshold' },
    ],
  },
  {
    cat: 'Users',
    items: [
      { key: 'user_created', label: 'User created', desc: 'New user account was created' },
      { key: 'user_role_changed', label: 'Role changed', desc: "A user's role was updated" },
      {
        key: 'user_suspended',
        label: 'User suspended/locked',
        desc: 'An account was suspended or locked',
      },
      { key: 'user_activated', label: 'User activated', desc: 'An account was reactivated' },
      { key: 'user_deleted', label: 'User deleted', desc: 'A user account was deleted' },
    ],
  },
  {
    cat: 'System',
    items: [
      {
        key: 'system_announcement',
        label: 'System announcements',
        desc: 'Broadcast messages from administrators',
      },
      { key: 'custom_alert', label: 'Custom alerts', desc: 'Manual alerts sent by the admin team' },
    ],
  },
]

export default function AccountSettings({ currentUser, currentUserRole, onProfileUpdate }) {
  const { t } = useTranslation()
  const isAdmin = currentUserRole === ROLES.ADMIN || currentUserRole === ROLES.SUPER_ADMIN
  const tabs = [
    { key: 'Profile', label: t('accountSettings.tabProfile') },
    { key: 'Security', label: t('accountSettings.tabSecurity') },
    { key: 'Notifications', label: t('accountSettings.tabNotifications') },
    { key: 'Appearance', label: t('accountSettings.tabAppearance') },
    ...(isAdmin ? [{ key: 'Activity', label: t('accountSettings.tabActivity') }] : []),
  ]
  const [activeTab, setActiveTab] = useURLTab('tab', 'Profile')

  // Appearance — display settings
  const { darkMode, fontFamily, tableDensity, dateFormat, updateAppearance, language, setLanguage } = useAppearance()
  const updateDisplay = (partial) => updateAppearance(partial, currentUser?.email)

  // Appearance — widget prefs
  const widgetStorageKey = `dashboard_widgets_${currentUser?.email}`
  const [widgetPrefs, setWidgetPrefs] = useState(() =>
    safeStorage.get(`dashboard_widgets_${currentUser?.email}`, WIDGET_CATALOG.map((w) => w.id))
  )

  const toggleWidget = (id) => {
    setWidgetPrefs((prev) => {
      const next = prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]
      safeStorage.set(widgetStorageKey, next)
      window.dispatchEvent(new Event('dashboard-widgets-changed'))
      return next
    })
  }

  const enableAllWidgets = () => {
    const all = WIDGET_CATALOG.map((w) => w.id)
    setWidgetPrefs(all)
    safeStorage.set(widgetStorageKey, all)
    window.dispatchEvent(new Event('dashboard-widgets-changed'))
  }

  const disableAllWidgets = () => {
    setWidgetPrefs([])
    safeStorage.set(widgetStorageKey, [])
    window.dispatchEvent(new Event('dashboard-widgets-changed'))
  }

  // Profile
  const [displayName, setDisplayName] = useState(currentUser?.user_metadata?.display_name || '')
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.user_metadata?.avatar_url || null)
  const [avatarPreview, setAvatarPreview] = useState(null)
  const [avatarFile, setAvatarFile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const fileInputRef = useRef(null)

  // Security — password
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [passwordLoading, setPasswordLoading] = useState(false)

  // Security — sessions
  const [sessions, setSessions] = useState(null) // null = not loaded yet
  // Tracked for a future "this device" badge in the session list — not yet rendered (UX-xx candidate)
  const [_currentSessionId, setCurrentSessionId] = useState(null)
  const [sessionActivity, setSessionActivity] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  // Security — MFA
  const [mfaStatus, setMfaStatus] = useState('loading') // 'loading' | 'disabled' | 'enabled'
  const [mfaFactorId, setMfaFactorId] = useState(null)
  const [mfaStep, setMfaStep] = useState('idle') // 'idle' | 'scan' | 'disabling'
  const [mfaEnrollData, setMfaEnrollData] = useState(null) // { id, qrCode, secret }
  const [mfaCode, setMfaCode] = useState('')
  const [mfaLoading, setMfaLoading] = useState(false)

  // Email notification preferences (DB-backed)
  const [notifPrefs, setNotifPrefs] = useState(null)
  const [notifLoading, setNotifLoading] = useState(false)
  const [notifSaving, setNotifSaving] = useState(false)

  // System (in-app) notification preferences (localStorage-backed, auto-save)
  const sysPrefsKey = `notif_system_prefs_${currentUser?.email}`
  const [sysNotifPrefs, setSysNotifPrefs] = useState(() =>
    safeStorage.get(`notif_system_prefs_${currentUser?.email}`, {})
  )

  // BroadcastChannel for cross-tab pref sync (falls back to no-op if unsupported)
  const notifChannel = useRef(
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('notif_system_prefs') : null
  )
  useEffect(() => {
    const ch = notifChannel.current
    return () => {
      try {
        ch?.close()
      } catch {}
    }
  }, [])

  const broadcastPrefs = (prefs) => {
    window.dispatchEvent(new Event('notif-system-prefs-changed'))
    try {
      notifChannel.current?.postMessage({ type: 'notif-system-prefs-changed', prefs })
    } catch {}
  }

  // A-3: persist to DB (fire-and-forget; localStorage stays the fast path)
  const persistPrefsToDb = (prefs) => {
    if (!currentUser?.email) return
    db.userPreferences.set(currentUser.email, { notifSystem: prefs }).catch(() => {})
  }

  const toggleSysNotif = (key) => {
    setSysNotifPrefs((prev) => {
      const next = { ...prev, [key]: prev[key] === false ? true : false }
      safeStorage.set(sysPrefsKey, next)
      broadcastPrefs(next)
      persistPrefsToDb(next)
      return next
    })
  }
  const setSysAll = (enabled) => {
    const next = {}
    SYSTEM_NOTIF_CATEGORIES.forEach((c) =>
      c.items.forEach((i) => {
        next[i.key] = enabled
      })
    )
    setSysNotifPrefs(next)
    safeStorage.set(sysPrefsKey, next)
    broadcastPrefs(next)
    persistPrefsToDb(next)
  }

  // Activity
  const [activity, setActivity] = useState([])
  const [activityLoading, setActivityLoading] = useState(false)

  useEffect(() => {
    if (activeTab === 'Notifications' && !notifPrefs) loadNotifPrefs()
    if (activeTab === 'Activity' && isAdmin && activity.length === 0) loadActivity()
    if (activeTab === 'Security' && mfaStatus === 'loading') loadMfaStatus()
    if (activeTab === 'Security' && sessions === null) loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isAdmin, notifPrefs, activity.length])

  const loadNotifPrefs = async () => {
    setNotifLoading(true)
    try {
      setNotifPrefs(await notifications.getPreferences(currentUser.email))
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'loadNotifPrefs' })
      toast.error(t('accountSettings.failedLoadPrefs'))
    } finally {
      setNotifLoading(false)
    }
  }

  const loadActivity = async () => {
    setActivityLoading(true)
    try {
      setActivity(await db.userActivity.list(currentUser.email))
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'loadActivity' })
      toast.error(t('accountSettings.failedLoadActivity'))
    } finally {
      setActivityLoading(false)
    }
  }

  const loadSessions = async () => {
    setSessionsLoading(true)
    try {
      const { sessions: list, currentSessionId: cid, activity } = await auth.sessions.list()
      setSessions(list)
      setCurrentSessionId(cid)
      setSessionActivity(activity)
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'loadSessions' })
      toast.error(t('accountSettings.failedLoadSessions', { error: err.message }))
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }

  const handleSignOutAll = async () => {
    try {
      await auth.signOutAll()
      toast.success(t('accountSettings.signedOutAllSuccess'))
      db.auditLog.log(currentUser?.email, 'user_signed_out_all_devices', `Signed out all devices for ${currentUser?.email}`).catch(() => {})
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'signOutAll' })
      toast.error(err.message || t('accountSettings.failedSignOutAll'))
    }
  }

  const loadMfaStatus = async () => {
    try {
      const { data } = await auth.mfa.listFactors()
      const totp = data?.all?.find((f) => f.factor_type === 'totp' && f.status === 'verified')
      if (totp) { setMfaStatus('enabled'); setMfaFactorId(totp.id) }
      else setMfaStatus('disabled')
    } catch { setMfaStatus('disabled') }
  }

  const handleMfaEnable = async () => {
    setMfaLoading(true)
    try {
      const { data, error } = await auth.mfa.enroll()
      if (error) throw error
      setMfaEnrollData({ id: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
      setMfaStep('scan')
      setMfaCode('')
    } catch (err) { toast.error(err.message || t('accountSettings.failedStart2FA')) }
    finally { setMfaLoading(false) }
  }

  const handleMfaConfirm = async () => {
    if (mfaCode.length !== 6) return
    setMfaLoading(true)
    try {
      const { error } = await auth.mfa.challengeAndVerify(mfaEnrollData.id, mfaCode)
      if (error) throw error
      setMfaStatus('enabled')
      setMfaFactorId(mfaEnrollData.id)
      setMfaStep('idle')
      setMfaEnrollData(null)
      setMfaCode('')
      toast.success(t('accountSettings.twoFAEnabledSuccess'))
    } catch (err) { toast.error(err.message || t('accountSettings.invalid2FACode')); setMfaCode('') }
    finally { setMfaLoading(false) }
  }

  const handleMfaDisable = async () => {
    setMfaLoading(true)
    try {
      const { error } = await auth.mfa.unenroll(mfaFactorId)
      if (error) throw error
      setMfaStatus('disabled')
      setMfaFactorId(null)
      setMfaStep('idle')
      toast.success(t('accountSettings.twoFADisabledSuccess'))
    } catch (err) { toast.error(err.message || t('accountSettings.failedDisable2FA')) }
    finally { setMfaLoading(false) }
  }

  const handleAvatarChange = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setAvatarFile(file)
    const reader = new FileReader()
    reader.onload = (ev) => setAvatarPreview(ev.target.result)
    reader.readAsDataURL(file)
  }

  const handleProfileSave = async () => {
    setProfileLoading(true)
    try {
      let newUrl = avatarUrl
      if (avatarFile) newUrl = await storage.uploadAvatar(avatarFile, currentUser.id)
      const { user } = await auth.updateProfile({ display_name: displayName, avatar_url: newUrl })
      setAvatarUrl(newUrl)
      setAvatarPreview(null)
      setAvatarFile(null)
      onProfileUpdate(user)
      toast.success(t('accountSettings.profileUpdatedSuccess'))
      db.auditLog
        .log(
          currentUser?.email,
          'user_profile_updated',
          `Updated profile for ${currentUser?.email}`
        )
        .catch(() => {})
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'updateProfile' })
      toast.error(err.message || t('accountSettings.failedUpdateProfile'))
    } finally {
      setProfileLoading(false)
    }
  }

  const handlePasswordSave = async () => {
    const validation = resetPasswordSchema.safeParse({ newPassword, confirmPassword })
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }
    setPasswordLoading(true)
    try {
      await auth.updatePassword(newPassword)
      setNewPassword('')
      setConfirmPassword('')
      toast.success(t('accountSettings.passwordUpdatedSuccess'))
      db.auditLog
        .log(
          currentUser?.email,
          'user_password_changed',
          `Changed password for ${currentUser?.email}`
        )
        .catch(() => {})
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'updatePassword' })
      toast.error(err.message || t('accountSettings.failedUpdatePassword'))
    } finally {
      setPasswordLoading(false)
    }
  }

  const handleNotifSave = async () => {
    setNotifSaving(true)
    try {
      await notifications.updatePreferences(currentUser.email, notifPrefs)
      toast.success(t('accountSettings.preferencesSavedSuccess'))
      db.auditLog
        .log(
          currentUser?.email,
          'user_notification_preferences_updated',
          `Updated notification preferences for ${currentUser?.email}`
        )
        .catch(() => {})
    } catch (err) {
      captureException(err, { page: 'AccountSettings', context: 'saveNotifPrefs' })
      toast.error(t('accountSettings.failedSavePrefs'))
    } finally {
      setNotifSaving(false)
    }
  }

  const displayAvatar = avatarPreview || avatarUrl
  const initials = (displayName || currentUser?.email || '?')[0].toUpperCase()

  const roleColors = {
    super_admin: 'bg-purple-100 text-purple-700 border-purple-200',
    admin: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    technician: 'bg-gray-100 text-gray-700 border-gray-200',
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Page header */}
      <PageHeader
        title={t('accountSettings.title')}
        subtitle={t('accountSettings.subtitle')}
        className="mb-8"
      />

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-8">
        <nav className="-mb-px flex gap-4 sm:gap-6 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── PROFILE TAB ── */}
      {activeTab === 'Profile' && (
        <div className="space-y-6">
          {/* Avatar card */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-4">
              {t('accountSettings.profilePhoto')}
            </h2>
            <div className="flex items-center gap-5">
              <div className="relative flex-shrink-0">
                {displayAvatar ? (
                  <img
                    src={displayAvatar}
                    alt="avatar"
                    className="w-20 h-20 rounded-full object-cover ring-4 ring-indigo-50"
                  />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-2xl font-bold ring-4 ring-indigo-50">
                    {initials}
                  </div>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t('accountSettings.uploadPhoto')}
                  className="absolute -bottom-1 -right-1 w-7 h-7 bg-white border-2 border-gray-200 rounded-full flex items-center justify-center hover:bg-indigo-50 hover:border-indigo-300 shadow-sm transition-colors"
                >
                  <svg
                    className="w-3.5 h-3.5 text-gray-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                </button>
              </div>
              <div>
                <Button onClick={() => fileInputRef.current?.click()}>{t('accountSettings.uploadPhoto')}</Button>
                {avatarPreview && (
                  <Button
                    variant="secondary"
                    className="ml-3"
                    onClick={() => {
                      setAvatarPreview(null)
                      setAvatarFile(null)
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                )}
                <p className="text-xs text-gray-500 mt-2">{t('accountSettings.photoHint')}</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
          </div>

          {/* Info card */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
              {t('accountSettings.personalInfo')}
            </h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('accountSettings.displayName')}</label>
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('accountSettings.displayNamePlaceholder')}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('accountSettings.emailAddress')}
              </label>
              <input
                type="email"
                value={currentUser?.email || ''}
                disabled
                className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">{t('accountSettings.emailReadonly')}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('accountSettings.role')}</label>
              <span
                className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border capitalize ${roleColors[currentUserRole] || roleColors.technician}`}
              >
                {currentUserRole}
              </span>
            </div>

            <div className="pt-1 border-t border-gray-100">
              <Button size="lg" loading={profileLoading} onClick={handleProfileSave}>
                {t('accountSettings.saveChanges')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── SECURITY TAB ── */}
      {activeTab === 'Security' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
                {t('accountSettings.changePassword')}
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                {t('accountSettings.changePasswordHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('accountSettings.newPassword')}</label>
              <div className="relative">
                <Input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="pr-10"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  tabIndex={-1}
                  aria-label={showNew ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                >
                  <EyeIcon visible={showNew} />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t('accountSettings.confirmPassword')}
              </label>
              <div className="relative">
                <Input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pr-10"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  tabIndex={-1}
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                >
                  <EyeIcon visible={showConfirm} />
                </button>
              </div>
              {newPassword && confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">{t('common.required')}</p>
              )}
            </div>

            <div className="pt-1 border-t border-gray-100">
              <Button
                size="lg"
                loading={passwordLoading}
                disabled={!newPassword || !confirmPassword}
                onClick={handlePasswordSave}
              >
                {t('accountSettings.changePassword')}
              </Button>
            </div>
          </div>

          <div className="bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] p-6 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] uppercase tracking-wide">
                  {t('accountSettings.activeSessions')}
                </h2>
                <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1">
                  {t('accountSettings.activeSessionsDesc')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={loadSessions}
                  disabled={sessionsLoading}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-[#e8ebf0] hover:bg-gray-100 dark:hover:bg-[#0f1520] transition-colors"
                  aria-label="Refresh sessions"
                >
                  <svg className={`w-4 h-4 ${sessionsLoading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
                <button
                  onClick={handleSignOutAll}
                  className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors whitespace-nowrap"
                >
                  {t('accountSettings.signOutAll')}
                </button>
              </div>
            </div>

            {sessionsLoading && sessions === null && (
              <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-[#9aa4b2] py-2">
                <Spinner size="sm" /> {t('accountSettings.loadingSessions')}
              </div>
            )}

            {sessions !== null && sessions.length > 0 && (
              <div className="space-y-3">
                {sessions.map((session) => {
                  const startedAt = new Date(session.created_at)
                  const expiresAt = session.not_after ? new Date(session.not_after) : null
                  return (
                    <div key={session.id} className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-[#0f1520] border border-gray-100 dark:border-[#212a38]">
                      <div className="mt-1 w-2 h-2 rounded-full bg-green-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-gray-800 dark:text-[#e8ebf0]">{t('accountSettings.currentSession')}</span>
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">{t('accountSettings.thisDevice')}</span>
                          {session.factor_id && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400">2FA</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 dark:text-[#9aa4b2] mt-0.5">
                          {t('accountSettings.sessionStarted', { time: startedAt.toLocaleString() })}
                          {expiresAt && t('accountSettings.sessionExpires', { time: expiresAt.toLocaleString() })}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {sessionActivity.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-400 dark:text-[#9aa4b2] uppercase tracking-wide mb-2">{t('accountSettings.recentLoginActivity')}</p>
                <div className="divide-y divide-gray-100 dark:divide-[#212a38]">
                  {sessionActivity.map((a) => (
                    <div key={a.id} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${a.action === 'login' ? 'bg-green-500' : 'bg-gray-300 dark:bg-[#4a5568]'}`} />
                        <span className="text-xs text-gray-600 dark:text-[#9aa4b2] capitalize">{a.action}</span>
                      </div>
                      <span className="text-xs text-gray-400 dark:text-[#4a5568]">{new Date(a.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Two-Factor Authentication */}
          <div className="bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] p-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] uppercase tracking-wide">
                  {t('accountSettings.twoFactor')}
                </h2>
                <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1">
                  {mfaStatus === 'enabled' ? t('accountSettings.twoFactorEnabled') : t('accountSettings.twoFactorDisabled')}
                </p>
              </div>
              {mfaStatus === 'enabled' && (
                <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  {t('accountSettings.mfaStatusActive')}
                </span>
              )}
            </div>

            {mfaStatus === 'loading' && (
              <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-[#9aa4b2]">
                <Spinner size="sm" /> {t('common.loading')}…
              </div>
            )}

            {mfaStatus === 'disabled' && mfaStep === 'idle' && (
              <Button onClick={handleMfaEnable} loading={mfaLoading} variant="secondary">
                {t('accountSettings.enable2FA')}
              </Button>
            )}

            {mfaStep === 'scan' && mfaEnrollData && (
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">
                  {t('accountSettings.twoFactorHint')}
                </p>
                <div className="flex flex-col sm:flex-row gap-6 items-start">
                  <img
                    src={mfaEnrollData.qrCode}
                    alt="2FA QR code"
                    className="w-40 h-40 border border-gray-200 dark:border-[#212a38] rounded-lg bg-white p-2"
                  />
                  <div className="space-y-3 flex-1">
                    <div>
                      <p className="text-xs font-medium text-gray-500 dark:text-[#9aa4b2] mb-1">{t('accountSettings.manualEntryKey')}</p>
                      <code className="text-xs font-mono bg-gray-100 dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0] px-2 py-1.5 rounded break-all block">
                        {mfaEnrollData.secret}
                      </code>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1.5">
                        {t('accountSettings.verificationCode')}
                      </label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        value={mfaCode}
                        onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                        placeholder="000000"
                        className="font-mono tracking-widest text-center max-w-[160px]"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={handleMfaConfirm} loading={mfaLoading} disabled={mfaCode.length !== 6}>
                        {t('accountSettings.verify2FA')}
                      </Button>
                      <Button variant="secondary" onClick={() => { setMfaStep('idle'); setMfaEnrollData(null); setMfaCode('') }}>
                        {t('accountSettings.cancel2FA')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {mfaStatus === 'enabled' && mfaStep === 'idle' && (
              <Button variant="danger" onClick={handleMfaDisable} loading={mfaLoading}>
                {t('accountSettings.disable2FA')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── NOTIFICATIONS TAB ── */}
      {activeTab === 'Notifications' && (
        <div className="space-y-6">
          {/* Email notifications (DB-backed) */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
                {t('accountSettings.emailNotifications')}
              </h2>
              <p className="text-sm text-gray-500 mt-1">{t('accountSettings.emailNotifsDesc')}</p>
            </div>

            {notifLoading ? (
              <div className="flex justify-center py-10">
                <Spinner size="md" />
              </div>
            ) : notifPrefs ? (
              <>
                <div className="divide-y divide-gray-100">
                  {NOTIF_ITEMS.map(({ key }) => (
                    <div key={key} className="flex items-center justify-between py-3.5">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{t(`accountSettings.notifItems.${key}.label`, { defaultValue: key })}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{t(`accountSettings.notifItems.${key}.desc`, { defaultValue: '' })}</p>
                      </div>
                      <Toggle
                        checked={!!notifPrefs[key]}
                        onChange={(val) => setNotifPrefs((p) => ({ ...p, [key]: val }))}
                      />
                    </div>
                  ))}
                </div>
                <div className="pt-5 border-t border-gray-100 mt-2">
                  <Button size="lg" loading={notifSaving} onClick={handleNotifSave}>
                    {t('accountSettings.savePreferences')}
                  </Button>
                </div>
              </>
            ) : null}
          </div>

          {/* System (in-app) notifications — auto-saves to localStorage */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
                  {t('accountSettings.systemNotifications')}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  {t('accountSettings.systemNotifsDesc')}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <Button variant="secondary" size="sm" onClick={() => setSysAll(false)}>
                  {t('accountSettings.disableAll')}
                </Button>
                <Button size="sm" onClick={() => setSysAll(true)}>
                  {t('accountSettings.enableAll')}
                </Button>
              </div>
            </div>

            <div className="space-y-6">
              {SYSTEM_NOTIF_CATEGORIES.map(({ cat, items }) => (
                <div key={cat}>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    {t(`accountSettings.sysNotifCats.${cat}`, { defaultValue: cat })}
                  </p>
                  <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
                    {items.map(({ key }) => (
                      <div
                        key={key}
                        className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors"
                      >
                        <div>
                          <p className="text-sm font-medium text-gray-800">{t(`accountSettings.sysNotifItems.${key}.label`, { defaultValue: key })}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{t(`accountSettings.sysNotifItems.${key}.desc`, { defaultValue: '' })}</p>
                        </div>
                        <Toggle
                          checked={sysNotifPrefs[key] !== false}
                          onChange={() => toggleSysNotif(key)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── APPEARANCE TAB ── */}
      {activeTab === 'Appearance' && (
        <div className="space-y-6">
          {/* ── Language ── */}
          <div className="bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] p-6">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] uppercase tracking-wide mb-4">
              {t('appearance.language')}
            </h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{t('appearance.language')}</p>
                <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                  {t('appearance.languageSubtitle')}
                </p>
              </div>
              <div className="flex gap-2">
                {[
                  { value: 'en', label: 'English', flag: '🇺🇸' },
                  { value: 'ar', label: 'العربية', flag: '🇸🇦' },
                ].map((lang) => (
                  <button
                    key={lang.value}
                    type="button"
                    onClick={() => setLanguage(lang.value)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${language === lang.value ? 'border-indigo-600 bg-indigo-50 dark:bg-[rgba(99,102,241,0.12)] text-indigo-700 dark:text-[#a5b4fc]' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-gray-300 dark:hover:border-[#2d3a4e]'}`}
                  >
                    <span>{lang.flag}</span>
                    <span>{lang.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Display Settings ── */}
          <div className="bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] p-6">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] uppercase tracking-wide mb-4">
              {t('accountSettings.tabAppearance')}
            </h2>

            {/* Dark Mode */}
            <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-[#212a38]">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{t('appearance.darkMode')}</p>
                <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">{t('appearance.darkModeSubtitle')}</p>
              </div>
              <Toggle checked={darkMode} onChange={(v) => updateDisplay({ darkMode: v })} />
            </div>

            {/* Font Family */}
            <div className="py-3 border-b border-gray-100 dark:border-[#212a38]">
              <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] mb-1">{t('appearance.font')}</p>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-3">{t('appearance.fontSubtitle')}</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 'hanken', label: 'Hanken Grotesk' },
                  { value: 'inter', label: 'Inter' },
                  { value: 'roboto', label: 'Roboto' },
                  { value: 'opensans', label: 'Open Sans' },
                  { value: 'poppins', label: 'Poppins' },
                  { value: 'system', label: 'System' },
                ].map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => updateDisplay({ fontFamily: f.value })}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${fontFamily === f.value ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-gray-300'}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Table Density */}
            <div className="py-3 border-b border-gray-100 dark:border-[#212a38]">
              <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] mb-1">{t('appearance.tableDensity')}</p>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-3">{t('appearance.tableDensitySubtitle')}</p>
              <div className="flex gap-2">
                {[
                  { id: 'spacious', label: 'Spacious' },
                  { id: 'comfortable', label: 'Comfortable' },
                  { id: 'compact', label: 'Compact' },
                ].map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => updateDisplay({ tableDensity: d.id })}
                    className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${tableDensity === d.id ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-gray-300'}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Date Format */}
            <div className="pt-3">
              <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] mb-1">{t('appearance.dateFormat')}</p>
              <div className="flex flex-wrap gap-2 mt-2">
                {['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY'].map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => updateDisplay({ dateFormat: f })}
                    className={`px-3 py-1.5 rounded-lg border text-sm font-mono transition-all ${dateFormat === f ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-gray-300'}`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Dashboard Widgets ── */}
          <div className="bg-white dark:bg-[#121823] rounded-2xl border border-gray-200 dark:border-[#212a38] p-6">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] uppercase tracking-wide">
                  {t('accountSettings.dashboardWidgets')}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  {t('accountSettings.dashboardWidgetsHint')}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={disableAllWidgets}>
                  {t('accountSettings.disableAllWidgets')}
                </Button>
                <Button size="sm" onClick={enableAllWidgets}>
                  {t('accountSettings.enableAllWidgets')}
                </Button>
              </div>
            </div>

            <div className="mt-5 space-y-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-gray-100 rounded-xl overflow-hidden border border-gray-100">
                {WIDGET_CATALOG.map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center justify-between p-4 bg-white hover:bg-gray-50 transition-colors"
                  >
                    <div className="min-w-0 flex-1 pr-4">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-800">{w.label}</p>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded font-medium ${w.size === 'full' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}
                        >
                          {w.size === 'full' ? t('accountSettings.widgetFullWidth') : t('accountSettings.widgetHalfWidth')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{w.desc}</p>
                    </div>
                    <Toggle
                      checked={widgetPrefs.includes(w.id)}
                      onChange={() => toggleWidget(w.id)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs text-gray-500 mt-4 text-center">
              {t('accountSettings.widgetsEnabledSummary', { count: widgetPrefs.length, total: WIDGET_CATALOG.length })}
            </p>
          </div>
        </div>
      )}

      {/* ── ACTIVITY TAB (admin/super_admin only) ── */}
      {activeTab === 'Activity' && isAdmin && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
              {t('accountSettings.recentActivity')}
            </h2>
          </div>

          {activityLoading ? (
            <div className="flex justify-center py-10">
              <Spinner size="md" />
            </div>
          ) : activity.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
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
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
              </div>
              <p className="text-sm text-gray-500">{t('accountSettings.noActivity')}</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {activity.map((item, i) => (
                <div key={i} className="flex items-start gap-3 py-3.5">
                  <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg
                      className="w-4 h-4 text-indigo-500"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 capitalize">
                      {item.action_type?.replace(/_/g, ' ')}
                    </p>
                    {item.action_details && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">
                        {typeof item.action_details === 'string'
                          ? item.action_details
                          : JSON.stringify(item.action_details)}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-gray-500 flex-shrink-0 mt-0.5">
                    {new Date(item.created_date).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
