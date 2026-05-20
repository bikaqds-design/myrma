import React, { useState, useEffect } from 'react'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Spinner } from '../components/ui'
import UserManagement from './UserManagement'
import BrandingSettings from './BrandingSettings'
import BackupRestore from './BackupRestore'
import Announcements from './cp/Announcements'
import AuditLog from './cp/AuditLog'
import RMAConfig from './cp/RMAConfig'
import DataCleanup from './cp/DataCleanup'
import Integrations from './cp/Integrations'
import CustomFields from './cp/CustomFields'
import PDFLayout from './cp/PDFLayout'

// ─── Feature registry ──────────────────────────────────────────────────────

const GROUPS = [
  {
    id: 'tickets',
    label: 'Ticket Management',
    color: 'indigo',
    features: [
      { id: 'rmaconfig', label: 'RMA Configuration', desc: 'SLA rules, auto-assignment and ticket defaults', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
      { id: 'customfields', label: 'Custom Fields', desc: 'Add extra fields to tickets and customers', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" /></svg> },
      { id: 'pdflayout', label: 'PDF Layout', desc: 'Customize the ticket print and export template', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg> },
    ]
  },
  {
    id: 'users',
    label: 'Users & Communication',
    color: 'emerald',
    features: [
      { id: 'users', label: 'User Management', desc: 'Manage accounts, roles and permissions', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" /></svg> },
      { id: 'announcements', label: 'Announcements', desc: 'Post system-wide banners visible to all users', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg> },
      { id: 'broadcast', label: 'Send Alert', desc: 'Send instant in-app notifications to users or groups', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg> },
    ]
  },
  {
    id: 'appearance',
    label: 'Appearance & Notifications',
    color: 'purple',
    features: [
      { id: 'appearance', label: 'Appearance', desc: 'Logo, colors, dark mode, fonts, sidebar style', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" /></svg> },
      { id: 'email', label: 'Email & Notifications', desc: 'Email provider, templates and preferences', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg> },
    ]
  },
  {
    id: 'data',
    label: 'Data & System',
    color: 'amber',
    features: [
      { id: 'audit', label: 'Audit Log', desc: 'Full trail of all user activity across the system', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg> },
      { id: 'cleanup', label: 'Data Cleanup', desc: 'Remove stale records and identify data quality issues', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg> },
      { id: 'backup', label: 'Backup & Restore', desc: 'Export all data and restore from backup files', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg> },
      { id: 'integrations', label: 'Integrations', desc: 'Configure outbound webhooks and external connections', icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg> },
    ]
  },
]

const ALL_FEATURES = GROUPS.flatMap(g => g.features)
const COLOR_MAP = {
  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-100', icon: 'bg-indigo-100 text-indigo-600', label: 'text-indigo-900', hover: 'hover:border-indigo-300 hover:bg-indigo-50/80' },
  emerald: { bg: 'bg-emerald-50', border: 'border-emerald-100', icon: 'bg-emerald-100 text-emerald-600', label: 'text-emerald-900', hover: 'hover:border-emerald-300 hover:bg-emerald-50/80' },
  purple: { bg: 'bg-purple-50', border: 'border-purple-100', icon: 'bg-purple-100 text-purple-600', label: 'text-purple-900', hover: 'hover:border-purple-300 hover:bg-purple-50/80' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-100', icon: 'bg-amber-100 text-amber-600', label: 'text-amber-900', hover: 'hover:border-amber-300 hover:bg-amber-50/80' },
}

export default function ControlPanel({ currentUserRole, currentUserEmail }) {
  const [section, setSection] = useState(null)

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <h2 className="text-xl font-semibold text-gray-700">Access Restricted</h2>
          <p className="text-gray-500 mt-1">This area is for administrators only.</p>
        </div>
      </div>
    )
  }

  const activeFeature = section ? ALL_FEATURES.find(f => f.id === section) : null

  return (
    <div className="space-y-6">
      {/* Header */}
      {section ? (
        <div className="flex items-center gap-3">
          <button onClick={() => setSection(null)}
            className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            Control Panel
          </button>
          <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          <span className="text-sm font-semibold text-gray-900">{activeFeature?.label}</span>
        </div>
      ) : (
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Control Panel</h1>
          <p className="text-sm text-gray-500 mt-0.5">System administration and configuration</p>
        </div>
      )}

      {/* Home view */}
      {!section && <HomeView onNavigate={setSection} currentUserEmail={currentUserEmail} />}

      {/* Feature content */}
      {section === 'users'       && <UserManagement currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} />}
      {section === 'appearance'  && <BrandingSettings key="appearance" currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} initialTab="branding" visibleTabs={['branding']} />}
      {section === 'email'       && <BrandingSettings key="email" currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} initialTab="email-settings" visibleTabs={['email-settings', 'notifications', 'templates']} />}
      {section === 'backup'      && <BackupRestore currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} />}
      {section === 'announcements' && <Announcements currentUserEmail={currentUserEmail} />}
      {section === 'broadcast'     && <SendAlert currentUserEmail={currentUserEmail} />}
      {section === 'audit'       && <AuditLog />}
      {section === 'rmaconfig'   && <RMAConfig currentUserEmail={currentUserEmail} />}
      {section === 'cleanup'     && <DataCleanup />}
      {section === 'integrations' && <Integrations currentUserEmail={currentUserEmail} />}
      {section === 'customfields' && <CustomFields currentUserEmail={currentUserEmail} />}
      {section === 'pdflayout'   && <PDFLayout currentUserEmail={currentUserEmail} />}
    </div>
  )
}

// ─── SEND ALERT ─────────────────────────────────────────────────────────────

const ALERT_TYPES = [
  { value: 'system_announcement', label: 'Announcement', icon: '📢', desc: 'General system message' },
  { value: 'custom_alert',        label: 'Warning',       icon: '⚠️', desc: 'Important action required' },
]

const ALERT_TARGETS = [
  { value: 'all',          label: 'Everyone',        icon: '👥', roles: ['super_admin', 'admin', 'technician'] },
  { value: 'admins',       label: 'Admins only',     icon: '🔑', roles: ['super_admin', 'admin'] },
  { value: 'technicians',  label: 'Technicians',     icon: '🔧', roles: ['technician'] },
  { value: 'email',        label: 'Specific email',  icon: '✉️', roles: [] },
]

function SendAlert({ currentUserEmail }) {
  const [type, setType]               = useState('system_announcement')
  const [title, setTitle]             = useState('')
  const [message, setMessage]         = useState('')
  const [target, setTarget]           = useState('all')
  const [specificEmail, setSpecificEmail] = useState('')
  const [sending, setSending]         = useState(false)
  const [sent, setSent]               = useState(false)

  const handleSend = async () => {
    if (!title.trim() || !message.trim()) { toast.error('Title and message are required'); return }
    if (target === 'email' && !specificEmail.trim()) { toast.error('Enter a recipient email address'); return }
    setSending(true)
    try {
      const targetConfig = ALERT_TARGETS.find(t => t.value === target)
      await db.notifications.create({
        type,
        title: title.trim(),
        message: message.trim(),
        createdBy: currentUserEmail,
        targetRoles: targetConfig.roles,
        targetEmails: target === 'email' ? [specificEmail.trim()] : [],
      })
      toast.success('Alert sent')
      db.auditLog.log(currentUserEmail, 'alert_sent', `Sent alert "${title.trim()}" to ${target}`).catch(() => {})
      setSent(true)
      setTitle(''); setMessage(''); setSpecificEmail('')
      setTimeout(() => setSent(false), 3000)
    } catch (err) {
      toast.error(`Failed to send: ${err.message}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">

        {/* Type */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Alert Type</p>
          <div className="grid grid-cols-2 gap-3">
            {ALERT_TYPES.map(t => (
              <button key={t.value} onClick={() => setType(t.value)}
                className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-colors ${type === t.value ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300 bg-white'}`}>
                <span className="text-2xl">{t.icon}</span>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{t.label}</p>
                  <p className="text-xs text-gray-500">{t.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            value={title} onChange={e => setTitle(e.target.value)} maxLength={100}
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            placeholder="e.g. System maintenance tonight at 11pm"
          />
        </div>

        {/* Message */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Message <span className="text-red-500">*</span>
          </label>
          <textarea
            value={message} onChange={e => setMessage(e.target.value)} rows={4} maxLength={500}
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent resize-none"
            placeholder="Describe the alert in detail..."
          />
          <p className="text-xs text-gray-400 text-right mt-1">{message.length}/500</p>
        </div>

        {/* Target */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Send To</p>
          <div className="grid grid-cols-2 gap-2">
            {ALERT_TARGETS.map(t => (
              <button key={t.value} onClick={() => setTarget(t.value)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${target === t.value ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300 bg-white'}`}>
                <span>{t.icon}</span>{t.label}
              </button>
            ))}
          </div>
          {target === 'email' && (
            <input
              value={specificEmail} onChange={e => setSpecificEmail(e.target.value)} type="email"
              className="w-full mt-3 px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              placeholder="recipient@example.com"
            />
          )}
        </div>

        {/* Send */}
        <div className="pt-2 border-t border-gray-100">
          <button
            onClick={handleSend}
            disabled={sending || !title.trim() || !message.trim()}
            className={`px-6 py-2.5 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-all flex items-center gap-2 ${sent ? 'bg-green-600 hover:bg-green-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
          >
            {sending ? (
              <><Spinner size="sm" color="white" />Sending...</>
            ) : sent ? (
              <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Alert Sent!</>
            ) : (
              <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>Send Alert</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── HOME VIEW ─────────────────────────────────────────────────────────────

function HomeView({ onNavigate, currentUserEmail }) {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    Promise.all([db.rmaTickets.list(), db.customers.list(), db.products.list(), db.userRoles.listAllRoles()])
      .then(([tickets, customers, products, users]) => {
        const byStatus = tickets.reduce((a, t) => { a[t.ticket_status] = (a[t.ticket_status] || 0) + 1; return a }, {})
        const open = (byStatus['New'] || 0) + (byStatus['In Progress'] || 0) + (byStatus['On Hold'] || 0)
        const overdue = tickets.filter(t => t.due_date && new Date(t.due_date) < new Date() && t.ticket_status !== 'Completed' && t.ticket_status !== 'Cancelled').length
        setStats({ total: tickets.length, open, overdue, completed: byStatus['Completed'] || 0, customers: customers.length, products: products.length, users: users.length, byStatus })
      }).catch(() => {})
  }, [])

  const statCards = stats ? [
    { label: 'Total Tickets', value: stats.total, sub: `${stats.open} open`, color: 'indigo' },
    { label: 'Overdue', value: stats.overdue, sub: 'past due date', color: stats.overdue > 0 ? 'red' : 'green' },
    { label: 'Customers', value: stats.customers, sub: 'in database', color: 'emerald' },
    { label: 'System Users', value: stats.users, sub: 'with access', color: 'purple' },
  ] : []

  const colorStat = { indigo: 'bg-indigo-50 text-indigo-600', red: 'bg-red-50 text-red-600', green: 'bg-green-50 text-green-600', emerald: 'bg-emerald-50 text-emerald-600', purple: 'bg-purple-50 text-purple-600' }

  return (
    <div className="space-y-8">
      {/* Quick stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {statCards.map(c => (
            <div key={c.label} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
              <div className={`text-2xl font-bold ${colorStat[c.color].split(' ')[1]}`}>{c.value}</div>
              <div className="text-sm font-medium text-gray-700 mt-0.5">{c.label}</div>
              <div className="text-xs text-gray-400">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Ticket status row */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          {[
            { label: 'New', color: 'bg-pink-100 text-pink-800' },
            { label: 'In Progress', color: 'bg-blue-100 text-blue-800' },
            { label: 'On Hold', color: 'bg-yellow-100 text-yellow-800' },
            { label: 'Completed', color: 'bg-green-100 text-green-800' },
            { label: 'Cancelled', color: 'bg-gray-100 text-gray-700' },
          ].map(({ label, color }) => (
            <div key={label} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${color}`}>
              <span className="font-medium">{label}</span>
              <span className="font-bold">{stats.byStatus[label] || 0}</span>
            </div>
          ))}
        </div>
      )}

      {/* Feature groups */}
      {GROUPS.map(group => {
        const c = COLOR_MAP[group.color]
        return (
          <div key={group.id}>
            <h2 className="text-base font-semibold text-gray-900 mb-3">{group.label}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {group.features.map(f => (
                <button key={f.id} onClick={() => onNavigate(f.id)}
                  className={`group bg-white border border-gray-200 rounded-xl p-4 text-left transition-all hover:shadow-md ${c.hover}`}>
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${c.icon}`}>
                    {f.icon}
                  </div>
                  <div className="font-semibold text-gray-900 text-sm group-hover:text-indigo-700">{f.label}</div>
                  <div className="text-xs text-gray-500 mt-1 leading-relaxed">{f.desc}</div>
                  <div className="mt-3 flex items-center gap-1 text-xs font-medium text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity">
                    Open
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
