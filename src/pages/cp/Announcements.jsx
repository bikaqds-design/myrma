import React, { useState, useEffect } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'

const EMPTY_FORM = { title: '', message: '', type: 'info', is_active: true, starts_at: '', ends_at: '' }

const TYPE_STYLES = {
  info:    { badge: 'bg-blue-100 text-blue-800',   bar: 'bg-blue-50 border-blue-200 text-blue-900',   icon: 'ℹ️' },
  warning: { badge: 'bg-yellow-100 text-yellow-800', bar: 'bg-yellow-50 border-yellow-200 text-yellow-900', icon: '⚠️' },
  success: { badge: 'bg-green-100 text-green-800',  bar: 'bg-green-50 border-green-200 text-green-900',  icon: '✅' },
  error:   { badge: 'bg-red-100 text-red-800',     bar: 'bg-red-50 border-red-200 text-red-900',     icon: '🚨' },
}

export default function Announcements({ currentUserEmail }) {
  const [announcements, setAnnouncements] = useState([])
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)

  useEffect(() => { load() }, [])
  useEffect(() => {
    const handler = (e) => { if (!e.target.closest('.action-menu')) setOpenMenuId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const load = async () => {
    setLoading(true)
    const result = await db.announcements.list()
    setMissing(result.missing)
    setAnnouncements(result.data)
    setLoading(false)
  }

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setShowModal(true) }
  const openEdit = (a) => { setEditing(a); setForm({ title: a.title, message: a.message, type: a.type, is_active: a.is_active, starts_at: a.starts_at?.slice(0,16) || '', ends_at: a.ends_at?.slice(0,16) || '' }); setShowModal(true) }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.message.trim()) { toast.error('Title and message are required'); return }
    setSaving(true)
    try {
      const payload = { ...form, starts_at: form.starts_at || null, ends_at: form.ends_at || null, updated_date: new Date().toISOString() }
      if (editing) {
        await db.announcements.update(editing.id, payload)
        toast.success('Announcement updated')
      } else {
        await db.announcements.create({ ...payload, created_by: currentUserEmail, created_date: new Date().toISOString() })
        toast.success('Announcement created')
      }
      setShowModal(false)
      load()
    } catch (err) { toast.error(err.message) } finally { setSaving(false) }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this announcement?')) return
    try { await db.announcements.delete(id); toast.success('Deleted'); load() }
    catch (err) { toast.error(err.message) }
  }

  const handleToggle = async (a) => {
    try { await db.announcements.update(a.id, { is_active: !a.is_active }); load() }
    catch (err) { toast.error(err.message) }
  }

  const fmt = (d) => d ? new Date(d).toLocaleString() : '—'
  const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent'

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" /></div>

  if (missing) return <MigrationNotice feature="Announcements" sql={ANNOUNCEMENTS_SQL} />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Announcements</h2>
          <p className="text-sm text-gray-500 mt-0.5">Post banners visible to all logged-in users</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
          New Announcement
        </button>
      </div>

      {/* Live preview of active announcements */}
      {announcements.filter(a => a.is_active).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Live Preview</p>
          {announcements.filter(a => a.is_active).map(a => {
            const s = TYPE_STYLES[a.type] || TYPE_STYLES.info
            return (
              <div key={a.id} className={`flex items-start gap-3 px-4 py-3 border rounded-lg text-sm ${s.bar}`}>
                <span className="text-base leading-none mt-0.5">{s.icon}</span>
                <div><span className="font-semibold">{a.title}:</span> {a.message}</div>
              </div>
            )
          })}
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Title', 'Type', 'Active', 'Starts', 'Ends', 'Actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {announcements.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No announcements yet</td></tr>
            )}
            {announcements.map(a => {
              const s = TYPE_STYLES[a.type] || TYPE_STYLES.info
              return (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-sm text-gray-900">{a.title}</div>
                    <div className="text-xs text-gray-500 truncate max-w-xs">{a.message}</div>
                  </td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${s.badge}`}>{s.icon} {a.type}</span></td>
                  <td className="px-4 py-3">
                    <button onClick={() => handleToggle(a)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${a.is_active ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${a.is_active ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmt(a.starts_at)}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmt(a.ends_at)}</td>
                  <td className="px-4 py-3 relative action-menu">
                    <button onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === a.id ? null : a.id) }}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                    </button>
                    {openMenuId === a.id && (
                      <div className="absolute right-0 top-9 z-30 w-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                        <button onClick={() => { openEdit(a); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                          Edit
                        </button>
                        <button onClick={() => { handleDelete(a.id); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-bold text-gray-900">{editing ? 'Edit Announcement' : 'New Announcement'}</h3>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Title <span className="text-red-500">*</span></label>
                <input value={form.title} onChange={e => setForm({...form, title: e.target.value})} className={inp} placeholder="e.g. Scheduled Maintenance" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Message <span className="text-red-500">*</span></label>
                <textarea value={form.message} onChange={e => setForm({...form, message: e.target.value})} className={inp} rows={3} placeholder="Message visible to all users..." required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Type</label>
                  <select value={form.type} onChange={e => setForm({...form, type: e.target.value})} className={inp}>
                    <option value="info">ℹ️ Info</option>
                    <option value="warning">⚠️ Warning</option>
                    <option value="success">✅ Success</option>
                    <option value="error">🚨 Alert</option>
                  </select>
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.is_active} onChange={e => setForm({...form, is_active: e.target.checked})} className="w-4 h-4 text-indigo-600 rounded" />
                    <span className="text-sm font-medium text-gray-700">Active now</span>
                  </label>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Start date <span className="text-xs text-gray-400">(optional)</span></label>
                  <input type="datetime-local" value={form.starts_at} onChange={e => setForm({...form, starts_at: e.target.value})} className={inp} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">End date <span className="text-xs text-gray-400">(optional)</span></label>
                  <input type="datetime-local" value={form.ends_at} onChange={e => setForm({...form, ends_at: e.target.value})} className={inp} />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                  {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export function MigrationNotice({ feature, sql }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-2xl">⚙️</span>
        <div>
          <h3 className="font-semibold text-amber-900">{feature} — Database setup required</h3>
          <p className="text-sm text-amber-700 mt-1">Run the following SQL in your <strong>Supabase SQL Editor</strong> to enable this feature.</p>
        </div>
      </div>
      <div className="relative">
        <pre className="bg-gray-900 text-green-400 text-xs rounded-lg p-4 overflow-x-auto whitespace-pre-wrap">{sql}</pre>
        <button onClick={copy} className="absolute top-2 right-2 px-2 py-1 bg-gray-700 text-gray-300 text-xs rounded hover:bg-gray-600">
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

const ANNOUNCEMENTS_SQL = `CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info' CHECK (type IN ('info','warning','success','error')),
  is_active BOOLEAN DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by TEXT,
  created_date TIMESTAMPTZ DEFAULT NOW(),
  updated_date TIMESTAMPTZ DEFAULT NOW()
);`
