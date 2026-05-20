import React, { useState, useEffect, useRef } from 'react'
import { auth, db, storage, notifications } from '../api/supabaseClient'
import { WIDGET_CATALOG } from './Dashboard'
import toast from 'react-hot-toast'
import { Spinner, PageHeader } from '../components/ui'

function EyeIcon({ visible }) {
  return visible ? (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
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
      <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  )
}

const NOTIF_ITEMS = [
  { key: 'ticket_created',          label: 'New ticket created',     desc: 'When a new RMA ticket is opened' },
  { key: 'ticket_assigned',         label: 'Ticket assigned to you', desc: 'When a ticket is assigned to your account' },
  { key: 'ticket_status_changed',   label: 'Status changed',         desc: 'When a ticket moves to a new status' },
  { key: 'ticket_priority_changed', label: 'Priority changed',       desc: 'When a ticket priority is updated' },
  { key: 'comment_added',           label: 'New comment',            desc: 'When someone adds a comment on a ticket' },
  { key: 'ticket_due_soon',         label: 'Due soon',               desc: '24 hours before a ticket is due' },
  { key: 'ticket_overdue',          label: 'Overdue',                desc: 'When a ticket passes its due date' },
  { key: 'daily_summary',           label: 'Daily summary',          desc: 'A morning digest of all open tickets' },
]

const SYSTEM_NOTIF_CATEGORIES = [
  { cat: 'Tickets', items: [
    { key: 'ticket_created',        label: 'Ticket created',        desc: 'New RMA ticket opened in the system' },
    { key: 'ticket_updated',        label: 'Ticket updated',        desc: 'Ticket details or fields were modified' },
    { key: 'ticket_deleted',        label: 'Ticket deleted',        desc: 'An RMA ticket was removed' },
    { key: 'ticket_assigned',       label: 'Ticket assigned',       desc: 'A ticket was assigned to a user' },
    { key: 'ticket_status_changed', label: 'Status changed',        desc: 'Ticket moved to a new status' },
    { key: 'ticket_overdue',        label: 'Ticket overdue',        desc: 'Ticket has passed its due date' },
    { key: 'due_date_warning',      label: 'Due date warning',      desc: '24 hours before a ticket is due' },
    { key: 'comment_added',         label: 'New comment',           desc: 'Someone commented on a ticket' },
  ]},
  { cat: 'Customers', items: [
    { key: 'customer_created',      label: 'Customer created',      desc: 'New customer added to the system' },
    { key: 'customer_updated',      label: 'Customer updated',      desc: 'Customer information was modified' },
    { key: 'customer_deleted',      label: 'Customer deleted',      desc: 'A customer record was removed' },
  ]},
  { cat: 'Products', items: [
    { key: 'product_created',       label: 'Product created',       desc: 'New product added to inventory' },
    { key: 'product_updated',       label: 'Product updated',       desc: 'Product information was modified' },
    { key: 'product_deleted',       label: 'Product deleted',       desc: 'A product was removed' },
    { key: 'inventory_low',         label: 'Low inventory',         desc: 'Stock level fell below threshold' },
  ]},
  { cat: 'Users', items: [
    { key: 'user_created',          label: 'User created',          desc: 'New user account was created' },
    { key: 'user_role_changed',     label: 'Role changed',          desc: "A user's role was updated" },
    { key: 'user_suspended',        label: 'User suspended/locked', desc: 'An account was suspended or locked' },
    { key: 'user_activated',        label: 'User activated',        desc: 'An account was reactivated' },
    { key: 'user_deleted',          label: 'User deleted',          desc: 'A user account was deleted' },
  ]},
  { cat: 'System', items: [
    { key: 'system_announcement',   label: 'System announcements',  desc: 'Broadcast messages from administrators' },
    { key: 'custom_alert',          label: 'Custom alerts',         desc: 'Manual alerts sent by the admin team' },
  ]},
]

export default function AccountSettings({ currentUser, currentUserRole, onProfileUpdate }) {
  const isAdmin = currentUserRole === 'admin' || currentUserRole === 'super_admin'
  const tabs = ['Profile', 'Security', 'Notifications', 'Appearance', ...(isAdmin ? ['Activity'] : [])]
  const [activeTab, setActiveTab] = useState('Profile')

  // Appearance — widget prefs
  const widgetStorageKey = `dashboard_widgets_${currentUser?.email}`
  const [widgetPrefs, setWidgetPrefs] = useState(() => {
    try {
      const stored = localStorage.getItem(`dashboard_widgets_${currentUser?.email}`)
      return stored ? JSON.parse(stored) : WIDGET_CATALOG.map(w => w.id)
    } catch { return WIDGET_CATALOG.map(w => w.id) }
  })

  const toggleWidget = (id) => {
    setWidgetPrefs(prev => {
      const next = prev.includes(id) ? prev.filter(w => w !== id) : [...prev, id]
      localStorage.setItem(widgetStorageKey, JSON.stringify(next))
      window.dispatchEvent(new Event('dashboard-widgets-changed'))
      return next
    })
  }

  const enableAllWidgets = () => {
    const all = WIDGET_CATALOG.map(w => w.id)
    setWidgetPrefs(all)
    localStorage.setItem(widgetStorageKey, JSON.stringify(all))
    window.dispatchEvent(new Event('dashboard-widgets-changed'))
  }

  const disableAllWidgets = () => {
    setWidgetPrefs([])
    localStorage.setItem(widgetStorageKey, JSON.stringify([]))
    window.dispatchEvent(new Event('dashboard-widgets-changed'))
  }

  // Profile
  const [displayName, setDisplayName] = useState(currentUser?.user_metadata?.display_name || '')
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.user_metadata?.avatar_url || null)
  const [avatarPreview, setAvatarPreview] = useState(null)
  const [avatarFile, setAvatarFile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const fileInputRef = useRef(null)

  // Security
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [passwordLoading, setPasswordLoading] = useState(false)

  // Email notification preferences (DB-backed)
  const [notifPrefs, setNotifPrefs] = useState(null)
  const [notifLoading, setNotifLoading] = useState(false)
  const [notifSaving, setNotifSaving] = useState(false)

  // System (in-app) notification preferences (localStorage-backed, auto-save)
  const sysPrefsKey = `notif_system_prefs_${currentUser?.email}`
  const [sysNotifPrefs, setSysNotifPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`notif_system_prefs_${currentUser?.email}`) || '{}') }
    catch { return {} }
  })

  const toggleSysNotif = (key) => {
    setSysNotifPrefs(prev => {
      const next = { ...prev, [key]: prev[key] === false ? true : false }
      localStorage.setItem(sysPrefsKey, JSON.stringify(next))
      window.dispatchEvent(new Event('notif-system-prefs-changed'))
      return next
    })
  }
  const setSysAll = (enabled) => {
    const next = {}
    SYSTEM_NOTIF_CATEGORIES.forEach(c => c.items.forEach(i => { next[i.key] = enabled }))
    setSysNotifPrefs(next)
    localStorage.setItem(sysPrefsKey, JSON.stringify(next))
    window.dispatchEvent(new Event('notif-system-prefs-changed'))
  }

  // Activity
  const [activity, setActivity] = useState([])
  const [activityLoading, setActivityLoading] = useState(false)

  useEffect(() => {
    if (activeTab === 'Notifications' && !notifPrefs) loadNotifPrefs()
    if (activeTab === 'Activity' && isAdmin && activity.length === 0) loadActivity()
  }, [activeTab, isAdmin, notifPrefs, activity.length])

  const loadNotifPrefs = async () => {
    setNotifLoading(true)
    try { setNotifPrefs(await notifications.getPreferences(currentUser.email)) }
    catch { toast.error('Failed to load preferences') }
    finally { setNotifLoading(false) }
  }

  const loadActivity = async () => {
    setActivityLoading(true)
    try { setActivity(await db.userActivity.list(currentUser.email)) }
    catch { toast.error('Failed to load activity') }
    finally { setActivityLoading(false) }
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
      toast.success('Profile updated!')
      db.auditLog.log(currentUser?.email, 'user_profile_updated', `Updated profile for ${currentUser?.email}`).catch(() => {})
    } catch (err) {
      toast.error(err.message || 'Failed to update profile')
    } finally {
      setProfileLoading(false)
    }
  }

  const handlePasswordSave = async () => {
    if (newPassword.length < 6) { toast.error('Password must be at least 6 characters'); return }
    if (newPassword !== confirmPassword) { toast.error('Passwords do not match'); return }
    setPasswordLoading(true)
    try {
      await auth.updatePassword(newPassword)
      setNewPassword('')
      setConfirmPassword('')
      toast.success('Password updated!')
      db.auditLog.log(currentUser?.email, 'user_password_changed', `Changed password for ${currentUser?.email}`).catch(() => {})
    } catch (err) {
      toast.error(err.message || 'Failed to update password')
    } finally {
      setPasswordLoading(false)
    }
  }

  const handleSignOutAll = async () => {
    try {
      await auth.signOutAll()
      toast.success('Signed out from all devices')
      db.auditLog.log(currentUser?.email, 'user_signed_out_all_devices', `Signed out all devices for ${currentUser?.email}`).catch(() => {})
    } catch { toast.error('Failed to sign out all devices') }
  }

  const handleNotifSave = async () => {
    setNotifSaving(true)
    try {
      await notifications.updatePreferences(currentUser.email, notifPrefs)
      toast.success('Preferences saved!')
      db.auditLog.log(currentUser?.email, 'user_notification_preferences_updated', `Updated notification preferences for ${currentUser?.email}`).catch(() => {})
    } catch { toast.error('Failed to save preferences') }
    finally { setNotifSaving(false) }
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
        title="Account Settings"
        subtitle="Manage your profile, security, and notification preferences"
        className="mb-8"
      />

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-8">
        <nav className="-mb-px flex gap-6">
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* ── PROFILE TAB ── */}
      {activeTab === 'Profile' && (
        <div className="space-y-6">
          {/* Avatar card */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-4">Profile Photo</h2>
            <div className="flex items-center gap-5">
              <div className="relative flex-shrink-0">
                {displayAvatar ? (
                  <img src={displayAvatar} alt="avatar" className="w-20 h-20 rounded-full object-cover ring-4 ring-indigo-50" />
                ) : (
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center text-white text-2xl font-bold ring-4 ring-indigo-50">
                    {initials}
                  </div>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute -bottom-1 -right-1 w-7 h-7 bg-white border-2 border-gray-200 rounded-full flex items-center justify-center hover:bg-indigo-50 hover:border-indigo-300 shadow-sm transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
              <div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                >
                  Upload photo
                </button>
                {avatarPreview && (
                  <button
                    onClick={() => { setAvatarPreview(null); setAvatarFile(null) }}
                    className="ml-3 px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                )}
                <p className="text-xs text-gray-400 mt-2">JPG, PNG or GIF · Max 2MB</p>
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
            </div>
          </div>

          {/* Info card */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Personal Information</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
                placeholder="Your name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Email Address</label>
              <input
                type="email"
                value={currentUser?.email || ''}
                disabled
                className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
              />
              <p className="text-xs text-gray-400 mt-1">Email cannot be changed here</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Role</label>
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border capitalize ${roleColors[currentUserRole] || roleColors.technician}`}>
                {currentUserRole}
              </span>
            </div>

            <div className="pt-1 border-t border-gray-100">
              <button
                onClick={handleProfileSave}
                disabled={profileLoading}
                className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {profileLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SECURITY TAB ── */}
      {activeTab === 'Security' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
            <div>
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Change Password</h2>
              <p className="text-sm text-gray-500 mt-1">Choose a strong password — at least 6 characters</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  className="w-full px-4 py-2.5 pr-10 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
                  placeholder="••••••••"
                />
                <button type="button" onClick={() => setShowNew(v => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <EyeIcon visible={showNew} />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm Password</label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  className="w-full px-4 py-2.5 pr-10 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition"
                  placeholder="••••••••"
                />
                <button type="button" onClick={() => setShowConfirm(v => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <EyeIcon visible={showConfirm} />
                </button>
              </div>
              {newPassword && confirmPassword && newPassword !== confirmPassword && (
                <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
              )}
            </div>

            <div className="pt-1 border-t border-gray-100">
              <button
                onClick={handlePasswordSave}
                disabled={passwordLoading || !newPassword || !confirmPassword}
                className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                {passwordLoading ? 'Updating...' : 'Update Password'}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Sessions</h2>
                <p className="text-sm text-gray-500 mt-1">Sign out from all other devices immediately</p>
              </div>
              <button
                onClick={handleSignOutAll}
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
              >
                Sign out all devices
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── NOTIFICATIONS TAB ── */}
      {activeTab === 'Notifications' && (
        <div className="space-y-6">

          {/* Email notifications (DB-backed) */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Email Notifications</h2>
              <p className="text-sm text-gray-500 mt-1">Choose which events send you an email</p>
            </div>

            {notifLoading ? (
              <div className="flex justify-center py-10">
                <Spinner size="md" />
              </div>
            ) : notifPrefs ? (
              <>
                <div className="divide-y divide-gray-100">
                  {NOTIF_ITEMS.map(({ key, label, desc }) => (
                    <div key={key} className="flex items-center justify-between py-3.5">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{label}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                      </div>
                      <Toggle
                        checked={!!notifPrefs[key]}
                        onChange={val => setNotifPrefs(p => ({ ...p, [key]: val }))}
                      />
                    </div>
                  ))}
                </div>
                <div className="pt-5 border-t border-gray-100 mt-2">
                  <button
                    onClick={handleNotifSave}
                    disabled={notifSaving}
                    className="px-6 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {notifSaving ? 'Saving...' : 'Save Preferences'}
                  </button>
                </div>
              </>
            ) : null}
          </div>

          {/* System (in-app) notifications — auto-saves to localStorage */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">System Notifications</h2>
                <p className="text-sm text-gray-500 mt-1">Control which in-app alerts appear in your notification bell</p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => setSysAll(false)} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50 transition-colors">
                  Hide all
                </button>
                <button onClick={() => setSysAll(true)} className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
                  Show all
                </button>
              </div>
            </div>

            <div className="space-y-6">
              {SYSTEM_NOTIF_CATEGORIES.map(({ cat, items }) => (
                <div key={cat}>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{cat}</p>
                  <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
                    {items.map(({ key, label, desc }) => (
                      <div key={key} className="flex items-center justify-between px-4 py-3 bg-white hover:bg-gray-50 transition-colors">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{label}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
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
            <p className="text-xs text-gray-400 mt-4">Changes are saved automatically</p>
          </div>

        </div>
      )}

      {/* ── APPEARANCE TAB ── */}
      {activeTab === 'Appearance' && (
        <div className="space-y-6">
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Dashboard Widgets</h2>
                <p className="text-sm text-gray-500 mt-1">Choose which widgets appear on your dashboard</p>
              </div>
              <div className="flex gap-2">
                <button onClick={disableAllWidgets} className="text-xs px-3 py-1.5 border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50 transition-colors">
                  Hide all
                </button>
                <button onClick={enableAllWidgets} className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
                  Show all
                </button>
              </div>
            </div>

            <div className="mt-5 space-y-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-gray-100 rounded-xl overflow-hidden border border-gray-100">
                {WIDGET_CATALOG.map(w => (
                  <div key={w.id} className="flex items-center justify-between p-4 bg-white hover:bg-gray-50 transition-colors">
                    <div className="min-w-0 flex-1 pr-4">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-800">{w.label}</p>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${w.size === 'full' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}>
                          {w.size === 'full' ? 'Full width' : 'Half width'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{w.desc}</p>
                    </div>
                    <Toggle
                      checked={widgetPrefs.includes(w.id)}
                      onChange={() => toggleWidget(w.id)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs text-gray-400 mt-4 text-center">
              {widgetPrefs.length} of {WIDGET_CATALOG.length} widgets enabled · Changes apply instantly
            </p>
          </div>
        </div>
      )}

      {/* ── ACTIVITY TAB (admin/super_admin only) ── */}
      {activeTab === 'Activity' && isAdmin && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Activity Log</h2>
            <p className="text-sm text-gray-500 mt-1">Your 50 most recent account actions</p>
          </div>

          {activityLoading ? (
            <div className="flex justify-center py-10">
              <Spinner size="md" />
            </div>
          ) : activity.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <p className="text-sm text-gray-400">No activity recorded yet</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {activity.map((item, i) => (
                <div key={i} className="flex items-start gap-3 py-3.5">
                  <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 capitalize">
                      {item.action_type?.replace(/_/g, ' ')}
                    </p>
                    {item.action_details && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {typeof item.action_details === 'string' ? item.action_details : JSON.stringify(item.action_details)}
                      </p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">
                    {new Date(item.created_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
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
