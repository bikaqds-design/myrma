import React, { useState } from 'react'
import toast from 'react-hot-toast'
import AttachmentsField from '../../components/AttachmentsField'
import { Button } from '../../components/ui'

// ─── SHARED HELPERS ────────────────────────────────────────────────────────────

const Req = () => <span className="text-red-500 ml-0.5">*</span>
const inp =
  'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none'
const sel =
  'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white'

export function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
        {required && <Req />}
      </label>
      {children}
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
  const isB2B = form.customer_type === 'B2B'
  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }))

  return (
    <div className="modal-overlay-bg fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto overscroll-contain">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-bold text-gray-900">
              {editing ? 'Edit Customer' : 'Add New Customer'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="text-red-500">*</span> Required fields
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
            <Field label="Customer Type" required>
              <select
                value={form.customer_type}
                onChange={(e) => set('customer_type', e.target.value)}
                className={sel}
              >
                <option value="B2B">B2B — Company</option>
                <option value="B2C">B2C — Individual</option>
              </select>
            </Field>
            <Field label="Status">
              <select
                value={form.customer_status}
                onChange={(e) => set('customer_status', e.target.value)}
                className={sel}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
                <option value="Suspended">Suspended</option>
                <option value="VIP">VIP</option>
              </select>
            </Field>
          </div>

          {/* Company Name — B2B only */}
          {isB2B && (
            <Field label="Company Name" required>
              <input
                type="text"
                value={form.company_name}
                onChange={(e) => set('company_name', e.target.value)}
                className={inp}
                placeholder="e.g. Maximum Hardware"
              />
            </Field>
          )}

          {/* Contact Person + Account Manager */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Contact Person" required>
              <input
                type="text"
                value={form.contact_person}
                onChange={(e) => set('contact_person', e.target.value)}
                className={inp}
                placeholder="Full name"
              />
            </Field>
            <Field label="Account Manager">
              <select
                value={form.account_manager}
                onChange={(e) => set('account_manager', e.target.value)}
                className={sel}
              >
                <option value="">— Select manager —</option>
                {usersList.map((u) => (
                  <option key={u.user_email} value={u.user_email}>
                    {u.user_email}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Mobile + Landline */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Mobile" required>
              <input
                type="tel"
                value={form.mobile}
                onChange={(e) => set('mobile', e.target.value)}
                className={inp}
                placeholder="+20 XXX XXX XXXX"
              />
            </Field>
            <Field label="Landline">
              <input
                type="tel"
                value={form.landline}
                onChange={(e) => set('landline', e.target.value)}
                className={inp}
                placeholder="+2 0X XXXX XXXX"
              />
            </Field>
          </div>

          {/* Email */}
          <Field label="Email">
            <input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              className={inp}
              placeholder="email@example.com"
            />
          </Field>

          {/* Address */}
          <Field label="Address">
            <textarea
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
              rows={3}
              className={inp}
              placeholder="Street, city, governorate..."
            />
          </Field>

          {/* CR Number + Tax ID — B2B only */}
          {isB2B && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="CR Number">
                <input
                  type="text"
                  value={form.cr_number}
                  onChange={(e) => set('cr_number', e.target.value)}
                  className={inp}
                  placeholder="Commercial registration"
                />
              </Field>
              <Field label="Tax ID">
                <input
                  type="text"
                  value={form.tax_id}
                  onChange={(e) => set('tax_id', e.target.value)}
                  className={inp}
                  placeholder="Tax identification number"
                />
              </Field>
            </div>
          )}

          {/* Notes */}
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
              className={inp}
              placeholder="Internal notes..."
            />
          </Field>

          {/* Attachments */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Attachments
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
            Cancel
          </Button>
          <Button className="flex-1 justify-center" onClick={onSave}>
            {editing ? 'Update Customer' : 'Create Customer'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── BULK UPLOAD CUSTOMERS MODAL ────────────────────────────────────────────

export function BulkUploadCustomersModal({ onClose, onUpload, onDownloadTemplate }) {
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  const handleFileChange = (e) => {
    const selected = e.target.files[0]
    if (selected) {
      if (!selected.name.endsWith('.csv')) {
        toast.error('Please select a CSV file')
        return
      }
      setFile(selected)
    }
  }

  const handleUpload = async () => {
    if (!file) {
      toast.error('Please select a file first')
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
          <h2 className="text-xl font-bold text-gray-900">Bulk Upload Customers</h2>
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
            <h3 className="font-medium text-blue-900 mb-2">📋 Instructions:</h3>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li>Download the CSV template first</li>
              <li>Fill in your customer data following the template format</li>
              <li>
                Required fields: <strong>company_name</strong> (B2B) or{' '}
                <strong>contact_person</strong> (B2C) — mobile is optional
              </li>
              <li>
                <strong>company_name</strong> is required when customer_type is B2B
              </li>
              <li>
                Valid customer_type values: <strong>B2B</strong>, <strong>B2C</strong>
              </li>
              <li>
                Valid customer_status values: <strong>Active</strong>, <strong>Inactive</strong>
              </li>
              <li>Avoid commas inside the address field — use a dash instead</li>
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
            Download CSV Template
          </button>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Upload CSV File</label>
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
                  <p className="text-xs text-indigo-600">Click to change file</p>
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
                  <p className="text-gray-600">Click to upload CSV file</p>
                  <p className="text-sm text-gray-500">or drag and drop</p>
                </div>
              )}
              <input type="file" accept=".csv" onChange={handleFileChange} className="hidden" />
            </label>
          </div>

          {file && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              ⚠️ Each imported customer will get a unique CB-XXXXXXXX code generated automatically.
            </div>
          )}
        </div>

        <div className="flex gap-3 p-6 border-t border-gray-200">
          <Button variant="secondary" className="flex-1 justify-center" onClick={onClose}>
            Cancel
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
            {uploading ? 'Uploading...' : 'Import Customers'}
          </Button>
        </div>
      </div>
    </div>
  )
}
