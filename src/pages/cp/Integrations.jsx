import React, { useState, useEffect } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { MigrationNotice } from './Announcements'
import { captureException } from '../../lib/sentry'

const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.status_changed',
  'ticket.deleted',
  'customer.created',
  'customer.updated',
]

const EMPTY_FORM = { name: '', url: '', events: [], is_active: true, secret_key: '' }

export default function Integrations({ currentUserEmail }) {
  const [webhooks, setWebhooks] = useState([])
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(null)
  const [openMenuId, setOpenMenuId] = useState(null)

  useEffect(() => {
    load()
  }, [])
  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const load = async () => {
    setLoading(true)
    const result = await db.webhooks.list()
    setMissing(result.missing)
    setWebhooks(result.data)
    setLoading(false)
  }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }
  const openEdit = (w) => {
    setEditing(w)
    setForm({
      name: w.name,
      url: w.url,
      events: w.events || [],
      is_active: w.is_active,
      secret_key: w.secret_key || '',
    })
    setShowModal(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      toast.error('Name is required')
      return
    }
    if (!form.url.trim() || !form.url.startsWith('http')) {
      toast.error('Valid URL is required')
      return
    }
    if (form.events.length === 0) {
      toast.error('Select at least one event')
      return
    }
    setSaving(true)
    try {
      const payload = { ...form, updated_date: new Date().toISOString() }
      if (editing) {
        await db.webhooks.update(editing.id, payload)
        toast.success('Webhook updated')
      } else {
        await db.webhooks.create({
          ...payload,
          created_by: currentUserEmail,
          created_date: new Date().toISOString(),
        })
        toast.success('Webhook created')
      }
      setShowModal(false)
      load()
    } catch (err) {
      captureException(err)
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this webhook?')) return
    try {
      await db.webhooks.delete(id)
      toast.success('Deleted')
      load()
    } catch (err) {
      captureException(err)
      toast.error(err.message)
    }
  }

  const handleToggle = async (w) => {
    try {
      await db.webhooks.update(w.id, { is_active: !w.is_active })
      load()
    } catch (err) {
      captureException(err)
      toast.error(err.message)
    }
  }

  const handleTest = async (w) => {
    setTesting(w.id)
    try {
      const payload = {
        event: 'webhook.test',
        timestamp: new Date().toISOString(),
        data: { message: 'Test webhook from myRMA Control Panel' },
      }
      await fetch(w.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(w.secret_key ? { 'X-Webhook-Secret': w.secret_key } : {}),
        },
        body: JSON.stringify(payload),
      })
      toast.success('Test payload sent')
    } catch {
      toast.error('Failed to reach webhook URL — check CORS or the URL')
    } finally {
      setTesting(null)
    }
  }

  const toggleEvent = (ev) =>
    setForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((e) => e !== ev) : [...f.events, ev],
    }))
  const inp =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )
  if (missing) return <MigrationNotice feature="Integrations / Webhooks" sql={WEBHOOKS_SQL} />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Integrations</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure outbound webhooks for ticket and customer events
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Add Webhook
        </button>
      </div>

      {/* Info box */}
      <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
        <svg
          className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5"
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
        <div>
          Webhooks send a POST request with a JSON payload to your URL when events occur. Use them
          to connect Slack, Teams, Zapier, or custom systems. The optional secret key is sent as{' '}
          <code className="bg-blue-100 px-1 rounded">X-Webhook-Secret</code> header.
        </div>
      </div>

      {/* Webhooks table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Name', 'URL', 'Events', 'Active', 'Actions'].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {webhooks.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-500">
                  No webhooks configured yet
                </td>
              </tr>
            )}
            {webhooks.map((w) => (
              <tr key={w.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-sm text-gray-900">{w.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate font-mono text-xs">
                  {w.url}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(w.events || []).map((ev) => (
                      <span
                        key={ev}
                        className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded font-mono"
                      >
                        {ev}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleToggle(w)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${w.is_active ? 'bg-indigo-600' : 'bg-gray-300'}`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${w.is_active ? 'translate-x-4' : 'translate-x-1'}`}
                    />
                  </button>
                </td>
                <td className="px-4 py-3 relative action-menu">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuId(openMenuId === w.id ? null : w.id)
                    }}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>
                  {openMenuId === w.id && (
                    <div className="absolute right-0 top-9 z-30 w-44 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                      <button
                        onClick={() => {
                          handleTest(w)
                          setOpenMenuId(null)
                        }}
                        disabled={testing === w.id || !w.is_active}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5 disabled:opacity-40"
                      >
                        <svg
                          className="w-4 h-4 text-green-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                        {testing === w.id ? 'Sending...' : 'Test Webhook'}
                      </button>
                      <button
                        onClick={() => {
                          openEdit(w)
                          setOpenMenuId(null)
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                      >
                        <svg
                          className="w-4 h-4 text-gray-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          handleDelete(w.id)
                          setOpenMenuId(null)
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                        Delete
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-bold text-gray-900">
                {editing ? 'Edit Webhook' : 'Add Webhook'}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-500 hover:text-gray-600"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={inp}
                  placeholder="e.g. Slack Notifications"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Endpoint URL <span className="text-red-500">*</span>
                </label>
                <input
                  type="url"
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  className={inp}
                  placeholder="https://hooks.example.com/..."
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Secret Key <span className="text-xs text-gray-500">(optional)</span>
                </label>
                <input
                  value={form.secret_key}
                  onChange={(e) => setForm({ ...form, secret_key: e.target.value })}
                  className={inp}
                  placeholder="Sent as X-Webhook-Secret header"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Events <span className="text-red-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {WEBHOOK_EVENTS.map((ev) => (
                    <label key={ev} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.events.includes(ev)}
                        onChange={() => toggleEvent(ev)}
                        className="w-4 h-4 text-indigo-600 rounded"
                      />
                      <span className="text-sm font-mono text-gray-700">{ev}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="w-4 h-4 text-indigo-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700">Active</span>
              </label>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Webhook'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

const WEBHOOKS_SQL = `CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  secret_key TEXT,
  last_triggered_at TIMESTAMPTZ,
  created_by TEXT,
  created_date TIMESTAMPTZ DEFAULT NOW(),
  updated_date TIMESTAMPTZ DEFAULT NOW()
);`
