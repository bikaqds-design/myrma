import React from 'react'
import { useTranslation } from 'react-i18next'
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

export function CreateLeadModal({ form, setForm, editing, salesReps, onSave, onClose }) {
  const { t } = useTranslation()
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard
        aria-label={editing ? t('leadModal.editTitle') : t('leadModal.addTitle')}
        className={`${CARD} max-w-lg my-8`}
      >
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <h2 className={`text-xl font-bold ${TITLE}`}>
            {editing ? t('leadModal.editTitle') : t('leadModal.addTitle')}
          </h2>
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

          <Field label={t('leadModal.companyName')}>
            <Input
              value={form.company_name}
              onChange={(e) => set('company_name', e.target.value)}
              placeholder={t('leadModal.companyPlaceholder')}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('leadModal.phone')}>
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
            {editing && (
              <Field label={t('common.status')}>
                <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
                  {LEAD_STATUS_LIST.filter((s) => s !== 'converted').map((s) => (
                    <option key={s} value={s}>
                      {t(`leadStatus.${s}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
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

          {!form.phone && !form.email && (
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <span>⚠️</span>
              {t('leadModal.noContactWarning')}
            </p>
          )}
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

export function ConvertLeadModal({ lead, pipelines, form, setForm, onConvert, onClose }) {
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

          <Field label={t('leadModal.pipeline')} required>
            <Select value={form.pipeline_id} onChange={(e) => set('pipeline_id', e.target.value)}>
              <option value="">{t('leadModal.selectPipeline')}</option>
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>

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
