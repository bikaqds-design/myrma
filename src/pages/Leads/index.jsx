import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db, supabase } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { PageHeader, Button } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { leadSchema, getFirstError } from '../../lib/schemas'
import { LEAD_STATUS_LIST, LEAD_SOURCE_LIST } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { safeStorage } from '../../lib/safeStorage'
import { EMPTY_FORM, EMPTY_CONVERT_FORM } from './_constants'
import { CreateLeadModal, ConvertLeadModal } from './_modals'
import { SortableHeader } from './_shared'

const STATUS_BADGE = {
  new:          'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  contacted:    'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  qualified:    'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  nurturing:    'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  inactive:     'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400',
  converted:    'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  disqualified: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
}

const SOURCE_BADGE = {
  'walk-in':   'bg-cyan-100 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-400',
  phone:       'bg-rose-100 dark:bg-rose-900/20 text-rose-700 dark:text-rose-400',
  referral:    'bg-fuchsia-100 dark:bg-fuchsia-900/20 text-fuchsia-700 dark:text-fuchsia-400',
  exhibition:  'bg-lime-100 dark:bg-lime-900/20 text-lime-700 dark:text-lime-400',
  website:     'bg-sky-100 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400',
  whatsapp:    'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
}

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  result.push(current.trim())
  return result
}

export default function Leads({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const searchRef = useRef(null)
  const queryClient = useQueryClient()

  const { data: leads = [], isLoading: loading } = useQuery({
    queryKey: ['leads'],
    queryFn: () => db.leads.list(),
    staleTime: 60_000,
  })
  const { data: pipelines = [] } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => db.pipelines.list(),
    staleTime: 5 * 60_000,
  })
  const { data: usersList = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => db.userRoles.listAllRoles(),
    staleTime: 5 * 60_000,
  })
  const salesReps = usersList.filter((u) => u.role === 'sales_rep' || u.role === 'manager')

  const [sortConfig, setSortConfig] = useState(() =>
    safeStorage.get('leadsSortConfig', { key: 'created_at', direction: 'desc' })
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterSource, setFilterSource] = useState('')
  const [openMenuId, setOpenMenuId] = useState(null)
  const [menuAnchor, setMenuAnchor] = useState(null)
  const [statusMenu, setStatusMenu] = useState({ id: null, anchor: null })
  const [sourceMenu, setSourceMenu] = useState({ id: null, anchor: null })
  const [showAddLead, setShowAddLead] = useState(false)
  const [editingLead, setEditingLead] = useState(null)
  const [leadForm, setLeadForm] = useState(EMPTY_FORM)
  const [convertingLead, setConvertingLead] = useState(null)
  const [convertForm, setConvertForm] = useState(EMPTY_CONVERT_FORM)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })

  const openConfirm = (title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  useEffect(() => {
    safeStorage.set('leadsSortConfig', sortConfig)
  }, [sortConfig])

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.leads?.[action] === true
  }

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
      if (!e.target.closest('.status-menu')) setStatusMenu({ id: null, anchor: null })
      if (!e.target.closest('.source-menu')) setSourceMenu({ id: null, anchor: null })
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // The table wrapper scrolls horizontally (overflow-x-auto), which per the CSS
  // overflow spec also forces overflow-y to auto — an absolutely-positioned menu
  // inside it gets clipped/scrollable instead of floating over the page. Close
  // the menu on scroll/resize instead of trying to keep a portal-rendered menu
  // repositioned through it.
  useEffect(() => {
    if (openMenuId === null && statusMenu.id === null && sourceMenu.id === null) return
    const close = () => {
      setOpenMenuId(null)
      setStatusMenu({ id: null, anchor: null })
      setSourceMenu({ id: null, anchor: null })
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [openMenuId, statusMenu.id, sourceMenu.id])

  const MENU_WIDTH = 176
  const handleToggleMenu = (e, leadId) => {
    e.stopPropagation()
    if (openMenuId === leadId) {
      setOpenMenuId(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const estimatedHeight = 168
    let top = rect.bottom + 4
    if (top + estimatedHeight > window.innerHeight - 8) top = rect.top - estimatedHeight - 4
    let left = rect.right - MENU_WIDTH
    if (left < 8) left = 8
    setMenuAnchor({ top, left })
    setOpenMenuId(leadId)
  }

  // Inline status pill — manual status changes (not 'converted', which only the
  // Convert flow may set). Converted leads are locked (immutable rule).
  const STATUS_MENU_WIDTH = 160
  const inlineStatusList = LEAD_STATUS_LIST.filter((s) => s !== 'converted')
  const canEditStatus = (lead) => canDo('edit') && lead.status !== 'converted'

  const handleToggleStatusMenu = (e, leadId) => {
    e.stopPropagation()
    if (statusMenu.id === leadId) {
      setStatusMenu({ id: null, anchor: null })
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const estimatedHeight = 8 + inlineStatusList.length * 30
    let top = rect.bottom + 4
    if (top + estimatedHeight > window.innerHeight - 8) top = rect.top - estimatedHeight - 4
    let left = rect.left
    if (left + STATUS_MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - STATUS_MENU_WIDTH - 8
    setStatusMenu({ id: leadId, anchor: { top, left } })
  }

  const handleInlineStatus = async (lead, newStatus) => {
    setStatusMenu({ id: null, anchor: null })
    if (lead.status === newStatus) return
    try {
      await db.leads.updateStatus(lead.id, newStatus, currentUserEmail)
      toast.success(t('leads.statusUpdated'))
      db.auditLog.log(currentUserEmail, 'lead_status_changed', `Lead ${lead.full_name}: ${lead.status} → ${newStatus}`).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  // Inline source pill — same gate as status: blocked once a lead is converted
  // (db.leads.update() rejects any field but notes once converted_at is set).
  const SOURCE_MENU_WIDTH = 160

  const handleToggleSourceMenu = (e, leadId) => {
    e.stopPropagation()
    if (sourceMenu.id === leadId) {
      setSourceMenu({ id: null, anchor: null })
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const estimatedHeight = 8 + LEAD_SOURCE_LIST.length * 30
    let top = rect.bottom + 4
    if (top + estimatedHeight > window.innerHeight - 8) top = rect.top - estimatedHeight - 4
    let left = rect.left
    if (left + SOURCE_MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - SOURCE_MENU_WIDTH - 8
    setSourceMenu({ id: leadId, anchor: { top, left } })
  }

  const handleInlineSource = async (lead, newSource) => {
    setSourceMenu({ id: null, anchor: null })
    if (lead.source === newSource) return
    try {
      await db.leads.update(lead.id, { source: newSource })
      toast.success(t('leads.sourceUpdated'))
      db.auditLog.log(currentUserEmail, 'lead_source_changed', `Lead ${lead.full_name}: ${lead.source} → ${newSource}`).catch(() => {})
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  // Real-time: invalidate query cache when leads table changes
  useEffect(() => {
    const channel = supabase
      .channel('leads_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => {
        queryClient.invalidateQueries({ queryKey: ['leads'] })
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [queryClient])

  const statusMenuLead = leads.find((l) => l.id === statusMenu.id)
  const sourceMenuLead = leads.find((l) => l.id === sourceMenu.id)

  const filteredLeads = leads
    .filter((l) => {
      if (filterStatus && l.status !== filterStatus) return false
      if (filterSource && l.source !== filterSource) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        return (
          l.full_name?.toLowerCase().includes(q) ||
          l.company_name?.toLowerCase().includes(q) ||
          l.email?.toLowerCase().includes(q) ||
          l.phone?.toLowerCase().includes(q)
        )
      }
      return true
    })
    .sort((a, b) => {
      let aVal
      let bVal
      if (sortConfig.key === 'full_name') {
        // Sort by whatever's actually shown bold in the Name column.
        aVal = (a.company_name || a.full_name || '').toLowerCase()
        bVal = (b.company_name || b.full_name || '').toLowerCase()
      } else if (sortConfig.key === 'created_at') {
        aVal = new Date(a.created_at || 0).getTime()
        bVal = new Date(b.created_at || 0).getTime()
      } else {
        aVal = (a[sortConfig.key] || '').toString().toLowerCase()
        bVal = (b[sortConfig.key] || '').toString().toLowerCase()
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })

  const handleSort = (key) => {
    setSortConfig((prev) => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const resetForm = () => {
    setLeadForm(EMPTY_FORM)
    setEditingLead(null)
  }

  const handleSaveLead = async () => {
    const validation = leadSchema.safeParse(leadForm)
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }
    const payload = {
      full_name: leadForm.full_name,
      company_name: leadForm.company_name || null,
      phone: leadForm.phone || null,
      email: leadForm.email || null,
      source: leadForm.source,
      status: leadForm.status,
      assigned_rep: leadForm.assigned_rep || null,
      notes: leadForm.notes || null,
    }
    try {
      if (editingLead) {
        const statusChanged = editingLead.status !== payload.status
        await db.leads.update(editingLead.id, payload)
        if (statusChanged) {
          db.activities
            .logSystem('lead', editingLead.id, `status_changed|${editingLead.status}|${payload.status}`, currentUserEmail)
            .catch(() => {})
        }
        toast.success(t('leads.leadUpdated'))
        db.auditLog.log(currentUserEmail, 'lead_updated', `Updated lead ${payload.full_name}`).catch(() => {})
      } else {
        await db.leads.create({ ...payload, created_by: currentUserEmail })
        toast.success(t('leads.leadCreated'))
        db.auditLog.log(currentUserEmail, 'lead_created', `Created lead ${payload.full_name}`).catch(() => {})
      }
      setShowAddLead(false)
      resetForm()
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleEditLead = (lead) => {
    setEditingLead(lead)
    setLeadForm({
      full_name: lead.full_name || '',
      company_name: lead.company_name || '',
      phone: lead.phone || '',
      email: lead.email || '',
      source: lead.source || 'walk-in',
      status: lead.status || 'new',
      assigned_rep: lead.assigned_rep || '',
      notes: lead.notes || '',
    })
    setShowAddLead(true)
  }

  const handleDeleteLead = (lead) => {
    openConfirm(t('leads.deleteLeadTitle'), t('leads.deleteLeadConfirm', { name: lead.full_name }), async () => {
      closeConfirm()
      try {
        await db.leads.update(lead.id, { status: 'disqualified' })
        toast.success(t('leads.leadDisqualified'))
        db.auditLog.log(currentUserEmail, 'lead_disqualified', `Disqualified lead ${lead.full_name}`).catch(() => {})
        queryClient.invalidateQueries({ queryKey: ['leads'] })
      } catch (error) {
        toast.error(t('leads.failedSave', { error: error.message }))
      }
    })
  }

  const handleOpenConvert = (lead) => {
    setConvertingLead(lead)
    setConvertForm({ ...EMPTY_CONVERT_FORM, title: `${lead.full_name} — Deal` })
  }

  const handleConvert = async () => {
    if (!convertForm.title.trim() || !convertForm.pipeline_id) {
      toast.error(t('leadModal.convertValidation'))
      return
    }
    try {
      const result = await db.leads.convert(convertingLead.id, {
        title: convertForm.title,
        pipelineId: convertForm.pipeline_id,
        value: convertForm.value ? Number(convertForm.value) : undefined,
      })
      toast.success(t('leads.leadConverted'))
      db.auditLog
        .log(currentUserEmail, 'lead_converted', `Converted lead ${convertingLead.full_name} to deal ${result.deal.id}`)
        .catch(() => {})
      setConvertingLead(null)
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedConvert', { error: error.message }))
    }
  }

  const handleDownloadTemplate = () => {
    const csv = [
      ['full_name', 'company_name', 'phone', 'email', 'source', 'notes'].join(','),
      ['Ahmed Saeed', 'Maximum Hardware', '01000121589', 'ahmed@maximum.com', 'phone', ''].join(','),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'leads-template.csv'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleBulkUpload = async (file) => {
    try {
      const rawText = await file.text()
      const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText
      const lines = text.split('\n').filter((line) => line.trim())
      if (lines.length < 2) {
        toast.error(t('leads.csvEmpty'))
        return
      }
      const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase())
      if (!headers.includes('full_name') || !headers.includes('source')) {
        toast.error(t('leads.csvMissingColumns'))
        return
      }
      const validSources = new Set(['walk-in', 'phone', 'referral', 'exhibition', 'website', 'whatsapp'])
      const toImport = []
      const errors = []
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i])
        const row = {}
        headers.forEach((h, idx) => {
          row[h] = values[idx] || ''
        })
        if (!row.full_name) {
          errors.push(`Row ${i + 1}: full_name is required`)
          continue
        }
        const source = validSources.has(row.source) ? row.source : 'website'
        toImport.push({
          full_name: row.full_name,
          company_name: row.company_name || null,
          phone: row.phone || null,
          email: row.email || null,
          source,
          status: 'new',
          notes: row.notes || null,
          created_by: currentUserEmail,
        })
      }
      if (toImport.length === 0) {
        toast.error(t('leads.noValidLeads'))
        if (errors.length > 0) captureException(new Error('Lead CSV import errors'), { errors })
        return
      }
      for (const lead of toImport) {
        await db.leads.create(lead)
      }
      toast.success(t('leads.importedSuccess', { count: toImport.length }))
      db.auditLog.log(currentUserEmail, 'leads_imported', `Imported ${toImport.length} leads from CSV`).catch(() => {})
      if (errors.length > 0) {
        toast.error(t('leads.importRowErrors', { count: errors.length }))
        captureException(new Error('Lead CSV import errors'), { errors })
      }
      setShowAddLead(false)
      queryClient.invalidateQueries({ queryKey: ['leads'] })
    } catch (error) {
      toast.error(t('leads.failedImport', { error: error.message }))
    }
  }

  if (loading) return <PageSkeleton cols={6} />

  return (
    <div className="space-y-6">
      <PageHeader title={t('leads.title')} subtitle={t('leads.subtitle')}>
        {canDo('create') && (
          <>
            <input
              type="file"
              accept=".csv"
              id="leads-csv-input"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) handleBulkUpload(e.target.files[0])
                e.target.value = ''
              }}
            />
            <Button variant="secondary" onClick={handleDownloadTemplate}>
              {t('leads.downloadTemplate')}
            </Button>
            <Button variant="secondary" onClick={() => document.getElementById('leads-csv-input').click()}>
              {t('leads.importCSV')}
            </Button>
            <Button
              onClick={() => {
                resetForm()
                setShowAddLead(true)
              }}
            >
              {t('leads.addLead')}
            </Button>
          </>
        )}
      </PageHeader>

      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
        <div className="p-5 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
            <div className="relative flex-1 max-w-md">
              <input
                ref={searchRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('leads.searchPlaceholder')}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              />
              <svg className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2] absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg text-sm"
            >
              <option value="">{t('leads.allStatuses')}</option>
              {LEAD_STATUS_LIST.map((s) => (
                <option key={s} value={s}>
                  {t(`leadStatus.${s}`)}
                </option>
              ))}
            </select>
            <select
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-[#212a38] dark:bg-[#0f1520] dark:text-[#e8ebf0] rounded-lg text-sm"
            >
              <option value="">{t('leads.allSources')}</option>
              {['walk-in', 'phone', 'referral', 'exhibition', 'website', 'whatsapp'].map((s) => (
                <option key={s} value={s}>
                  {t(`leadSource.${s.replace('-', '_')}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-y border-gray-200 dark:border-[#212a38]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('leads.colName')} sortKey="full_name" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('leads.colContact')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('leads.colSource')} sortKey="source" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('common.status')} sortKey="status" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">
                    <SortableHeader label={t('leads.colAssignedRep')} sortKey="assigned_rep" sortConfig={sortConfig} onSort={handleSort} />
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-[#212a38]">
                {filteredLeads.length === 0 ? (
                  <tr>
                    <td colSpan="6">
                      <EmptyState
                        title={t('leads.noLeadsFound')}
                        description={leads.length > 0 ? t('leads.adjustFilters') : t('leads.noLeadsHint')}
                        action={canDo('create') && leads.length === 0 ? () => setShowAddLead(true) : undefined}
                        actionLabel={t('leads.addFirstLead')}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredLeads.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => navigate(`/leads/${l.id}`)}
                          className="font-medium text-indigo-600 dark:text-[#a5b4fc] hover:underline text-sm text-left"
                        >
                          {l.company_name || l.full_name}
                        </button>
                        {l.company_name && <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{l.full_name}</div>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-[#9aa4b2]">
                        {l.phone || l.email || '—'}
                      </td>
                      <td className="px-4 py-3">
                        {canEditStatus(l) ? (
                          <button
                            onClick={(e) => handleToggleSourceMenu(e, l.id)}
                            aria-haspopup="menu"
                            aria-expanded={sourceMenu.id === l.id}
                            className={`source-menu px-2 py-0.5 text-xs rounded-full font-medium inline-flex items-center gap-1 hover:opacity-80 transition-opacity ${SOURCE_BADGE[l.source] || SOURCE_BADGE['walk-in']}`}
                          >
                            {t(`leadSource.${l.source?.replace('-', '_')}`)}
                            <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        ) : (
                          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[l.source] || SOURCE_BADGE['walk-in']}`}>
                            {t(`leadSource.${l.source?.replace('-', '_')}`)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {canEditStatus(l) ? (
                          <button
                            onClick={(e) => handleToggleStatusMenu(e, l.id)}
                            aria-haspopup="menu"
                            aria-expanded={statusMenu.id === l.id}
                            className={`status-menu px-2 py-0.5 text-xs rounded-full font-medium inline-flex items-center gap-1 hover:opacity-80 transition-opacity ${STATUS_BADGE[l.status] || STATUS_BADGE.new}`}
                          >
                            {t(`leadStatus.${l.status}`)}
                            <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>
                        ) : (
                          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATUS_BADGE[l.status] || STATUS_BADGE.new}`}>
                            {t(`leadStatus.${l.status}`)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-[#9aa4b2]">{l.assigned_rep || '—'}</td>
                      <td className="px-4 py-3 relative action-menu">
                        <button
                          onClick={(e) => handleToggleMenu(e, l.id)}
                          aria-label={t('leads.actionsFor', { name: l.full_name })}
                          aria-expanded={openMenuId === l.id}
                          aria-haspopup="menu"
                          className="p-1.5 rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:bg-gray-100 dark:hover:bg-[#1a2230] transition-colors"
                        >
                          <svg className="w-4 h-4" aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
                            <circle cx="12" cy="5" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="12" cy="19" r="1.5" />
                          </svg>
                        </button>
                        {openMenuId === l.id &&
                          menuAnchor &&
                          createPortal(
                            <div
                              role="menu"
                              style={{ position: 'fixed', top: menuAnchor.top, left: menuAnchor.left, width: MENU_WIDTH, zIndex: 9999 }}
                              className="action-menu bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden"
                            >
                              <button
                                onClick={() => {
                                  navigate(`/leads/${l.id}`)
                                  setOpenMenuId(null)
                                }}
                                className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                              >
                                {t('leads.viewLead')}
                              </button>
                              {l.status !== 'converted' && canDo('edit') && (
                                <button
                                  onClick={() => {
                                    handleEditLead(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                                >
                                  {t('common.edit')}
                                </button>
                              )}
                              {l.status !== 'converted' && canDo('create') && (
                                <button
                                  onClick={() => {
                                    handleOpenConvert(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm text-indigo-600 hover:bg-gray-50 dark:hover:bg-[#1a2230]"
                                >
                                  {t('leads.convertToDeal')}
                                </button>
                              )}
                              {l.status !== 'converted' && l.status !== 'disqualified' && canDo('edit') && (
                                <button
                                  onClick={() => {
                                    handleDeleteLead(l)
                                    setOpenMenuId(null)
                                  }}
                                  className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                >
                                  {t('leads.disqualify')}
                                </button>
                              )}
                            </div>,
                            document.body
                          )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showAddLead && (
        <CreateLeadModal
          form={leadForm}
          setForm={setLeadForm}
          editing={editingLead}
          salesReps={salesReps}
          onSave={handleSaveLead}
          onClose={() => {
            setShowAddLead(false)
            resetForm()
          }}
        />
      )}

      {convertingLead && (
        <ConvertLeadModal
          lead={convertingLead}
          pipelines={pipelines}
          form={convertForm}
          setForm={setConvertForm}
          onConvert={handleConvert}
          onClose={() => setConvertingLead(null)}
        />
      )}

      {statusMenu.id &&
        statusMenu.anchor &&
        statusMenuLead &&
        createPortal(
          <div
            role="menu"
            style={{ position: 'fixed', top: statusMenu.anchor.top, left: statusMenu.anchor.left, width: STATUS_MENU_WIDTH, zIndex: 9999 }}
            className="status-menu bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden"
          >
            {inlineStatusList.map((s) => (
              <button
                key={s}
                onClick={() => handleInlineStatus(statusMenuLead, s)}
                className={`w-full px-3 py-1.5 text-left flex items-center transition-colors ${statusMenuLead.status === s ? 'opacity-40 cursor-default' : 'hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
              >
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${STATUS_BADGE[s] || STATUS_BADGE.new}`}>
                  {t(`leadStatus.${s}`)}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}

      {sourceMenu.id &&
        sourceMenu.anchor &&
        sourceMenuLead &&
        createPortal(
          <div
            role="menu"
            style={{ position: 'fixed', top: sourceMenu.anchor.top, left: sourceMenu.anchor.left, width: SOURCE_MENU_WIDTH, zIndex: 9999 }}
            className="source-menu bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-gray-200 dark:border-[#212a38] py-1 overflow-hidden"
          >
            {LEAD_SOURCE_LIST.map((s) => (
              <button
                key={s}
                onClick={() => handleInlineSource(sourceMenuLead, s)}
                className={`w-full px-3 py-1.5 text-left flex items-center transition-colors ${sourceMenuLead.source === s ? 'opacity-40 cursor-default' : 'hover:bg-gray-50 dark:hover:bg-[#1a2230]'}`}
              >
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[s] || SOURCE_BADGE['walk-in']}`}>
                  {t(`leadSource.${s.replace('-', '_')}`)}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  )
}
