import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { ModalOverlay, ModalCard, Input, Select, Textarea, Label, Button } from '../../components/ui'
import { LEAD_SOURCE_LIST, LEAD_STATUS_LIST } from '../../lib/constants'

const CARD = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38]'
const HEADER = 'border-b border-[#e6e9ef] dark:border-[#212a38]'
const TITLE = 'text-[#211f1b] dark:text-[#e8ebf0]'
const CLOSE_BTN =
  'w-8 h-8 flex items-center justify-center rounded-full text-[#6c6760] dark:text-[#9aa4b2] hover:bg-gray-100 dark:hover:bg-[#1a2230] transition-colors'

function Field({ label, required, children }) {
  return (
    <div>
      <Label required={required} className="dark:text-[#e8ebf0]">
        {label}
      </Label>
      {children}
    </div>
  )
}

// ─── CREATE / EDIT LEAD MODAL ───────────────────────────────────────────────

export function CreateLeadModal({ form, setForm, editing, leadCode, salesReps, onSave, onClose }) {
  const { t } = useTranslation()
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={editing ? t('leadModal.editTitle') : t('leadModal.addTitle')}
        className={`${CARD} max-w-lg my-8`}
      >
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <div>
            <h2 className={`text-xl font-bold ${TITLE}`}>
              {editing ? t('leadModal.editTitle') : t('leadModal.addTitle')}
            </h2>
            {leadCode && (
              <span className="text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded mt-1 inline-block">
                {leadCode}
              </span>
            )}
          </div>
          <button onClick={onClose} className={CLOSE_BTN} aria-label={t('common.close')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label={t('leadModal.fullName')} required>
            <Input
              value={form.full_name}
              onChange={(e) => set('full_name', e.target.value)}
              placeholder={t('leadModal.fullNamePlaceholder')}
            />
          </Field>

          <Field label={t('leadModal.companyName')} required>
            <Input
              value={form.company_name}
              onChange={(e) => set('company_name', e.target.value)}
              placeholder={t('leadModal.companyPlaceholder')}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('leadModal.phone')} required>
              <Input
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder={t('leadModal.phonePlaceholder')}
              />
            </Field>
            <Field label={t('common.email')}>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value)}
                placeholder={t('leadModal.emailPlaceholder')}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('leadModal.source')} required>
              <Select value={form.source} onChange={(e) => set('source', e.target.value)}>
                {LEAD_SOURCE_LIST.map((s) => (
                  <option key={s} value={s}>
                    {t(`leadSource.${s.replace('-', '_')}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('common.status')}>
              <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
                {LEAD_STATUS_LIST.filter((s) => s !== 'converted').map((s) => (
                  <option key={s} value={s}>
                    {t(`leadStatus.${s}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={t('leadModal.assignRep')}>
            <Select value={form.assigned_rep} onChange={(e) => set('assigned_rep', e.target.value)}>
              <option value="">{t('leadModal.unassigned')}</option>
              {salesReps.map((r) => (
                <option key={r.user_email} value={r.user_email}>
                  {r.user_email}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('common.notes')}>
            <Textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              placeholder={t('leadModal.notesPlaceholder')}
            />
          </Field>

        </div>

        <div className={`flex items-center justify-end gap-3 px-6 py-4 ${HEADER} border-t`}>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave}>{editing ? t('common.saveChanges') : t('leadModal.createLead')}</Button>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ─── CONVERT LEAD TO DEAL MODAL ─────────────────────────────────────────────

export function ConvertLeadModal({ lead, stages = [], form, setForm, onConvert, onClose }) {
  const { t } = useTranslation()
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('leadModal.convertTitle')} className={`${CARD} max-w-md my-8`}>
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <div>
            <h2 className={`text-xl font-bold ${TITLE}`}>{t('leadModal.convertTitle')}</h2>
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">
              {t('leadModal.convertSubtitle', { name: lead.full_name })}
            </p>
          </div>
          <button onClick={onClose} className={CLOSE_BTN} aria-label={t('common.close')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <Field label={t('leadModal.dealTitle')} required>
            <Input
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder={t('leadModal.dealTitlePlaceholder')}
            />
          </Field>

          {stages.length > 0 && (
            <Field label={t('pipeline.stage')} required>
              <Select value={form.stage_id} onChange={(e) => set('stage_id', e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
          )}

          <Field label={t('leadModal.dealValue')}>
            <Input
              type="number"
              min="0"
              value={form.value}
              onChange={(e) => set('value', e.target.value)}
              placeholder="0"
            />
          </Field>

          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('leadModal.convertNote')}</p>
        </div>

        <div className={`flex items-center justify-end gap-3 px-6 py-4 ${HEADER} border-t`}>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="success" onClick={onConvert}>
            {t('leadModal.convertButton')}
          </Button>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ─── BULK UPLOAD LEADS MODAL ─────────────────────────────────────────────────

export function BulkUploadLeadsModal({ onClose, onUpload, onDownloadTemplate }) {
  const { t } = useTranslation()
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  const handleFileChange = (e) => {
    const selected = e.target.files[0]
    if (selected) {
      if (!selected.name.endsWith('.csv')) {
        toast.error(t('leadModal.selectCsvFile'))
        return
      }
      setFile(selected)
    }
  }

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('leadModal.selectFileFirst'))
      return
    }
    setUploading(true)
    try {
      await onUpload(file)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overscroll-contain">
      <div className="bg-white dark:bg-[#121823] rounded-xl shadow-xl w-full max-w-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-[#212a38]">
          <h2 className="text-xl font-bold text-gray-900 dark:text-[#e8ebf0]">{t('leadModal.bulkUploadTitle')}</h2>
          <button onClick={onClose} className="text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:hover:text-[#e8ebf0]">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Instructions */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <h3 className="font-medium text-blue-900 dark:text-blue-300 mb-2">📋 {t('leadModal.instructions')}</h3>
            <ul className="text-sm text-blue-800 dark:text-blue-400 space-y-1 list-disc list-inside">
              <li>{t('leadModal.bulkInst1')}</li>
              <li>{t('leadModal.bulkInst2')}</li>
              <li>{t('leadModal.bulkInst3')}</li>
              <li>{t('leadModal.bulkInst4')}</li>
              <li>{t('leadModal.bulkInst5')}</li>
              <li>{t('leadModal.bulkInst6')}</li>
              <li>{t('leadModal.bulkInst7')}</li>
            </ul>
          </div>

          {/* Download template */}
          <button
            onClick={onDownloadTemplate}
            className="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center justify-center gap-2 font-medium"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {t('leadModal.downloadTemplate')}
          </button>

          {/* Drop zone */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#9aa4b2] mb-2">
              {t('leadModal.uploadCSVLabel')}
            </label>
            <label className="border-2 border-dashed border-gray-300 dark:border-[#212a38] rounded-lg p-8 text-center cursor-pointer hover:border-indigo-500 dark:hover:border-[#a5b4fc] transition-colors block">
              {file ? (
                <div className="space-y-2">
                  <svg className="w-12 h-12 text-green-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="font-medium text-gray-900 dark:text-[#e8ebf0]">{file.name}</p>
                  <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{(file.size / 1024).toFixed(2)} KB</p>
                  <p className="text-xs text-indigo-600 dark:text-[#a5b4fc]">{t('leadModal.clickToChangeFile')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <svg className="w-12 h-12 text-gray-400 dark:text-[#4a5568] mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  <p className="text-gray-600 dark:text-[#9aa4b2]">{t('leadModal.clickToUploadCSV')}</p>
                  <p className="text-sm text-gray-500 dark:text-[#4a5568]">{t('leadModal.dragAndDrop')}</p>
                </div>
              )}
              <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
            </label>
          </div>

          {file && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3 text-sm text-yellow-800 dark:text-yellow-300">
              ⚠️ {t('leadModal.bulkUploadWarning')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 border-t border-gray-200 dark:border-[#212a38]">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button className="flex-1 justify-center" onClick={handleUpload} disabled={!file} loading={uploading}>
            {!uploading && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {uploading ? t('common.loading') : t('leadModal.uploadBtn')}
          </Button>
        </div>
      </div>
    </div>
  )
}
