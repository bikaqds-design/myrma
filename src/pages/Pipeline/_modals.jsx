import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay, ModalCard, Input, Select, Textarea, Label, Button } from '../../components/ui'

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

// ─── CUSTOMER SEARCH INPUT (lightweight — top 8 matches, no virtualization) ──

function CustomerSearchField({ customers, value, label, onSelect }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState(label || '')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => setQuery(label || ''), [label])

  useEffect(() => {
    const handler = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const matches = !query.trim()
    ? []
    : customers
        .filter((c) => {
          const q = query.toLowerCase()
          return (
            c.contact_person?.toLowerCase().includes(q) ||
            c.company_name?.toLowerCase().includes(q) ||
            c.mobile?.includes(q)
          )
        })
        .slice(0, 8)

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          onSelect(null)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Typing alone never sets a customer_id — only clicking a suggestion
          // does. Without this, the field can show typed text that LOOKS
          // filled while the form's customer_id is still empty, only
          // surfacing as a confusing "Title and customer are required" error
          // on save. Revert to empty so the field's visual state always
          // matches whether a real customer is actually selected.
          if (!value) setQuery('')
        }}
        placeholder={t('pipeline.customerSearchPlaceholder')}
        className={!value && query.trim() ? 'border-red-300 dark:border-red-900/50 focus:ring-red-400' : ''}
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(c)
                setQuery(c.company_name || c.contact_person)
                setOpen(false)
              }}
              className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-[#1a2230] text-gray-800 dark:text-[#e8ebf0]"
            >
              <div className="font-medium">{c.company_name || c.contact_person}</div>
              {c.company_name && <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{c.contact_person}</div>}
            </button>
          ))}
        </div>
      )}
      {open && query.trim() && matches.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">{t('pipeline.noCustomerMatches')}</p>
      )}
      {!value && query.trim() && !open && (
        <p className="text-xs text-red-500 dark:text-red-400 mt-1">{t('pipeline.customerNotSelected')}</p>
      )}
      {value && !open && (
        <p className="text-xs text-green-600 dark:text-green-400 mt-1">{t('pipeline.customerSelected')}</p>
      )}
    </div>
  )
}

// ─── CREATE DEAL MODAL ──────────────────────────────────────────────────────

export function CreateDealModal({ form, setForm, customers, pipelines, salesReps, editing, onSave, onClose }) {
  const { t } = useTranslation()
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  const selectedPipeline = pipelines.find((p) => p.id === form.pipeline_id)
  const stages = selectedPipeline ? [...selectedPipeline.stages].sort((a, b) => a.order - b.order) : []

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={editing ? t('pipeline.editDeal') : t('pipeline.createDeal')} className={`${CARD} max-w-lg my-8`}>
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <h2 className={`text-xl font-bold ${TITLE}`}>{editing ? t('pipeline.editDeal') : t('pipeline.createDeal')}</h2>
          <button onClick={onClose} className={CLOSE_BTN} aria-label={t('common.close')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label={t('pipeline.dealTitle')} required>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={t('leadModal.dealTitlePlaceholder')} />
          </Field>

          <Field label={t('pipeline.customer')} required>
            {editing ? (
              <p className="text-sm text-gray-700 dark:text-[#e8ebf0] py-2">{form.customer_label}</p>
            ) : (
              <CustomerSearchField
                customers={customers}
                value={form.customer_id}
                label={form.customer_label}
                onSelect={(c) => {
                  set('customer_id', c ? c.id : '')
                  set('customer_label', c ? c.company_name || c.contact_person : '')
                }}
              />
            )}
          </Field>

          {!editing && (
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('leadModal.pipeline')} required>
                <Select
                  value={form.pipeline_id}
                  onChange={(e) => {
                    const pl = pipelines.find((p) => p.id === e.target.value)
                    const firstStage = pl ? [...pl.stages].sort((a, b) => a.order - b.order)[0] : null
                    set('pipeline_id', e.target.value)
                    set('stage', firstStage ? firstStage.id : '')
                  }}
                >
                  <option value="">{t('leadModal.selectPipeline')}</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('common.status')} required>
                <Select value={form.stage} onChange={(e) => set('stage', e.target.value)} disabled={!selectedPipeline}>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('leadModal.dealValue')}>
              <Input type="number" min="0" value={form.value} onChange={(e) => set('value', e.target.value)} placeholder="0" />
            </Field>
            <Field label={t('pipeline.expectedCloseDate')}>
              <Input type="date" value={form.expected_close_date} onChange={(e) => set('expected_close_date', e.target.value)} />
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
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} />
          </Field>
        </div>

        <div className={`flex items-center justify-end gap-3 px-6 py-4 ${HEADER} border-t`}>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave}>{editing ? t('common.saveChanges') : t('pipeline.createDeal')}</Button>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ─── MARK LOST MODAL ────────────────────────────────────────────────────────

export function MarkLostModal({ deal, form, setForm, onConfirm, onClose }) {
  const { t } = useTranslation()

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('pipeline.markLost')} className={`${CARD} max-w-md my-8`}>
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <div>
            <h2 className={`text-xl font-bold ${TITLE}`}>{t('pipeline.markLost')}</h2>
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{deal?.title}</p>
          </div>
          <button onClick={onClose} className={CLOSE_BTN} aria-label={t('common.close')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">
          <Field label={t('pipeline.lostReason')} required>
            <Textarea
              value={form.reason}
              onChange={(e) => setForm({ reason: e.target.value })}
              rows={3}
              placeholder={t('pipeline.lostReasonPlaceholder')}
            />
          </Field>
        </div>

        <div className={`flex items-center justify-end gap-3 px-6 py-4 ${HEADER} border-t`}>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!form.reason.trim()}>
            {t('pipeline.markLost')}
          </Button>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
