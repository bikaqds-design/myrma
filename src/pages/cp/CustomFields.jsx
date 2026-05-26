import React, { useState, useEffect } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { MigrationNotice } from './Announcements'

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'textarea', 'checkbox']
const APPLIES_TO = ['ticket', 'customer']
const EMPTY_FORM = { field_name: '', field_label: '', field_type: 'text', applies_to: 'ticket', is_required: false, is_active: true, field_options: [] }

const TYPE_ICONS = { text: '📝', number: '🔢', date: '📅', select: '📋', textarea: '🗒️', checkbox: '☑️' }

export default function CustomFields({ currentUserEmail }) {
  const [fields, setFields] = useState([])
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [newOption, setNewOption] = useState('')
  const [openMenuId, setOpenMenuId] = useState(null)
  const [filterAppliesTo, setFilterAppliesTo] = useState('')

  useEffect(() => { load() }, [])
  useEffect(() => {
    const handler = (e) => { if (!e.target.closest('.action-menu')) setOpenMenuId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const load = async () => {
    setLoading(true)
    const result = await db.customFields.list()
    setMissing(result.missing)
    setFields(result.data)
    setLoading(false)
  }

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setNewOption(''); setShowModal(true) }
  const openEdit = (f) => {
    setEditing(f)
    setForm({ field_name: f.field_name, field_label: f.field_label, field_type: f.field_type, applies_to: f.applies_to, is_required: f.is_required, is_active: f.is_active, field_options: f.field_options || [] })
    setNewOption(''); setShowModal(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.field_label.trim()) { toast.error('Label is required'); return }
    if (!form.field_name.trim()) { toast.error('Field name is required'); return }
    if (!/^[a-z_][a-z0-9_]*$/.test(form.field_name)) { toast.error('Field name: lowercase letters, numbers, underscores only'); return }
    if (form.field_type === 'select' && form.field_options.length === 0) { toast.error('Add at least one option for select fields'); return }
    setSaving(true)
    try {
      const payload = { ...form, field_options: form.field_type === 'select' ? form.field_options : null }
      if (editing) {
        await db.customFields.update(editing.id, payload)
        toast.success('Field updated')
      } else {
        await db.customFields.create({ ...payload, created_by: currentUserEmail, created_date: new Date().toISOString() })
        toast.success('Custom field created')
      }
      setShowModal(false); load()
    } catch (err) { toast.error(err.message) } finally { setSaving(false) }
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this custom field? Data stored in this field will not be deleted from existing records.')) return
    try { await db.customFields.delete(id); toast.success('Deleted'); load() }
    catch (err) { toast.error(err.message) }
  }

  const handleToggle = async (f) => {
    try { await db.customFields.update(f.id, { is_active: !f.is_active }); load() }
    catch (err) { toast.error(err.message) }
  }

  const addOption = () => {
    if (!newOption.trim()) return
    setForm(f => ({ ...f, field_options: [...f.field_options, newOption.trim()] }))
    setNewOption('')
  }
  const removeOption = (i) => setForm(f => ({ ...f, field_options: f.field_options.filter((_, idx) => idx !== i) }))

  const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'
  const displayed = filterAppliesTo ? fields.filter(f => f.applies_to === filterAppliesTo) : fields

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" /></div>
  if (missing) return <MigrationNotice feature="Custom Fields" sql={CUSTOM_FIELDS_SQL} />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Custom Fields</h2>
          <p className="text-sm text-gray-500 mt-0.5">Add extra fields to tickets and customers</p>
        </div>
        <button onClick={openCreate} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
          Add Field
        </button>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-600">Filter:</span>
        {['', 'ticket', 'customer'].map(v => (
          <button key={v} onClick={() => setFilterAppliesTo(v)}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${filterAppliesTo === v ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {v === '' ? 'All' : v === 'ticket' ? '🎫 Tickets' : '👤 Customers'}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Field Label', 'Name (key)', 'Type', 'Applies To', 'Required', 'Active', 'Actions'].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {displayed.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-500">No custom fields defined yet</td></tr>
            )}
            {displayed.map(f => (
              <tr key={f.id} className={`hover:bg-gray-50 ${!f.is_active ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3 font-medium text-sm text-gray-900">{f.field_label}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{f.field_name}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{TYPE_ICONS[f.field_type]} {f.field_type}</td>
                <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${f.applies_to === 'ticket' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'}`}>{f.applies_to}</span></td>
                <td className="px-4 py-3 text-sm text-gray-600">{f.is_required ? '✓ Yes' : 'No'}</td>
                <td className="px-4 py-3">
                  <button onClick={() => handleToggle(f)} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${f.is_active ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${f.is_active ? 'translate-x-4' : 'translate-x-1'}`} />
                  </button>
                </td>
                <td className="px-4 py-3 relative action-menu">
                  <button onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === f.id ? null : f.id) }}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                  </button>
                  {openMenuId === f.id && (
                    <div className="absolute right-0 top-9 z-30 w-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                      <button onClick={() => { openEdit(f); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                        <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                        Edit
                      </button>
                      <button onClick={() => { handleDelete(f.id); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-bold text-gray-900">{editing ? 'Edit Field' : 'New Custom Field'}</h3>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Label <span className="text-red-500">*</span></label>
                <input value={form.field_label} onChange={e => setForm({...form, field_label: e.target.value, field_name: editing ? form.field_name : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')})}
                  className={inp} placeholder="e.g. Customer PO Number" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Field key <span className="text-red-500">*</span> <span className="text-xs text-gray-500">(lowercase, no spaces)</span></label>
                <input value={form.field_name} onChange={e => setForm({...form, field_name: e.target.value})} className={`${inp} font-mono`} placeholder="e.g. customer_po_number" disabled={!!editing} required />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Type</label>
                  <select value={form.field_type} onChange={e => setForm({...form, field_type: e.target.value})} className={inp}>
                    {FIELD_TYPES.map(t => <option key={t} value={t}>{TYPE_ICONS[t]} {t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Applies to</label>
                  <select value={form.applies_to} onChange={e => setForm({...form, applies_to: e.target.value})} className={inp}>
                    {APPLIES_TO.map(t => <option key={t} value={t}>{t === 'ticket' ? '🎫 Ticket' : '👤 Customer'}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.is_required} onChange={e => setForm({...form, is_required: e.target.checked})} className="w-4 h-4 text-indigo-600 rounded" />
                  <span className="text-sm font-medium text-gray-700">Required field</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.is_active} onChange={e => setForm({...form, is_active: e.target.checked})} className="w-4 h-4 text-indigo-600 rounded" />
                  <span className="text-sm font-medium text-gray-700">Active</span>
                </label>
              </div>
              {form.field_type === 'select' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Options</label>
                  <div className="flex gap-2 mb-2">
                    <input value={newOption} onChange={e => setNewOption(e.target.value)} onKeyPress={e => e.key === 'Enter' && (e.preventDefault(), addOption())}
                      className={`${inp} flex-1`} placeholder="Add option..." />
                    <button type="button" onClick={addOption} className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm">Add</button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {form.field_options.map((o, i) => (
                      <span key={i} className="flex items-center gap-1 px-2 py-1 bg-gray-100 rounded text-sm">
                        {o}
                        <button type="button" onClick={() => removeOption(i)} className="text-gray-500 hover:text-red-500 ml-1">×</button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                  {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Field'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

const CUSTOM_FIELDS_SQL = `CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_name TEXT NOT NULL,
  field_label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text','number','date','select','textarea','checkbox')),
  applies_to TEXT NOT NULL CHECK (applies_to IN ('ticket','customer')),
  is_required BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  field_options JSONB,
  sort_order INTEGER DEFAULT 0,
  created_by TEXT,
  created_date TIMESTAMPTZ DEFAULT NOW()
);`
