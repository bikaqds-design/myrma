import React, { useState, useEffect } from 'react'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { MigrationNotice } from './Announcements'

const DEFAULT_SLA = { Low: { response: 72, resolution: 168 }, Medium: { response: 24, resolution: 72 }, High: { response: 4, resolution: 24 }, Critical: { response: 1, resolution: 4 } }
const DEFAULT_RULES = []
const DEFAULT_SETTINGS = { default_priority: 'Medium', default_status: 'New', auto_due_days: 7 }
const PRIORITY_COLORS = { Low: 'bg-gray-100 text-gray-700', Medium: 'bg-blue-100 text-blue-700', High: 'bg-orange-100 text-orange-700', Critical: 'bg-red-100 text-red-700' }

export default function RMAConfig({ currentUserEmail }) {
  const [loading, setLoading] = useState(true)
  const [missing, setMissing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sla, setSla] = useState(DEFAULT_SLA)
  const [rules, setRules] = useState(DEFAULT_RULES)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [users, setUsers] = useState([])

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    try {
      const [cfgResult, usersData] = await Promise.all([db.rmaConfig.getAll(), db.userRoles.listAllRoles()])
      if (cfgResult.missing) { setMissing(true); setLoading(false); return }
      setUsers(usersData)
      const byKey = Object.fromEntries(cfgResult.data.map(r => [r.config_key, r.config_value]))
      if (byKey.sla_rules) setSla(byKey.sla_rules)
      if (byKey.auto_assignment_rules) setRules(byKey.auto_assignment_rules)
      if (byKey.default_settings) setSettings(byKey.default_settings)
    } catch { toast.error('Failed to load config') }
    finally { setLoading(false) }
  }

  const save = async () => {
    setSaving(true)
    try {
      await Promise.all([
        db.rmaConfig.set('sla_rules', sla, currentUserEmail),
        db.rmaConfig.set('auto_assignment_rules', rules, currentUserEmail),
        db.rmaConfig.set('default_settings', settings, currentUserEmail),
      ])
      toast.success('Configuration saved')
      db.auditLog.log(currentUserEmail, 'rma_config_updated', 'Updated RMA configuration (SLA rules, assignment rules, default settings)').catch(() => {})
    } catch (err) { toast.error(err.message) } finally { setSaving(false) }
  }

  const addRule = () => setRules([...rules, { condition_field: 'priority', condition_value: 'Critical', assign_to: '' }])
  const removeRule = (i) => setRules(rules.filter((_, idx) => idx !== i))
  const updateRule = (i, key, val) => setRules(rules.map((r, idx) => idx === i ? { ...r, [key]: val } : r))

  const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'
  const sel = 'px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" /></div>
  if (missing) return <MigrationNotice feature="RMA Configuration" sql={RMA_CONFIG_SQL} />

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">RMA Configuration</h2>
          <p className="text-sm text-gray-500 mt-0.5">SLA rules, auto-assignment, and ticket defaults</p>
        </div>
        <button onClick={save} disabled={saving} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving...' : 'Save All Changes'}
        </button>
      </div>

      {/* Default Settings */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Default Ticket Settings</h3>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Default Priority</label>
            <select value={settings.default_priority} onChange={e => setSettings({...settings, default_priority: e.target.value})} className={sel}>
              {['Low','Medium','High','Critical'].map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Default Status</label>
            <select value={settings.default_status} onChange={e => setSettings({...settings, default_status: e.target.value})} className={sel}>
              {['New','In Progress','On Hold','Completed','Cancelled'].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Auto Due Date (days)</label>
            <input type="number" min={1} max={365} value={settings.auto_due_days}
              onChange={e => setSettings({...settings, auto_due_days: parseInt(e.target.value) || 7})} className={inp} />
          </div>
        </div>
      </div>

      {/* SLA Rules */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h3 className="text-base font-semibold text-gray-900 mb-1">SLA Rules by Priority</h3>
        <p className="text-sm text-gray-500 mb-4">Define response and resolution time targets in hours.</p>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                {['Priority', 'Response Target (hrs)', 'Resolution Target (hrs)'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {Object.keys(sla).map(priority => (
                <tr key={priority} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${PRIORITY_COLORS[priority]}`}>{priority}</span>
                  </td>
                  <td className="px-4 py-3">
                    <input type="number" min={1} value={sla[priority].response}
                      onChange={e => setSla({...sla, [priority]: {...sla[priority], response: parseInt(e.target.value) || 1}})}
                      className="w-28 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600" />
                  </td>
                  <td className="px-4 py-3">
                    <input type="number" min={1} value={sla[priority].resolution}
                      onChange={e => setSla({...sla, [priority]: {...sla[priority], resolution: parseInt(e.target.value) || 1}})}
                      className="w-28 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Auto-Assignment Rules */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Auto-Assignment Rules</h3>
            <p className="text-sm text-gray-500 mt-0.5">Automatically assign tickets based on conditions.</p>
          </div>
          <button onClick={addRule} className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
            Add Rule
          </button>
        </div>
        {rules.length === 0 && (
          <div className="text-center py-8 text-gray-400 border-2 border-dashed border-gray-200 rounded-lg">
            No auto-assignment rules. Click "Add Rule" to create one.
          </div>
        )}
        <div className="space-y-3">
          {rules.map((rule, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-500 whitespace-nowrap">When</span>
              <select value={rule.condition_field} onChange={e => updateRule(i, 'condition_field', e.target.value)} className={`${sel} flex-1`}>
                <option value="priority">Priority</option>
                <option value="customer_name">Customer Name</option>
              </select>
              <span className="text-sm text-gray-500">is</span>
              {rule.condition_field === 'priority' ? (
                <select value={rule.condition_value} onChange={e => updateRule(i, 'condition_value', e.target.value)} className={`${sel} flex-1`}>
                  {['Low','Medium','High','Critical'].map(p => <option key={p}>{p}</option>)}
                </select>
              ) : (
                <input value={rule.condition_value} onChange={e => updateRule(i, 'condition_value', e.target.value)} placeholder="Customer name..." className={`${inp} flex-1`} />
              )}
              <span className="text-sm text-gray-500 whitespace-nowrap">→ assign to</span>
              <select value={rule.assign_to} onChange={e => updateRule(i, 'assign_to', e.target.value)} className={`${sel} flex-1`}>
                <option value="">Select user...</option>
                {users.map(u => <option key={u.user_email} value={u.user_email}>{u.user_email}</option>)}
              </select>
              <button onClick={() => removeRule(i)} className="text-red-400 hover:text-red-600 flex-shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const RMA_CONFIG_SQL = `CREATE TABLE IF NOT EXISTS rma_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key TEXT UNIQUE NOT NULL,
  config_value JSONB NOT NULL,
  updated_by TEXT,
  updated_date TIMESTAMPTZ DEFAULT NOW()
);`
