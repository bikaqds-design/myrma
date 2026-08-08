import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { Button, Ltr } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { ActivityChatter } from '../../components/ActivityChatter'
import { CommentPanel } from '../../components/CommentPanel'
import { LEAD_STATUS_LIST } from '../../lib/constants'
import { EMPTY_CONVERT_FORM } from './_constants'
import { ConvertLeadModal } from './_modals'

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

const DEAL_STATUS_BADGE = {
  open: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc]',
  won:  'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  lost: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
}

const CARD = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]'

const TAB_CLS = (active) =>
  `px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
    active
      ? 'border-indigo-600 dark:border-[#a5b4fc] text-indigo-600 dark:text-[#a5b4fc]'
      : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:hover:text-[#e8ebf0]'
  }`

const LEAD_SOURCES = ['walk-in', 'phone', 'referral', 'exhibition', 'website', 'whatsapp']

export default function LeadDetails({ leadId, currentUserRole, currentUserEmail, currentUserPermissions, onBack }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: lead, isLoading, isError } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => db.leads.get(leadId),
    enabled: !!leadId,
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
  const salesReps = usersList.filter((u) =>
    u.role === 'sales_rep' || u.role === 'manager' || u.role === 'admin' || u.role === 'super_admin'
  )

  const { data: linkedDeal } = useQuery({
    queryKey: ['deal', lead?.converted_deal_id],
    queryFn: () => db.deals.get(lead.converted_deal_id),
    enabled: !!lead?.converted_deal_id,
  })
  const linkedDealPipeline = pipelines.find((p) => p.id === linkedDeal?.pipeline_id)
  const linkedDealStageName =
    linkedDealPipeline?.stages.find((s) => s.id === linkedDeal?.stage)?.name ?? linkedDeal?.stage

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.leads?.[action] === true
  }

  const isConverted = lead?.status === 'converted'
  const canEdit = canDo('edit') && !isConverted

  const EDITABLE = canEdit
    ? 'cursor-pointer rounded px-1 -mx-1 border-b-2 border-dashed border-transparent hover:border-indigo-300 dark:hover:border-[#a5b4fc] hover:bg-indigo-50/60 dark:hover:bg-indigo-900/10 transition-all'
    : ''

  // Inline edit state
  const [editingName, setEditingName] = useState(false)
  // Separate flag for the Lead Info panel's name field — the header has its own
  // name editor (shown only when the lead has no company_name), and sharing one
  // flag would open both inputs at once, each with autoFocus.
  const [editingNameInfo, setEditingNameInfo] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [editingCompany, setEditingCompany] = useState(false)
  const [companyInput, setCompanyInput] = useState('')
  const [editingPhone, setEditingPhone] = useState(false)
  const [phoneInput, setPhoneInput] = useState('')
  const [editingEmail, setEditingEmail] = useState(false)
  const [emailInput, setEmailInput] = useState('')
  const [editingSource, setEditingSource] = useState(false)
  const [sourceInput, setSourceInput] = useState('')
  const [editingRep, setEditingRep] = useState(false)
  const [repInput, setRepInput] = useState('')
  const [notesInput, setNotesInput] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [tab, setTab] = useState('note')

  const [showConvert, setShowConvert] = useState(false)
  const [convertForm, setConvertForm] = useState(EMPTY_CONVERT_FORM)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })

  useEffect(() => {
    setNotesInput(lead?.notes ?? '')
  }, [lead?.notes])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['lead', leadId] })
    queryClient.invalidateQueries({ queryKey: ['leads'] })
    queryClient.invalidateQueries({ queryKey: ['activities', 'lead', leadId] })
  }

  const FIELD_KEY_MAP = {
    full_name:     'leadModal.fullName',
    company_name:  'leadModal.companyName',
    phone:         'leadModal.phone',
    email:         'common.email',
    source:        'leads.colSource',
    assigned_rep:  'leads.colAssignedRep',
  }

  const saveField = async (field, value) => {
    try {
      await db.leads.update(leadId, { [field]: value })
      toast.success(t('leads.leadUpdated'))
      const fieldKey = FIELD_KEY_MAP[field]
      if (fieldKey) {
        db.activities
          .logSystem('lead', leadId, `field_updated|${fieldKey}|${value || '—'}`, currentUserEmail)
          .catch(() => {})
      }
      refresh()
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleSaveName = () => {
    if (!nameInput.trim()) return
    saveField('full_name', nameInput.trim())
    setEditingName(false)
    setEditingNameInfo(false)
  }
  const handleSaveCompany = () => {
    saveField('company_name', companyInput.trim() || null)
    setEditingCompany(false)
  }
  const handleSavePhone = () => {
    saveField('phone', phoneInput.trim() || null)
    setEditingPhone(false)
  }
  const handleSaveEmail = () => {
    saveField('email', emailInput.trim() || null)
    setEditingEmail(false)
  }
  const handleSaveSource = () => {
    saveField('source', sourceInput)
    setEditingSource(false)
  }
  const handleSaveRep = () => {
    saveField('assigned_rep', repInput || null)
    setEditingRep(false)
  }
  const handleSaveNotes = async () => {
    setSavingNotes(true)
    try {
      await db.leads.update(leadId, { notes: notesInput || null })
      toast.success(t('leads.leadUpdated'))
      refresh()
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    } finally {
      setSavingNotes(false)
    }
  }

  const inlineStatusList = LEAD_STATUS_LIST.filter((s) => s !== 'converted')

  const handleStatusChange = async (newStatus) => {
    if (!lead || lead.status === newStatus) return
    try {
      await db.leads.updateStatus(lead.id, newStatus, currentUserEmail)
      toast.success(t('leads.statusUpdated'))
      db.auditLog.log(currentUserEmail, 'lead_status_changed', `Lead ${lead.full_name}: ${lead.status} → ${newStatus}`).catch(() => {})
      refresh()
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleOpenConvert = () => {
    const pid = pipelines[0]?.id ?? ''
    const firstStage = pipelines[0]?.stages
      ? [...pipelines[0].stages].sort((a, b) => a.order - b.order).find((s) => !s.is_won && !s.is_lost)
      : null
    setConvertForm({
      ...EMPTY_CONVERT_FORM,
      title: `${lead.full_name} — ${t('leadModal.dealTitle')}`,
      pipeline_id: pid,
      stage_id: firstStage?.id ?? '',
    })
    setShowConvert(true)
  }

  const handleConvert = async () => {
    if (!convertForm.title.trim() || !convertForm.pipeline_id) {
      toast.error(t('leadModal.convertValidation'))
      return
    }
    try {
      await db.leads.convert(lead.id, {
        title: convertForm.title.trim(),
        pipelineId: convertForm.pipeline_id,
        value: convertForm.value ? Number(convertForm.value) : undefined,
      })
      db.activities.logSystem('lead', lead.id, 'converted', currentUserEmail).catch(() => {})
      toast.success(t('leads.leadConverted'))
      setShowConvert(false)
      refresh()
    } catch (error) {
      toast.error(t('leads.failedConvert', { error: error.message }))
    }
  }

  const handleDisqualify = () => {
    setConfirmDialog({
      open: true,
      title: t('leads.deleteLeadTitle'),
      message: t('leads.deleteLeadConfirm', { name: lead?.full_name }),
      onConfirm: async () => {
        setConfirmDialog((d) => ({ ...d, open: false }))
        await handleStatusChange('disqualified')
      },
    })
  }

  if (isLoading) return <PageSkeleton />
  if (isError || !lead) {
    return (
      <div className="p-6">
        <EmptyState title={t('leads.noLeadsFound')} description="" action={onBack} actionLabel={t('common.back')} />
      </div>
    )
  }

  return (
    <div className="w-full px-4 py-6">
      {/* Back + actions */}
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="text-sm text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 flex items-center gap-1">
          ← {t('common.back')}
        </button>
        <div className="flex items-center gap-2">
          {!isConverted && lead.status !== 'disqualified' && canDo('edit') && (
            <Button variant="secondary" size="sm" onClick={handleDisqualify}>
              {t('leads.disqualify')}
            </Button>
          )}
          {!isConverted && canDo('create') && (
            <Button variant="success" size="sm" onClick={handleOpenConvert}>
              {t('leads.convertToDeal')}
            </Button>
          )}
        </div>
      </div>

      {/* Header card */}
      <div className={`${CARD} mb-4`}>
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex-1 min-w-0">
            {/* Header edits company_name when it exists, full_name otherwise */}
            {lead.company_name ? (
              editingCompany ? (
                <div className="flex items-center gap-2 mb-1">
                  <input
                    type="text"
                    value={companyInput}
                    onChange={(e) => setCompanyInput(e.target.value)}
                    autoFocus
                    className="text-2xl font-bold border-b-2 border-indigo-500 bg-transparent text-gray-900 dark:text-[#e8ebf0] focus:outline-none flex-1 min-w-0"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCompany(); if (e.key === 'Escape') setEditingCompany(false) }}
                  />
                  <button onClick={handleSaveCompany} className="text-sm text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                  <button onClick={() => setEditingCompany(false)} className="text-sm text-gray-400 hover:underline">×</button>
                </div>
              ) : (
                <h1
                  className={`text-2xl font-bold text-gray-900 dark:text-[#e8ebf0] ${EDITABLE}`}
                  onClick={canEdit ? () => { setCompanyInput(lead.company_name || ''); setEditingCompany(true) } : undefined}
                  title={canEdit ? t('pipeline.clickToEdit') : undefined}
                >
                  {lead.company_name}
                </h1>
              )
            ) : (
              editingName ? (
                <div className="flex items-center gap-2 mb-1">
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    autoFocus
                    className="text-2xl font-bold border-b-2 border-indigo-500 bg-transparent text-gray-900 dark:text-[#e8ebf0] focus:outline-none flex-1 min-w-0"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false) }}
                  />
                  <button onClick={handleSaveName} className="text-sm text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                  <button onClick={() => setEditingName(false)} className="text-sm text-gray-400 hover:underline">×</button>
                </div>
              ) : (
                <h1
                  className={`text-2xl font-bold text-gray-900 dark:text-[#e8ebf0] ${EDITABLE}`}
                  onClick={canEdit ? () => { setNameInput(lead.full_name || ''); setEditingName(true) } : undefined}
                  title={canEdit ? t('pipeline.clickToEdit') : undefined}
                >
                  {lead.full_name}
                </h1>
              )
            )}
            {lead.company_name && !editingCompany && (
              <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">{t('leadModal.fullName')}: {lead.full_name}</p>
            )}
            {lead.lead_code && (
              <span className="inline-block mt-1 text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded">
                {lead.lead_code}
              </span>
            )}
          </div>
          {isConverted && (
            <span className={`px-3 py-1 text-sm rounded-full font-medium ${STATUS_BADGE.converted}`}>
              {t('leadStatus.converted')}
            </span>
          )}
        </div>

        {/* Status stepper */}
        <div className="flex flex-wrap gap-2 mt-4">
          {isConverted ? (
            <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t('leads.lockedConverted')}</span>
          ) : (
            inlineStatusList.map((s) => {
              const active = lead.status === s
              return (
                <button
                  key={s}
                  disabled={!canDo('edit') || active}
                  onClick={() => handleStatusChange(s)}
                  className={`px-3 py-1 text-xs rounded-full font-medium transition-all ${
                    active
                      ? `${STATUS_BADGE[s]} ring-2 ring-offset-1 ring-indigo-400 dark:ring-offset-[#121823]`
                      : `${STATUS_BADGE[s]} opacity-50 hover:opacity-100 ${canDo('edit') ? 'cursor-pointer' : 'cursor-default'}`
                  }`}
                >
                  {t(`leadStatus.${s}`)}
                </button>
              )
            })
          )}
        </div>
      </div>

      {/* 4-column grid: Lead Info (25%) | Tabs (50%) | Comments (25%) */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">

        {/* Left: Lead Info */}
        <div className={`${CARD} lg:col-span-1 space-y-4`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('leads.leadInfo')}</h3>

          {/* Full Name */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leadModal.fullName')}</div>
            {editingNameInfo ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  autoFocus
                  className="flex-1 text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none min-w-0"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingNameInfo(false) }}
                />
                <button onClick={handleSaveName} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingNameInfo(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 inline-block ${EDITABLE}`}
                onClick={canEdit ? () => { setNameInput(lead.full_name || ''); setEditingNameInfo(true) } : undefined}
                title={canEdit ? t('pipeline.clickToEdit') : undefined}
              >
                {lead.full_name || '—'}
              </span>
            )}
          </div>

          {/* Company Name */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leadModal.companyName')}</div>
            {editingCompany ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={companyInput}
                  onChange={(e) => setCompanyInput(e.target.value)}
                  autoFocus
                  className="flex-1 text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none min-w-0"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCompany(); if (e.key === 'Escape') setEditingCompany(false) }}
                />
                <button onClick={handleSaveCompany} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingCompany(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 inline-block ${EDITABLE}`}
                onClick={canEdit ? () => { setCompanyInput(lead.company_name || ''); setEditingCompany(true) } : undefined}
                title={canEdit ? t('pipeline.clickToEdit') : undefined}
              >
                {lead.company_name || '—'}
              </span>
            )}
          </div>

          {/* Phone */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leadModal.phone')}</div>
            {editingPhone ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  autoFocus
                  className="flex-1 text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none min-w-0"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSavePhone(); if (e.key === 'Escape') setEditingPhone(false) }}
                />
                <button onClick={handleSavePhone} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingPhone(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 inline-block ${EDITABLE}`}
                onClick={canEdit ? () => { setPhoneInput(lead.phone || ''); setEditingPhone(true) } : undefined}
                title={canEdit ? t('pipeline.clickToEdit') : undefined}
              >
                {lead.phone ? <Ltr>{lead.phone}</Ltr> : '—'}
              </span>
            )}
          </div>

          {/* Email */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('common.email')}</div>
            {editingEmail ? (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  autoFocus
                  className="flex-1 text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none min-w-0"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEmail(); if (e.key === 'Escape') setEditingEmail(false) }}
                />
                <button onClick={handleSaveEmail} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingEmail(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 inline-block ${EDITABLE}`}
                onClick={canEdit ? () => { setEmailInput(lead.email || ''); setEditingEmail(true) } : undefined}
                title={canEdit ? t('pipeline.clickToEdit') : undefined}
              >
                {lead.email || '—'}
              </span>
            )}
          </div>

          {/* Source — pill with ring glow on hover */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leads.colSource')}</div>
            {editingSource ? (
              <div className="flex items-center gap-2 mt-1">
                <select
                  value={sourceInput}
                  onChange={(e) => setSourceInput(e.target.value)}
                  autoFocus
                  className="text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none flex-1 min-w-0"
                >
                  {LEAD_SOURCES.map((s) => (
                    <option key={s} value={s}>{t(`leadSource.${s.replace('-', '_')}`)}</option>
                  ))}
                </select>
                <button onClick={handleSaveSource} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingSource(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`inline-block mt-0.5 px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[lead.source] || SOURCE_BADGE['walk-in']} ${canEdit ? 'cursor-pointer hover:ring-2 hover:ring-indigo-300 dark:hover:ring-[#a5b4fc] hover:ring-offset-1 dark:hover:ring-offset-[#121823] transition-all' : ''}`}
                onClick={canEdit ? () => { setSourceInput(lead.source || 'walk-in'); setEditingSource(true) } : undefined}
                title={canEdit ? t('pipeline.clickToEdit') : undefined}
              >
                {t(`leadSource.${lead.source?.replace('-', '_')}`)}
              </span>
            )}
          </div>

          {/* Assigned Rep */}
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leads.colAssignedRep')}</div>
            {editingRep ? (
              <div className="flex items-center gap-2 mt-1">
                <select
                  value={repInput}
                  onChange={(e) => setRepInput(e.target.value)}
                  className="text-sm border border-indigo-500 dark:border-indigo-400 rounded px-2 py-1 dark:bg-[#0f1520] dark:text-[#e8ebf0] focus:outline-none flex-1 min-w-0"
                >
                  <option value="">{t('common.unassigned')}</option>
                  {salesReps.map((r) => (
                    <option key={r.user_email} value={r.user_email}>{r.user_email}</option>
                  ))}
                </select>
                <button onClick={handleSaveRep} className="text-xs text-indigo-600 dark:text-[#a5b4fc] font-medium hover:underline whitespace-nowrap">{t('common.save')}</button>
                <button onClick={() => setEditingRep(false)} className="text-xs text-gray-400 hover:underline">×</button>
              </div>
            ) : (
              <span
                className={`text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 inline-block ${EDITABLE}`}
                onClick={canEdit ? () => { setRepInput(lead.assigned_rep || ''); setEditingRep(true) } : undefined}
                title={canEdit ? t('pipeline.clickToEdit') : undefined}
              >
                {lead.assigned_rep || '—'}
              </span>
            )}
          </div>

          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('common.createdAt')}</div>
            <div className="text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5">
              {lead.created_at ? new Date(lead.created_at).toLocaleString() : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('common.createdBy')}</div>
            <div className="text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5">{lead.created_by || '—'}</div>
          </div>

          {/* Linked deal */}
          {linkedDeal && (
            <div className="pt-3 border-t border-[#e6e9ef] dark:border-[#212a38]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('leads.linkedDeal')}</span>
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${DEAL_STATUS_BADGE[linkedDeal.status] || DEAL_STATUS_BADGE.open}`}>
                  {t(`pipeline.${linkedDeal.status}`)}
                </span>
              </div>
              <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{linkedDeal.title}</p>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                {linkedDealStageName}
                {linkedDeal.value != null && ` · ${Number(linkedDeal.value).toLocaleString()} ${t('pipeline.currency')}`}
              </p>
              <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={() => navigate(`/pipeline/${linkedDeal.id}`)}>
                {t('leads.viewDeal')}
              </Button>
            </div>
          )}
        </div>

        {/* Center: tab bar */}
        <div className={`${CARD} lg:col-span-2 !p-0 overflow-hidden`}>
          <div className="flex border-b border-[#e6e9ef] dark:border-[#212a38] px-2 overflow-x-auto">
            <button onClick={() => setTab('note')} className={TAB_CLS(tab === 'note')}>
              {t('leads.leadLog')}
            </button>
            <button onClick={() => setTab('activity')} className={TAB_CLS(tab === 'activity')}>
              {t('activityChatter.scheduleActivity')}
            </button>
            <button onClick={() => setTab('lead_notes')} className={TAB_CLS(tab === 'lead_notes')}>
              {t('leads.leadNotesTab')}
            </button>
          </div>

          <div className="p-[18px]">
            {(tab === 'note' || tab === 'activity') && (
              <ActivityChatter
                relatedType="lead"
                relatedId={lead.id}
                currentUserEmail={currentUserEmail}
                salesReps={salesReps}
                canEdit={canDo('edit') || canDo('create')}
                controlledTab={tab}
                onControlledTabChange={setTab}
                hideNoteComposer
                hideHistory={tab === 'activity'}
              />
            )}

            {tab === 'lead_notes' && (
              <div className="space-y-3">
                <textarea
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  placeholder={t('leads.leadNotesPlaceholder')}
                  rows={10}
                  className="w-full px-3 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-xl text-sm bg-[#f8f9fb] dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0] placeholder-gray-400 dark:placeholder-[#4a5568] focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none resize-none"
                />
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSaveNotes} loading={savingNotes} disabled={!canEdit}>
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Comment Panel */}
        <div className="lg:col-span-1 h-full">
          <CommentPanel
            relatedType="lead"
            relatedId={lead.id}
            currentUserEmail={currentUserEmail}
            canEdit={canDo('edit') || canDo('create')}
          />
        </div>
      </div>

      {showConvert && (
        <ConvertLeadModal
          lead={lead}
          stages={
            pipelines[0]?.stages
              ? [...pipelines[0].stages].sort((a, b) => a.order - b.order).filter((s) => !s.is_won && !s.is_lost)
              : []
          }
          form={convertForm}
          setForm={setConvertForm}
          onConvert={handleConvert}
          onClose={() => setShowConvert(false)}
        />
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </div>
  )
}
