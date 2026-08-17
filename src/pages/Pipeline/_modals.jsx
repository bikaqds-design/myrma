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

export function CreateDealModal({ form, setForm, dealCode, customers, contacts = [], pipeline, pipelines = [], salesReps, editing, hasProductLines, onSave, onClose }) {
  const { t } = useTranslation()
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  const openStages = (p) =>
    p ? [...p.stages].sort((a, b) => a.order - b.order).filter((s) => !s.is_won && !s.is_lost) : []

  // In edit mode the form's pipeline_id can differ from the deal's current one.
  const selectedPipeline = pipelines.find((p) => p.id === form.pipeline_id) ?? pipeline
  const stages = openStages(selectedPipeline)

  // Stages belong to a pipeline, so moving pipelines invalidates the deal's stage.
  // Surface the stage picker (normally hidden when editing) only for that case.
  const pipelineChanged = !!editing && !!pipeline && form.pipeline_id !== pipeline.id

  const changePipeline = (nextId) => {
    const next = pipelines.find((p) => p.id === nextId)
    const backToOriginal = nextId === pipeline?.id
    setForm((prev) => ({
      ...prev,
      pipeline_id: nextId,
      // Default to the destination's first open stage so the deal is never left on
      // a stage that doesn't exist in its pipeline; switching back restores the
      // stage the deal actually had.
      stage: (backToOriginal ? editing?.stage : null) ?? openStages(next)[0]?.id ?? '',
    }))
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={editing ? t('pipeline.editDeal') : t('pipeline.createDeal')} className={`${CARD} max-w-lg my-8`}>
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <div>
            <h2 className={`text-xl font-bold ${TITLE}`}>{editing ? t('pipeline.editDeal') : t('pipeline.createDeal')}</h2>
            {!editing && dealCode && (
              <span className="text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded mt-1 inline-block">
                {dealCode}
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
          <Field label={t('pipeline.dealTitle')} required>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder={t('leadModal.dealTitlePlaceholder')} />
          </Field>

          <Field label={t('pipeline.customer')} required>
            <CustomerSearchField
              customers={customers}
              value={form.customer_id}
              label={form.customer_label}
              onSelect={(c) => {
                set('customer_id', c ? c.id : '')
                set('customer_label', c ? c.company_name || c.contact_person : '')
                // Contacts belong to a customer — a stale contact_id from the previous
                // customer would point at someone unrelated to the new one.
                set('contact_id', '')
              }}
            />
          </Field>

          {/* Only shown when the selected customer actually has contacts — the create
              flow passes none, and a dropdown whose only option is "No contact" is noise. */}
          {contacts.length > 0 && (
            <Field label={t('customers.contactPerson')}>
              <Select value={form.contact_id || ''} onChange={(e) => set('contact_id', e.target.value)}>
                <option value="">{t('pipeline.noContact')}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}{c.title ? ` · ${c.title}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* Pipeline is editable, but only via a deliberate remap — see below. */}
          {editing && pipelines.length > 1 && (
            <Field label={t('pipeline.pipelineLabel')} required>
              <Select value={form.pipeline_id} onChange={(e) => changePipeline(e.target.value)}>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* Stage: always on create; on edit only when the pipeline was changed, since
              the deal's old stage does not exist in the destination pipeline. */}
          {(!editing || pipelineChanged) && (
            <Field label={t('pipeline.stage')} required>
              <Select value={form.stage} onChange={(e) => set('stage', e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              {pipelineChanged && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  {t('pipeline.pipelineChangeStageHint')}
                </p>
              )}
            </Field>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('leadModal.dealValue')}>
              {hasProductLines ? (
                <div>
                  <Input type="number" value={form.value} disabled className="opacity-50 cursor-not-allowed" />
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">{t('pipeline.valueLocked')}</p>
                </div>
              ) : (
                <Input type="number" min="0" value={form.value} onChange={(e) => set('value', e.target.value)} placeholder="0" />
              )}
            </Field>
            <Field label={t('pipeline.expectedCloseDate')}>
              <Input type="date" value={form.expected_close_date} onChange={(e) => set('expected_close_date', e.target.value)} />
            </Field>
          </div>

          <Field label={`${t('pipeline.probability')} — ${form.probability ?? 0}%`}>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={form.probability ?? 0}
              onChange={(e) => set('probability', Number(e.target.value))}
              className="w-full accent-indigo-600 dark:accent-[#a5b4fc] h-2 cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-400 dark:text-[#768292] mt-0.5">
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
          </Field>

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

// ─── REOPEN DEAL MODAL ──────────────────────────────────────────────────────

export function ReopenDealModal({ deal, stages, onConfirm, onClose }) {
  const { t } = useTranslation()
  const [stageId, setStageId] = useState('')

  const openStages = stages.filter((s) => !s.is_won && !s.is_lost)

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('pipeline.reopenDeal')} className={`${CARD} max-w-md my-8`}>
        <div className={`flex items-center justify-between px-6 py-5 ${HEADER}`}>
          <div>
            <h2 className={`text-xl font-bold ${TITLE}`}>{t('pipeline.reopenDeal')}</h2>
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{deal?.title}</p>
          </div>
          <button onClick={onClose} className={CLOSE_BTN} aria-label={t('common.close')}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">
          <Field label={t('pipeline.reopenSelectStage')} required>
            <Select value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">{t('pipeline.reopenStagePlaceholder')}</option>
              {openStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className={`flex items-center justify-end gap-3 px-6 py-4 ${HEADER} border-t`}>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onConfirm(stageId)} disabled={!stageId}>
            {t('pipeline.reopenDeal')}
          </Button>
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
