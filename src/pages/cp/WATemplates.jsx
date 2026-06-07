import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { Button, Spinner } from '../../components/ui'
import ConfirmDialog from '../../components/ConfirmDialog'

const EVENT_OPTIONS = [
  { value: 'ticket.created',       label: 'Ticket Created' },
  { value: 'ticket.updated',       label: 'Ticket Updated' },
  { value: 'ticket.assigned',      label: 'Ticket Assigned' },
  { value: 'ticket.closed',        label: 'Ticket Closed' },
  { value: 'ticket.cancelled',     label: 'Ticket Cancelled' },
  { value: 'payment.received',     label: 'Payment Received' },
  { value: 'replacement.approved', label: 'Replacement Approved' },
  { value: 'warranty.approved',    label: 'Warranty Approved' },
  { value: 'delivery.scheduled',   label: 'Delivery Scheduled' },
]

const PROVIDER_OPTIONS = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email',    label: 'Email' },
  { value: 'sms',      label: 'SMS' },
]

const STATUS_COLORS = {
  active:           'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  inactive:         'bg-gray-100 text-gray-600 dark:bg-[#1a2230] dark:text-[#9aa4b2]',
  pending_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
}

const BLANK = {
  name: '', display_name: '', event_type: 'ticket.created', provider: 'whatsapp',
  language: 'en', template_name: '', body_content: '', footer_content: '',
  variables: [], attach_pdf: false, status: 'active',
}

// Suggested variables for quick-insert
const SUGGESTED_VARS = [
  { key: 'customer_name', label: 'Customer Name', source: 'customer_name' },
  { key: 'ticket_number', label: 'Ticket Number', source: 'rma_number' },
  { key: 'ticket_status', label: 'Ticket Status', source: 'ticket_status' },
  { key: 'assigned_technician', label: 'Assigned Technician', source: 'assigned_technician' },
  { key: 'created_date', label: 'Created Date', source: 'created_date' },
  { key: 'due_date', label: 'Due Date', source: 'due_date' },
  { key: 'notes', label: 'Notes', source: 'general_description' },
  { key: 'invoice_number', label: 'Invoice Number', source: 'invoice_number' },
  { key: 'amount', label: 'Amount', source: 'amount' },
]

export default function WATemplates({ currentUserEmail }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [modal, setModal]       = useState(null)  // null | 'create' | 'edit' | 'preview'
  const [selected, setSelected] = useState(null)
  const [saving, setSaving]     = useState(false)
  const [confirm, setConfirm]   = useState({ open: false })
  const [form, setForm]         = useState(BLANK)
  const [previewVars, setPreviewVars] = useState({})

  const { data: result, isLoading } = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => db.whatsappTemplates.list(),
  })

  const templates = result?.data ?? []

  const openCreate = () => { setForm(BLANK); setModal('create') }
  const openEdit   = (tmpl) => {
    setForm({
      name: tmpl.name, display_name: tmpl.display_name, event_type: tmpl.event_type,
      provider: tmpl.provider, language: tmpl.language, template_name: tmpl.template_name ?? '',
      body_content: tmpl.body_content, footer_content: tmpl.footer_content ?? '',
      variables: tmpl.variables ?? [], attach_pdf: !!tmpl.attach_pdf, status: tmpl.status,
    })
    setSelected(tmpl)
    setModal('edit')
  }
  const openPreview = (tmpl) => {
    setSelected(tmpl)
    const vars = {}
    for (const v of tmpl.variables ?? []) vars[v.key] = `[${v.label}]`
    setPreviewVars(vars)
    setModal('preview')
  }

  const handleSave = async () => {
    if (!form.display_name.trim() || !form.event_type || !form.body_content.trim()) {
      toast.error(t('cp.waTemplates.fieldsRequired'))
      return
    }
    setSaving(true)
    try {
      if (modal === 'create') {
        await db.whatsappTemplates.create({ ...form, created_by: currentUserEmail })
        toast.success(t('cp.waTemplates.created'))
      } else {
        await db.whatsappTemplates.update(selected.id, form)
        toast.success(t('cp.waTemplates.updated'))
      }
      qc.invalidateQueries({ queryKey: ['whatsapp-templates'] })
      setModal(null)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = (tmpl) => {
    setConfirm({
      open: true,
      title: t('cp.waTemplates.deleteConfirm'),
      message: t('cp.waTemplates.deleteMessage', { name: tmpl.display_name }),
      onConfirm: async () => {
        setConfirm({ open: false })
        try {
          await db.whatsappTemplates.delete(tmpl.id)
          qc.invalidateQueries({ queryKey: ['whatsapp-templates'] })
          toast.success(t('cp.waTemplates.deleted'))
        } catch (err) {
          toast.error(err.message)
        }
      },
    })
  }

  const addVariable = (suggested) => {
    if (form.variables.some((v) => v.key === suggested.key)) return
    setForm((f) => ({ ...f, variables: [...f.variables, { ...suggested }] }))
    // Also insert placeholder in body
    setForm((f) => ({ ...f, body_content: f.body_content + ` {{${suggested.key}}}` }))
  }

  const removeVariable = (key) =>
    setForm((f) => ({ ...f, variables: f.variables.filter((v) => v.key !== key) }))

  const renderPreview = (tmpl, vars) => {
    if (!tmpl?.body_content) return ''
    let out = tmpl.body_content
    for (const [k, v] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
    }
    return out.replace(/\{\{#\w+\}\}[\s\S]*?\{\{\/\w+\}\}/g, '').replace(/\{\{[^}]+\}\}/g, '')
  }

  if (isLoading) return <div className="flex justify-center py-12"><Spinner /></div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {t('cp.waTemplates.count', { count: templates.length })}
        </p>
        <Button variant="primary" onClick={openCreate}>{t('cp.waTemplates.newTemplate')}</Button>
      </div>

      {templates.length === 0 ? (
        <div className="text-center py-16 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]">
          <div className="text-4xl mb-3">💬</div>
          <p className="font-medium text-gray-700 dark:text-[#e8ebf0]">{t('cp.waTemplates.noTemplates')}</p>
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1 mb-4">{t('cp.waTemplates.createFirst')}</p>
          <Button variant="primary" onClick={openCreate}>{t('cp.waTemplates.createBtn')}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((tmpl) => (
            <div key={tmpl.id} className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-gray-900 dark:text-[#e8ebf0]">{tmpl.display_name}</p>
                    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATUS_COLORS[tmpl.status]}`}>
                      {tmpl.status.replace('_', ' ')}
                    </span>
                    <span className="px-2 py-0.5 text-xs rounded-full font-medium bg-indigo-100 text-indigo-700 dark:bg-[#1a2230] dark:text-[#a5b4fc]">
                      {tmpl.provider}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                    {t('cp.waTemplates.eventLabel')} <strong>{tmpl.event_type}</strong>
                    {tmpl.template_name && <> · {t('cp.waTemplates.metaNameLabel')} <code className="font-mono">{tmpl.template_name}</code></>}
                    {tmpl.attach_pdf && <> · 📎 PDF</>}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-[#9aa4b2] mt-2 line-clamp-2 whitespace-pre-wrap">
                    {tmpl.body_content}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => openPreview(tmpl)}
                    className="px-3 py-1.5 text-xs font-medium border border-[#e6e9ef] dark:border-[#212a38] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0] transition-colors">
                    {t('cp.waTemplates.previewBtn')}
                  </button>
                  <button onClick={() => openEdit(tmpl)}
                    className="px-3 py-1.5 text-xs font-medium bg-[#4338ca] text-white rounded-lg hover:bg-[#3730a3] transition-colors">
                    {t('cp.edit')}
                  </button>
                  <button onClick={() => handleDelete(tmpl)}
                    className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                    {t('cp.delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit Modal */}
      {(modal === 'create' || modal === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="w-full max-w-2xl bg-white dark:bg-[#121823] rounded-2xl shadow-2xl mt-8 mb-8">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#e6e9ef] dark:border-[#212a38]">
              <h2 className="text-lg font-bold text-gray-900 dark:text-[#e8ebf0]">
                {modal === 'create' ? t('cp.waTemplates.newModal') : t('cp.waTemplates.editModal')}
              </h2>
              <button onClick={() => setModal(null)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-[#1a2230]">
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('cp.waTemplates.displayNameLabel')} value={form.display_name}
                  onChange={(v) => setForm((f) => ({ ...f, display_name: v }))} placeholder="e.g. Ticket Created" />
                <FormField label={t('cp.waTemplates.internalNameLabel')} value={form.name}
                  onChange={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="e.g. ticket_created" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className={lbl}>{t('cp.waTemplates.eventTypeLabel')}</label>
                  <select value={form.event_type} onChange={(e) => setForm((f) => ({ ...f, event_type: e.target.value }))} className={sel}>
                    {EVENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>{t('cp.waTemplates.providerLabel')}</label>
                  <select value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))} className={sel}>
                    {PROVIDER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>{t('cp.waTemplates.statusLabel')}</label>
                  <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={sel}>
                    <option value="active">{t('cp.waTemplates.statusActive')}</option>
                    <option value="inactive">{t('cp.waTemplates.statusInactive')}</option>
                    <option value="pending_approval">{t('cp.waTemplates.statusPending')}</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('cp.waTemplates.metaTemplateLabel')} value={form.template_name}
                  onChange={(v) => setForm((f) => ({ ...f, template_name: v }))}
                  placeholder="e.g. rma_ticket_created" />
                <div>
                  <label className={lbl}>{t('cp.waTemplates.languageLabel')}</label>
                  <select value={form.language} onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))} className={sel}>
                    <option value="en">English</option>
                    <option value="ar">Arabic</option>
                    <option value="fr">French</option>
                    <option value="es">Spanish</option>
                    <option value="de">German</option>
                  </select>
                </div>
              </div>

              {/* Body content */}
              <div>
                <label className={lbl}>{t('cp.waTemplates.bodyLabel')}</label>
                <textarea
                  value={form.body_content}
                  onChange={(e) => setForm((f) => ({ ...f, body_content: e.target.value }))}
                  rows={6}
                  className={`w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] resize-none font-mono`}
                  placeholder={t('cp.waTemplates.bodyPlaceholder')}
                />
              </div>

              {/* Suggested variables */}
              <div>
                <p className={`${lbl} mb-2`}>{t('cp.waTemplates.quickInsert')}</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_VARS.map((sv) => {
                    const added = form.variables.some((v) => v.key === sv.key)
                    return (
                      <button key={sv.key} onClick={() => addVariable(sv)}
                        className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${added ? 'border-[#4338ca] bg-indigo-50 dark:bg-[#1a2230] text-[#4338ca] dark:text-[#a5b4fc]' : 'border-[#e6e9ef] dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-[#4338ca]'}`}>
                        {`{{${sv.key}}}`}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Variable definitions */}
              {form.variables.length > 0 && (
                <div>
                  <p className={`${lbl} mb-2`}>{t('cp.waTemplates.variableMappings')}</p>
                  <div className="space-y-2">
                    {form.variables.map((v) => (
                      <div key={v.key} className="flex items-center gap-2 p-2 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg border border-[#e6e9ef] dark:border-[#212a38]">
                        <code className="text-xs font-mono text-[#4338ca] dark:text-[#a5b4fc] w-32 flex-shrink-0">{`{{${v.key}}}`}</code>
                        <input value={v.label} onChange={(e) => {
                          const vars = form.variables.map((vv) => vv.key === v.key ? { ...vv, label: e.target.value } : vv)
                          setForm((f) => ({ ...f, variables: vars }))
                        }} placeholder={t('cp.waTemplates.mappingLabelCol')} className={`flex-1 px-2 py-1 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded bg-white dark:bg-[#121823] text-gray-800 dark:text-[#e8ebf0]`} />
                        <input value={v.source} onChange={(e) => {
                          const vars = form.variables.map((vv) => vv.key === v.key ? { ...vv, source: e.target.value } : vv)
                          setForm((f) => ({ ...f, variables: vars }))
                        }} placeholder={t('cp.waTemplates.mappingFieldCol')} className={`flex-1 px-2 py-1 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded bg-white dark:bg-[#121823] text-gray-800 dark:text-[#e8ebf0] font-mono`} />
                        <button onClick={() => removeVariable(v.key)} className="text-red-500 hover:text-red-700 text-xs px-1">✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Footer + options */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('cp.waTemplates.footerLabel')} value={form.footer_content}
                  onChange={(v) => setForm((f) => ({ ...f, footer_content: v }))} placeholder="e.g. myRMA Support" />
                <div className="flex items-center gap-3 pt-5">
                  <input type="checkbox" id="attach_pdf" checked={!!form.attach_pdf}
                    onChange={(e) => setForm((f) => ({ ...f, attach_pdf: e.target.checked }))}
                    className="w-4 h-4 rounded border-gray-300 text-[#4338ca]" />
                  <label htmlFor="attach_pdf" className="text-sm text-gray-700 dark:text-[#e8ebf0] cursor-pointer">
                    {t('cp.waTemplates.attachPdf')}
                  </label>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
              <Button variant="secondary" onClick={() => setModal(null)}>{t('cp.cancel')}</Button>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? <Spinner size="sm" color="white" /> : (modal === 'create' ? t('cp.waTemplates.createTemplate') : t('cp.waTemplates.saveChanges'))}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {modal === 'preview' && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white dark:bg-[#121823] rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#e6e9ef] dark:border-[#212a38]">
              <h2 className="font-bold text-gray-900 dark:text-[#e8ebf0]">{t('cp.waTemplates.previewModal')}</h2>
              <button onClick={() => setModal(null)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-[#1a2230]">
                <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {/* Phone mockup */}
              <div className="bg-[#e5ddd5] rounded-xl p-4">
                <div className="bg-[#dcf8c6] rounded-xl rounded-br-sm px-4 py-3 max-w-[85%] ml-auto shadow-sm">
                  <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
                    {renderPreview(selected, previewVars)}
                  </p>
                  <p className="text-[10px] text-gray-500 text-right mt-1">12:00 ✓✓</p>
                </div>
              </div>
              {/* Variable overrides */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{t('cp.waTemplates.fillVariables')}</p>
                <div className="space-y-2">
                  {(selected.variables ?? []).map((v) => (
                    <div key={v.key} className="flex items-center gap-2">
                      <code className="text-xs font-mono text-[#4338ca] dark:text-[#a5b4fc] w-32 flex-shrink-0">{`{{${v.key}}}`}</code>
                      <input value={previewVars[v.key] ?? ''} onChange={(e) => setPreviewVars((p) => ({ ...p, [v.key]: e.target.value }))}
                        placeholder={v.label}
                        className="flex-1 px-2 py-1 text-xs border border-[#e6e9ef] dark:border-[#212a38] rounded bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0]" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm.open}
        title={confirm.title}
        message={confirm.message}
        onConfirm={confirm.onConfirm}
        onCancel={() => setConfirm({ open: false })}
      />
    </div>
  )

}

const lbl = 'block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5'
const sel = 'w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca]'

function FormField({ label, value, onChange, placeholder = '' }) {
  return (
    <div>
      <label className={lbl}>{label}</label>
      <input type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent" />
    </div>
  )
}
