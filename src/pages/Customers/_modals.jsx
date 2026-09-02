import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PhoneNote, EmailNote } from '../../components/ContactValidation'
import { useContactValidation } from '../../hooks/useContactValidation'
import { useCountryOptions } from '../../hooks/useCountryRules'
import toast from 'react-hot-toast'
import AttachmentsField from '../../components/AttachmentsField'
import { Button } from '../../components/ui'
import { associateFieldId } from '../../lib/fieldAssociation'

// ─── SHARED HELPERS ────────────────────────────────────────────────────────────

const Req = () => <span className="text-red-500 ml-0.5">*</span>
const inp =
  'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none'
const sel =
  'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white'

/**
 * A labelled form field.
 *
 * The <label> and the control are siblings, not nested, so there was no
 * implicit association and no htmlFor either: a screen reader announced an
 * unlabelled textbox sitting next to some loose text. The visible label was
 * right there, which is why this survived a long time.
 *
 * The id is generated with useId() and cloned onto the child, so callers get
 * the association for free and cannot forget it. A caller that sets its own id
 * keeps it. htmlFor is only emitted when there is a single element child to
 * carry the id — a label pointing at an id that does not exist is worse than
 * no label at all.
 */
export function Field({ label, required, children }) {
  const { htmlFor, children: kids } = associateFieldId(children, React.useId())
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
        {required && <Req />}
      </label>
      {kids}
    </div>
  )
}

// ─── ADD / EDIT CUSTOMER MODAL ──────────────────────────────────────────────

export function AddCustomerModal({
  form,
  setForm,
  editing,
  usersList,
  pendingFiles,
  setPendingFiles,
  onSave,
  onClose,
}) {
  const { t } = useTranslation()
  const isB2B = form.customer_type === 'B2B'
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  // A new customer must comply; an existing one is warned and saved anyway.
  // Blocking every edit on a number typed before the rules existed would stop
  // someone updating an address, with no way forward but to invent a number.
  const countries = useCountryOptions()
  const contact = useContactValidation({
    mobile: form.mobile,
    landline: form.landline,
    email: form.email,
    countryCode: form.country_code,
    editing,
  })

  return (
    <div className="modal-overlay-bg fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto overscroll-contain">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              {editing ? t('customerModal.editTitle') : t('customerModal.addTitle')}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="text-red-500">*</span> {t('customerModal.requiredFields')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {/* Type + Status */}
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('customerModal.customerType')} required>
              <select
                value={form.customer_type}
                onChange={(e) => set('customer_type', e.target.value)}
                className={sel}
              >
                <option value="B2B">{t('customerModal.typeB2B')}</option>
                <option value="B2C">{t('customerModal.typeB2C')}</option>
              </select>
            </Field>
            <Field label={t('customerModal.status')}>
              <select
                value={form.customer_status}
                onChange={(e) => set('customer_status', e.target.value)}
                className={sel}
              >
                <option value="Active">{t('customerModal.statusActive')}</option>
                <option value="Inactive">{t('customerModal.statusInactive')}</option>
                <option value="Suspended">{t('customerModal.statusSuspended')}</option>
                <option value="VIP">{t('customerModal.statusVIP')}</option>
              </select>
            </Field>
          </div>

          {/* Company Name — B2B only */}
          {isB2B && (
            <Field label={t('customerModal.companyName')} required>
              <input
                type="text"
                value={form.company_name}
                onChange={(e) => set('company_name', e.target.value)}
                className={inp}
                placeholder={t('customerModal.companyPlaceholder')}
              />
            </Field>
          )}

          {/* Contact Person + Account Manager */}
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('customerModal.contactPerson')} required>
              <input
                type="text"
                value={form.contact_person}
                onChange={(e) => set('contact_person', e.target.value)}
                className={inp}
                placeholder={t('customerModal.contactPlaceholder')}
              />
            </Field>
            <Field label={t('customerModal.accountManager')}>
              <select
                value={form.account_manager}
                onChange={(e) => set('account_manager', e.target.value)}
                className={sel}
              >
                <option value="">{t('customerModal.selectManager')}</option>
                {usersList.map((u) => (
                  <option key={u.user_email} value={u.user_email}>
                    {u.user_email}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Country override — blank means the system default, which is
              what almost every record uses. Only shown when more than one
              country is configured, so a single-country install never sees a
              field with one option. */}
          {countries.length > 1 && (
            <Field label={t('customerModal.country')}>
              <select
                value={form.country_code || ''}
                onChange={(e) => set('country_code', e.target.value || null)}
                className={inp}
              >
                <option value="">{t('customerModal.countryDefault')}</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name} ({c.dial_code})
                  </option>
                ))}
              </select>
            </Field>
          )}

          {/* Mobile + Landline */}
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('customerModal.mobile')} required>
              <input
                type="tel"
                value={form.mobile}
                onChange={(e) => set('mobile', e.target.value)}
                className={inp}
                placeholder={contact.rules ? `${contact.rules.dialCode} …` : '+20 XXX XXX XXXX'}
              />
              <PhoneNote result={contact.mobileResult} editing={editing} />
            </Field>
            <Field label={t('customerModal.landline')}>
              <input
                type="tel"
                value={form.landline}
                onChange={(e) => set('landline', e.target.value)}
                className={inp}
                placeholder={contact.rules ? `${contact.rules.dialCode} …` : '+2 0X XXXX XXXX'}
              />
              <PhoneNote result={contact.landlineResult} editing={editing} />
            </Field>
          </div>

          {/* Email */}
          <Field label={t('customerModal.email')}>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              className={inp}
              placeholder="email@example.com"
            />
            {/* A suggestion with a one-click fix, never a refusal. */}
            <EmailNote
              result={contact.emailResult}
              onAccept={(domain) =>
                set('email', `${String(form.email).split('@')[0]}@${domain}`)
              }
            />
          </Field>

          {/* Address */}
          <Field label={t('customerModal.address')}>
            <textarea
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
              rows={3}
              className={inp}
              placeholder={t('customerModal.addressPlaceholder')}
            />
          </Field>

          {/* CR Number + Tax ID — B2B only */}
          {isB2B && (
            <div className="grid grid-cols-2 gap-4">
              <Field label={t('customerModal.crNumber')}>
                <input
                  type="text"
                  value={form.cr_number}
                  onChange={(e) => set('cr_number', e.target.value)}
                  className={inp}
                  placeholder={t('customerModal.crPlaceholder')}
                />
              </Field>
              <Field label={t('customerModal.taxId')}>
                <input
                  type="text"
                  value={form.tax_id}
                  onChange={(e) => set('tax_id', e.target.value)}
                  className={inp}
                  placeholder={t('customerModal.taxIdPlaceholder')}
                />
              </Field>
            </div>
          )}

          {/* Notes */}
          <Field label={t('customerModal.notes')}>
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              className={inp}
              placeholder={t('customerModal.notesPlaceholder')}
            />
          </Field>

          {/* Attachments */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {t('customerModal.attachments')}
            </label>
            <AttachmentsField
              savedAttachments={form.attachments || []}
              onSavedChange={(val) => set('attachments', val)}
              pendingFiles={pendingFiles}
              onPendingChange={setPendingFiles}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {/* Blocked only on a NEW record with a real format problem. An
              existing record saves with a warning, so nobody is stopped from
              editing a customer because of a number typed before the rules
              existed. */}
          <Button
            className="flex-1 justify-center"
            onClick={onSave}
            disabled={contact.blocking}
            title={contact.blocking ? t('phone.fixBeforeSaving') : undefined}
          >
            {editing ? t('customerModal.updateCustomer') : t('customerModal.createCustomer')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── BULK UPLOAD CUSTOMERS MODAL ────────────────────────────────────────────

export function BulkUploadCustomersModal({ onClose, onUpload, onDownloadTemplate }) {
  const { t } = useTranslation()
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  const handleFileChange = (e) => {
    const selected = e.target.files[0]
    if (selected) {
      if (!selected.name.endsWith('.csv')) {
        toast.error(t('customers.selectCsvFile'))
        return
      }
      setFile(selected)
    }
  }

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('customers.selectFileFirst'))
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
    <div className="modal-overlay-bg fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overscroll-contain">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-bold text-gray-900">{t('customerModal.bulkUploadTitle')}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-medium text-blue-900 mb-2">📋 {t('customerModal.instructions')}</h3>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>{t('customerModal.bulkInst1')}</li>
              <li>{t('customerModal.bulkInst2')}</li>
              <li>{t('customerModal.bulkInst3')}</li>
              <li>{t('customerModal.bulkInst4')}</li>
              <li>{t('customerModal.bulkInst5')}</li>
              <li>{t('customerModal.bulkInst6')}</li>
              <li>{t('customerModal.bulkInst7')}</li>
            </ul>
          </div>

          <button
            onClick={onDownloadTemplate}
            className="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            {t('customerModal.downloadTemplate')}
          </button>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('customerModal.uploadCSVLabel')}</label>
            <label className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-500 transition-colors block">
              {file ? (
                <div className="space-y-2">
                  <svg
                    className="w-12 h-12 text-green-500 mx-auto"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <p className="font-medium text-gray-900">{file.name}</p>
                  <p className="text-sm text-gray-500">{(file.size / 1024).toFixed(2)} KB</p>
                  <p className="text-xs text-indigo-600">{t('customerModal.clickToChangeFile')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <svg
                    className="w-12 h-12 text-gray-500 mx-auto"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                  <p className="text-gray-600">{t('customerModal.clickToUploadCSV')}</p>
                  <p className="text-sm text-gray-500">{t('customerModal.dragAndDrop')}</p>
                </div>
              )}
              <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
            </label>
          </div>

          {file && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              ⚠️ {t('customerModal.bulkUploadWarning')}
            </div>
          )}
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            className="flex-1 justify-center"
            onClick={handleUpload}
            disabled={!file}
            loading={uploading}
          >
            {!uploading && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
            {uploading ? t('common.loading') : t('customerModal.uploadBtn')}
          </Button>
        </div>
      </div>
    </div>
  )
}
