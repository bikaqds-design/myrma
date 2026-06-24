import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import { Button } from '../../components/ui'
import EmptyState from '../../components/EmptyState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { leadSchema, getFirstError } from '../../lib/schemas'
import { LEAD_STATUS_LIST } from '../../lib/constants'
import { EMPTY_FORM, EMPTY_CONVERT_FORM } from './_constants'
import { CreateLeadModal, ConvertLeadModal } from './_modals'
import { ActivityChatter } from '../../components/ActivityChatter'

const STATUS_BADGE = {
  new: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  contacted: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  qualified: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  nurturing: 'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  inactive: 'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400',
  converted: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
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
  won: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  lost: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
}

const CARD = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]'

function Detail({ label, value }) {
  return (
    <div>
      <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase">{label}</div>
      <div className="text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5">{value || '—'}</div>
    </div>
  )
}

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
  const salesReps = usersList.filter((u) => u.role === 'sales_rep' || u.role === 'manager')

  // Surface the linked deal directly on the lead — only fetched once the
  // lead has actually been converted (converted_deal_id set).
  const { data: linkedDeal } = useQuery({
    queryKey: ['deal', lead?.converted_deal_id],
    queryFn: () => db.deals.get(lead.converted_deal_id),
    enabled: !!lead?.converted_deal_id,
  })
  const linkedDealPipeline = pipelines.find((p) => p.id === linkedDeal?.pipeline_id)
  const linkedDealStageName = linkedDealPipeline?.stages.find((s) => s.id === linkedDeal?.stage)?.name ?? linkedDeal?.stage

  const [showEdit, setShowEdit] = useState(false)
  const [leadForm, setLeadForm] = useState(EMPTY_FORM)
  const [showConvert, setShowConvert] = useState(false)
  const [convertForm, setConvertForm] = useState(EMPTY_CONVERT_FORM)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })

  const canDo = (action) => {
    if (currentUserRole === 'super_admin' || currentUserRole === 'admin') return true
    return currentUserPermissions?.leads?.[action] === true
  }

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['lead', leadId] })
    queryClient.invalidateQueries({ queryKey: ['leads'] })
  }

  const inlineStatusList = LEAD_STATUS_LIST.filter((s) => s !== 'converted')
  const isConverted = lead?.status === 'converted'
  const canEdit = canDo('edit') && !isConverted

  const handleStatusChange = async (newStatus) => {
    if (!lead || lead.status === newStatus) return
    try {
      await db.leads.updateStatus(lead.id, newStatus, currentUserEmail)
      toast.success(t('leads.statusUpdated'))
      db.auditLog.log(currentUserEmail, 'lead_status_changed', `Lead ${lead.full_name}: ${lead.status} → ${newStatus}`).catch(() => {})
      refresh()
      queryClient.invalidateQueries({ queryKey: ['activities', 'lead', leadId] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleOpenEdit = () => {
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
    setShowEdit(true)
  }

  const handleSaveLead = async () => {
    const validation = leadSchema.safeParse(leadForm)
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }
    const statusChanged = lead.status !== leadForm.status
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
      await db.leads.update(lead.id, payload)
      if (statusChanged) {
        db.activities
          .logSystem('lead', lead.id, `status_changed|${lead.status}|${leadForm.status}`, currentUserEmail)
          .catch(() => {})
      }
      toast.success(t('leads.leadUpdated'))
      setShowEdit(false)
      refresh()
      queryClient.invalidateQueries({ queryKey: ['activities', 'lead', leadId] })
    } catch (error) {
      toast.error(t('leads.failedSave', { error: error.message }))
    }
  }

  const handleOpenConvert = () => {
    setConvertForm({ ...EMPTY_CONVERT_FORM, title: `${lead.full_name} — ${t('leadModal.dealTitle')}` })
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
      queryClient.invalidateQueries({ queryKey: ['activities', 'lead', leadId] })
    } catch (error) {
      toast.error(t('leads.failedConvert', { error: error.message }))
    }
  }

  const handleDisqualify = () => {
    setConfirmDialog({
      open: true,
      title: t('leads.deleteLeadTitle'),
      message: t('leads.deleteLeadConfirm', { name: lead.full_name }),
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
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Back + actions */}
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="text-sm text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 flex items-center gap-1">
          ← {t('common.back')}
        </button>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={handleOpenEdit}>
              {t('common.edit')}
            </Button>
          )}
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

      {/* Header */}
      <div className={`${CARD} mb-4`}>
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-[#e8ebf0]">{lead.company_name || lead.full_name}</h1>
            {lead.company_name && (
              <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">{t('leadModal.fullName')}: {lead.full_name}</p>
            )}
          </div>
          {isConverted ? (
            <span className={`px-3 py-1 text-sm rounded-full font-medium ${STATUS_BADGE.converted}`}>{t('leadStatus.converted')}</span>
          ) : null}
        </div>

        {/* Status stepper — click to change status directly */}
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

      {/* Details grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 space-y-4">
          <div className={`${CARD} space-y-4`}>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('leads.colContact')}</h3>
            <Detail label={t('leadModal.phone')} value={lead.phone} />
            <Detail label={t('common.email')} value={lead.email} />
            <div>
              <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase">{t('leads.colSource')}</div>
              <span className={`inline-block mt-0.5 px-2 py-0.5 text-xs rounded-full font-medium ${SOURCE_BADGE[lead.source] || SOURCE_BADGE['walk-in']}`}>
                {t(`leadSource.${lead.source?.replace('-', '_')}`)}
              </span>
            </div>
            <Detail label={t('leads.colAssignedRep')} value={lead.assigned_rep} />
            <Detail label={t('common.createdAt')} value={lead.created_at ? new Date(lead.created_at).toLocaleString() : null} />
            <Detail label={t('common.createdBy')} value={lead.created_by} />
            {lead.notes && (
              <div>
                <div className="text-xs text-gray-500 dark:text-[#9aa4b2] uppercase">{t('common.notes')}</div>
                <p className="text-sm text-gray-900 dark:text-[#e8ebf0] mt-0.5 whitespace-pre-wrap">{lead.notes}</p>
              </div>
            )}
          </div>

          {linkedDeal && (
            <div className={CARD}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{t('leads.linkedDeal')}</h3>
                <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${DEAL_STATUS_BADGE[linkedDeal.status] || DEAL_STATUS_BADGE.open}`}>
                  {t(`pipeline.${linkedDeal.status}`)}
                </span>
              </div>
              <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0]">{linkedDeal.title}</p>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
                {linkedDealStageName}
                {linkedDeal.value != null && ` · ${Number(linkedDeal.value).toLocaleString()} ${t('pipeline.currency')}`}
              </p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate(`/pipeline/${linkedDeal.id}`)}>
                {t('leads.viewDeal')}
              </Button>
            </div>
          )}
        </div>

        {/* Chatter */}
        <div className={`${CARD} lg:col-span-2`}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] mb-3">{t('leads.comments')}</h3>
          <ActivityChatter
            relatedType="lead"
            relatedId={lead.id}
            currentUserEmail={currentUserEmail}
            salesReps={salesReps}
            canEdit={canDo('edit') || canDo('create')}
          />
        </div>
      </div>

      {showEdit && (
        <CreateLeadModal
          form={leadForm}
          setForm={setLeadForm}
          editing={lead}
          salesReps={salesReps}
          onSave={handleSaveLead}
          onClose={() => setShowEdit(false)}
        />
      )}

      {showConvert && (
        <ConvertLeadModal
          lead={lead}
          pipelines={pipelines}
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
