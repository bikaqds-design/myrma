import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18next from 'i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { Button, Spinner, PageHeader } from '../components/ui'
import EmptyState from '../components/EmptyState'
import ConfirmDialog from '../components/ConfirmDialog'
import { useAppearance } from '../contexts/AppearanceContext'
import { ROLES } from '../lib/constants'
import { captureException } from '../lib/sentry'

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_TABS = ['All', 'Draft', 'Sent', 'Paid', 'Void', 'Quotes']

const STATUS_CLS = {
  draft: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  sent:  'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  paid:  'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  void:  'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
}

const TYPE_CLS = {
  invoice: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
  quote:   'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
}

const EMPTY_LINE = () => ({ description: '', qty: 1, unitPrice: 0 })

const EMPTY_FORM = {
  type: 'invoice',
  invoice_number: '',
  rma_number_ref: '',
  ticket_id: '',
  customer_name: '',
  customer_email: '',
  lineItems: [EMPTY_LINE()],
  labour_hours: 0,
  labour_rate: 0,
  discount_pct: 0,
  tax_pct: 0,
  notes: '',
  due_date: '',
  status: 'draft',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcTotals(form) {
  const partsSubtotal = form.lineItems.reduce(
    (sum, li) => sum + (parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0),
    0
  )
  const labourTotal = (parseFloat(form.labour_hours) || 0) * (parseFloat(form.labour_rate) || 0)
  const subtotal = partsSubtotal + labourTotal
  const discountAmt = subtotal * ((parseFloat(form.discount_pct) || 0) / 100)
  const taxAmt = (subtotal - discountAmt) * ((parseFloat(form.tax_pct) || 0) / 100)
  const total = subtotal - discountAmt + taxAmt
  return { partsSubtotal, labourTotal, subtotal, discountAmt, taxAmt, total }
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function generateInvoiceNumber(existing = []) {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `INV-${yyyy}${mm}-`
  const serials = existing
    .map((inv) => inv.invoice_number)
    .filter((n) => n?.startsWith(prefix))
    .map((n) => parseInt(n.replace(prefix, ''), 10))
    .filter((n) => !isNaN(n))
  const next = serials.length > 0 ? Math.max(...serials) + 1 : 1
  return `${prefix}${String(next).padStart(4, '0')}`
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

function exportPDF(invoice, t) {
  const totals = calcTotals({
    lineItems: invoice.line_items || [],
    labour_hours: invoice.labour_hours || 0,
    labour_rate: invoice.labour_rate || 0,
    discount_pct: invoice.discount_pct || 0,
    tax_pct: invoice.tax_pct || 0,
  })

  // S9-3: escape user-controlled values before writing raw HTML to the print
  // window (description/customer/notes are user input → XSS via document.write).
  const esc = (v) =>
    String(v ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])

  const lineRows = (invoice.line_items || [])
    .map(
      (li) => `
    <tr style="border-bottom:1px solid #e5e7eb">
      <td style="padding:8px 12px">${esc(li.description)}</td>
      <td style="padding:8px 12px;text-align:right">${esc(li.qty)}</td>
      <td style="padding:8px 12px;text-align:right">$${fmt(li.unitPrice)}</td>
      <td style="padding:8px 12px;text-align:right">$${fmt((parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0))}</td>
    </tr>`
    )
    .join('')

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${esc(invoice.invoice_number)}</title>
  <style>
    body{font-family:sans-serif;color:#111;margin:0;padding:32px}
    h1{font-size:28px;font-weight:700;color:#4f46e5;margin:0}
    .meta{display:flex;justify-content:space-between;margin:24px 0 32px}
    .meta-block p{margin:2px 0;font-size:13px;color:#374151}
    .meta-block .label{font-size:11px;font-weight:600;text-transform:uppercase;color:#9ca3af;letter-spacing:.05em}
    table{width:100%;border-collapse:collapse;font-size:13px}
    thead{background:#f9fafb}
    th{padding:10px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;color:#6b7280}
    th:not(:first-child){text-align:right}
    .totals{margin-top:16px;display:flex;justify-content:flex-end}
    .totals table{width:260px}
    .totals td{padding:5px 8px;font-size:13px}
    .totals .total-row td{font-weight:700;font-size:15px;border-top:2px solid #e5e7eb;padding-top:10px}
    .notes{margin-top:32px;font-size:12px;color:#6b7280}
    @media print{body{padding:0}}
  </style>
</head>
<body>
  <h1>${esc(invoice.invoice_number)}</h1>
  <div class="meta">
    <div class="meta-block">
      <p class="label">Bill To</p>
      <p><strong>${esc(invoice.customer_name) || '—'}</strong></p>
      ${invoice.customer_email ? `<p>${esc(invoice.customer_email)}</p>` : ''}
      ${invoice.rma_number_ref ? `<p>RMA: ${esc(invoice.rma_number_ref)}</p>` : ''}
    </div>
    <div class="meta-block" style="text-align:right">
      <p class="label">Details</p>
      <p>Type: <strong>${invoice.type === 'quote' ? 'Quote' : 'Invoice'}</strong></p>
      <p>Status: ${esc(invoice.status) || 'draft'}</p>
      ${invoice.due_date ? `<p>Due: ${esc(invoice.due_date)}</p>` : ''}
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align:right">Qty</th>
        <th style="text-align:right">Unit Price</th>
        <th style="text-align:right">Total</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows}
      ${
        totals.labourTotal > 0
          ? `<tr style="border-bottom:1px solid #e5e7eb">
        <td style="padding:8px 12px">Labour (${invoice.labour_hours}h @ $${fmt(invoice.labour_rate)}/h)</td>
        <td style="padding:8px 12px;text-align:right">—</td>
        <td style="padding:8px 12px;text-align:right">—</td>
        <td style="padding:8px 12px;text-align:right">$${fmt(totals.labourTotal)}</td>
      </tr>`
          : ''
      }
    </tbody>
  </table>
  <div class="totals">
    <table>
      <tr><td>Subtotal</td><td style="text-align:right">$${fmt(totals.subtotal)}</td></tr>
      ${totals.discountAmt > 0 ? `<tr><td>Discount (${invoice.discount_pct}%)</td><td style="text-align:right">−$${fmt(totals.discountAmt)}</td></tr>` : ''}
      ${totals.taxAmt > 0 ? `<tr><td>Tax (${invoice.tax_pct}%)</td><td style="text-align:right">$${fmt(totals.taxAmt)}</td></tr>` : ''}
      <tr class="total-row"><td>Total</td><td style="text-align:right">$${fmt(totals.total)}</td></tr>
    </table>
  </div>
  ${invoice.notes ? `<div class="notes"><strong>Notes:</strong> ${esc(invoice.notes)}</div>` : ''}
</body>
</html>`

  const win = window.open('', '_blank')
  if (!win) {
    toast.error(t('common.popupBlocked'))
    return
  }
  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 400)
}

// ─── Panel Form ───────────────────────────────────────────────────────────────

function InvoicePanel({
  form,
  setForm,
  onSave,
  onClose,
  saving,
  tickets,
  invoices: _invoices,
  isEdit,
}) {
  const { t } = useTranslation()
  const totals = calcTotals(form)

  const handleRmaLookup = (rmaNum) => {
    setForm((f) => ({ ...f, rma_number_ref: rmaNum }))
    if (!rmaNum) return
    const match = tickets.find((t) => t.rma_number?.toLowerCase() === rmaNum.toLowerCase())
    if (match) {
      setForm((f) => ({
        ...f,
        ticket_id: match.id,
        customer_name: match.customer_name || f.customer_name,
        customer_email: match.customer_email || f.customer_email,
      }))
    }
  }

  const updateLine = (idx, field, value) => {
    setForm((f) => {
      const items = [...f.lineItems]
      items[idx] = { ...items[idx], [field]: value }
      return { ...f, lineItems: items }
    })
  }

  const addLine = () => setForm((f) => ({ ...f, lineItems: [...f.lineItems, EMPTY_LINE()] }))
  const removeLine = (idx) =>
    setForm((f) => ({ ...f, lineItems: f.lineItems.filter((_, i) => i !== idx) }))

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-xl bg-white dark:bg-[#121823] shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-[#212a38] flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {isEdit ? t('invoices.editTitle') : t('invoices.newInvoiceQuote')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:bg-[#1a2230] transition-colors"
          >
            <svg
              className="w-5 h-5 text-gray-500 dark:text-[#9aa4b2]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelType')}</label>
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="invoice">{t('invoices.optionInvoice')}</option>
              <option value="quote">{t('invoices.optionQuote')}</option>
            </select>
          </div>

          {/* Invoice Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">
              {t('invoices.labelInvoiceNumber')}
            </label>
            <input
              type="text"
              value={form.invoice_number}
              onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* RMA Link */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">
              {t('invoices.labelRmaLink')}
            </label>
            <input
              type="text"
              placeholder={t('invoices.rmaPlaceholder')}
              value={form.rma_number_ref}
              onChange={(e) => handleRmaLookup(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {form.ticket_id && (
              <p className="text-xs text-green-600 mt-1">
                {t('invoices.ticketFound')}
              </p>
            )}
          </div>

          {/* Customer */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelCustomerName')}</label>
              <input
                type="text"
                value={form.customer_name}
                onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelCustomerEmail')}</label>
              <input
                type="email"
                value={form.customer_email}
                onChange={(e) => setForm((f) => ({ ...f, customer_email: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0]">{t('invoices.labelLineItems')}</label>
              <button onClick={addLine} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                {t('invoices.addRow')}
              </button>
            </div>
            <div className="space-y-2">
              {form.lineItems.map((li, idx) => (
                <div key={idx} className="border border-gray-200 dark:border-[#212a38] rounded-lg p-3 space-y-2">
                  {/* Description full width */}
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={li.description}
                      onChange={(e) => updateLine(idx, 'description', e.target.value)}
                      placeholder={t('invoices.itemDescriptionPlaceholder')}
                      className="flex-1 px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    />
                    {form.lineItems.length > 1 && (
                      <button onClick={() => removeLine(idx)} className="text-gray-300 dark:text-[#4a5568] hover:text-red-500 flex-shrink-0">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {/* Qty | Unit $ | Line total */}
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <label className="block text-gray-400 dark:text-[#9aa4b2] mb-1">{t('invoices.labelQty')}</label>
                      <input
                        type="number" min="0" value={li.qty}
                        onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                        className="w-full px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-400 dark:text-[#9aa4b2] mb-1">{t('invoices.labelUnitPrice')}</label>
                      <input
                        type="number" min="0" step="0.01" value={li.unitPrice}
                        onChange={(e) => updateLine(idx, 'unitPrice', e.target.value)}
                        className="w-full px-2 py-1.5 border border-gray-200 dark:border-[#212a38] rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-400 dark:text-[#9aa4b2] mb-1">{t('invoices.labelLineTotal')}</label>
                      <div className="px-2 py-1.5 bg-gray-50 dark:bg-[#0f1520] rounded text-sm text-right font-medium text-gray-700 dark:text-[#e8ebf0]">
                        ${fmt((parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Labour */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelLabourHours')}</label>
              <input
                type="number"
                min="0"
                step="0.25"
                value={form.labour_hours}
                onChange={(e) => setForm((f) => ({ ...f, labour_hours: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">
                {t('invoices.labelLabourRate')}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.labour_rate}
                onChange={(e) => setForm((f) => ({ ...f, labour_rate: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Discount + Tax */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelDiscountPct')}</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={form.discount_pct}
                onChange={(e) => setForm((f) => ({ ...f, discount_pct: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelTaxPct')}</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={form.tax_pct}
                onChange={(e) => setForm((f) => ({ ...f, tax_pct: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Totals summary */}
          <div className="bg-gray-50 dark:bg-[#0f1520] rounded-lg p-4 text-sm space-y-1.5">
            <div className="flex justify-between text-gray-600 dark:text-[#9aa4b2]">
              <span>{t('invoices.labelPartsSubtotal')}</span>
              <span>${fmt(totals.partsSubtotal)}</span>
            </div>
            {totals.labourTotal > 0 && (
              <div className="flex justify-between text-gray-600 dark:text-[#9aa4b2]">
                <span>{t('invoices.labelLabour')}</span>
                <span>${fmt(totals.labourTotal)}</span>
              </div>
            )}
            <div className="flex justify-between text-gray-600 dark:text-[#9aa4b2] border-t border-gray-200 dark:border-[#212a38] pt-1.5">
              <span>{t('invoices.labelSubtotal')}</span>
              <span>${fmt(totals.subtotal)}</span>
            </div>
            {totals.discountAmt > 0 && (
              <div className="flex justify-between text-gray-500 dark:text-[#9aa4b2]">
                <span>{t('invoices.labelDiscountLine', { pct: form.discount_pct })}</span>
                <span>−${fmt(totals.discountAmt)}</span>
              </div>
            )}
            {totals.taxAmt > 0 && (
              <div className="flex justify-between text-gray-500 dark:text-[#9aa4b2]">
                <span>{t('invoices.labelTaxLine', { pct: form.tax_pct })}</span>
                <span>${fmt(totals.taxAmt)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-gray-900 dark:text-[#e8ebf0] text-base border-t border-gray-300 dark:border-[#212a38] pt-2 mt-1">
              <span>{t('invoices.labelTotal')}</span>
              <span>${fmt(totals.total)}</span>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelNotes')}</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder={t('invoices.notesPlaceholder')}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Due Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mb-1">{t('invoices.labelDueDate')}</label>
            <input
              type="date"
              value={form.due_date}
              onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-[#212a38] flex items-center justify-end gap-3 flex-shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave} loading={saving}>
            {isEdit ? t('invoices.saveChanges') : t('invoices.createBtn')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Invoices({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { t } = useTranslation()
  const { formatDate } = useAppearance()

  const isAdmin = [ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(currentUserRole)
  const canDo = (action) => isAdmin || currentUserPermissions?.invoices?.[action] === true
  const canCreateInvoice = canDo('create')
  const canEditInvoice = canDo('edit')
  const canDeleteInvoice = canDo('delete')
  const isTech = currentUserRole === ROLES.TECHNICIAN

  const queryClient = useQueryClient()
  const { data: invoicesData, isLoading: loading, isError: invoicesError } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => db.invoices.list(),
  })
  const { data: ticketsData } = useQuery({
    queryKey: ['rma-tickets'],
    queryFn: () => db.rmaTickets.list(),
    staleTime: 60_000,
  })
  const tableMissing = invoicesData?.missing ?? false
  const invoices = useMemo(
    () => (invoicesData?.missing ? [] : (invoicesData?.data ?? invoicesData ?? [])),
    [invoicesData]
  )
  const tickets = useMemo(() => ticketsData ?? [], [ticketsData])

  useEffect(() => {
    if (invoicesError) toast.error(i18next.t('invoices.errorLoadFailed'))
  }, [invoicesError])
  const [activeTab, setActiveTab] = useState('All')
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })

  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false, onConfirm: null }))

  // ─── Filtered list ───────────────────────────────────────────────────────────
  const visibleInvoices = useMemo(() => {
    let list = invoices

    // Technicians only see invoices linked to their assigned tickets
    if (isTech) {
      const myTicketIds = new Set(
        tickets.filter((t) => t.assigned_technician === currentUserEmail).map((t) => t.id)
      )
      list = list.filter((inv) => inv.ticket_id && myTicketIds.has(inv.ticket_id))
    }

    if (activeTab === 'All') return list
    if (activeTab === 'Quotes') return list.filter((inv) => inv.type === 'quote')
    return list.filter((inv) => inv.status === activeTab.toLowerCase())
  }, [invoices, tickets, activeTab, isTech, currentUserEmail])

  // ─── Open panel ──────────────────────────────────────────────────────────────
  const openCreate = () => {
    const newNumber = generateInvoiceNumber(invoices)
    setForm({ ...EMPTY_FORM, invoice_number: newNumber })
    setEditingId(null)
    setPanelOpen(true)
  }

  const openEdit = (inv) => {
    setForm({
      type: inv.type || 'invoice',
      invoice_number: inv.invoice_number || '',
      rma_number_ref: inv.rma_number_ref || '',
      ticket_id: inv.ticket_id || '',
      customer_name: inv.customer_name || '',
      customer_email: inv.customer_email || '',
      lineItems: inv.line_items?.length ? inv.line_items : [EMPTY_LINE()],
      labour_hours: inv.labour_hours || 0,
      labour_rate: inv.labour_rate || 0,
      discount_pct: inv.discount_pct || 0,
      tax_pct: inv.tax_pct || 0,
      notes: inv.notes || '',
      due_date: inv.due_date ? inv.due_date.split('T')[0] : '',
      status: inv.status || 'draft',
    })
    setEditingId(inv.id)
    setPanelOpen(true)
  }

  // ─── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!form.invoice_number.trim()) {
      toast.error(t('invoices.errorNumberRequired'))
      return
    }
    if (!form.customer_name.trim()) {
      toast.error(t('invoices.errorCustomerRequired'))
      return
    }

    setSaving(true)
    const totals = calcTotals(form)
    const payload = {
      type: form.type,
      invoice_number: form.invoice_number.trim(),
      rma_number_ref: form.rma_number_ref || null,
      ticket_id: form.ticket_id || null,
      customer_name: form.customer_name.trim(),
      customer_email: form.customer_email.trim() || null,
      line_items: form.lineItems,
      labour_hours: parseFloat(form.labour_hours) || 0,
      labour_rate: parseFloat(form.labour_rate) || 0,
      discount_pct: parseFloat(form.discount_pct) || 0,
      tax_pct: parseFloat(form.tax_pct) || 0,
      notes: form.notes || null,
      due_date: form.due_date || null,
      status: form.status,
      total: totals.total,
      created_by: currentUserEmail,
    }

    try {
      if (editingId) {
        const res = await db.invoices.update(editingId, payload)
        if (res?.missing) {
          toast.error(t('invoices.errorTableNotFound'))
          return
        }
        queryClient.invalidateQueries({ queryKey: ['invoices'] })
        toast.success(t('invoices.successUpdated'))
      } else {
        const res = await db.invoices.create(payload)
        if (res?.missing) {
          toast.error(t('invoices.errorTableNotFound'))
          return
        }
        queryClient.invalidateQueries({ queryKey: ['invoices'] })
        toast.success(form.type === 'quote' ? t('invoices.successCreatedQuote') : t('invoices.successCreatedInvoice'))
      }
      setPanelOpen(false)
    } catch (err) {
      captureException(err)
      toast.error(err.message || t('invoices.errorSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  // ─── Status changes ──────────────────────────────────────────────────────────
  const updateStatus = async (inv, newStatus) => {
    try {
      await db.invoices.update(inv.id, { status: newStatus })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success(t('invoices.markedAs', { status: newStatus }))
    } catch (err) {
      toast.error(err.message || t('invoices.errorUpdateStatus'))
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = (inv) => {
    openConfirm(
      t('invoices.deleteTitle'),
      t('invoices.deleteMsg', { number: inv.invoice_number }),
      async () => {
        closeConfirm()
        try {
          await db.invoices.delete(inv.id)
          queryClient.invalidateQueries({ queryKey: ['invoices'] })
          toast.success(t('invoices.successDeleted'))
        } catch (err) {
          toast.error(err.message || t('invoices.errorDeleteFailed'))
        }
      }
    )
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="p-3 sm:p-6">
      {/* Migration banner */}
      {tableMissing && (
        <div className="mb-6 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
          <svg
            className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <div>
            <p className="font-semibold text-amber-800">{t('invoices.tableMissingTitle')}</p>
            <p className="text-amber-700 mt-0.5">
              {t('invoices.tableMissingDesc')} Create
              the <code className="font-mono bg-amber-100 px-1 rounded">invoices</code> table with
              the columns used by this page.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <PageHeader
        title={t('invoices.title')}
        subtitle={t('invoices.subtitle')}
        className="mb-6"
      >
        {canCreateInvoice && !tableMissing && (
          <Button onClick={openCreate}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            {t('invoices.newInvoiceQuote')}
          </Button>
        )}
      </PageHeader>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 dark:bg-[#1a2230] rounded-xl p-1 w-full sm:w-fit overflow-x-auto">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-white dark:bg-[#121823] text-gray-900 dark:text-[#e8ebf0] shadow-sm'
                : 'text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:text-[#e8ebf0]'
            }`}
          >
            {t(`invoices.tab${tab}`, tab)}
            {tab !== 'All' && (
              <span className="ml-1.5 text-xs text-gray-500 dark:text-[#9aa4b2]">
                (
                {tab === 'Quotes'
                  ? invoices.filter((i) => i.type === 'quote').length
                  : invoices.filter((i) => i.status === tab.toLowerCase()).length}
                )
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {visibleInvoices.length === 0 ? (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm">
          <EmptyState
            title={tableMissing ? t('invoices.emptyTableTitle') : t('invoices.emptyTitle')}
            description={
              tableMissing
                ? t('invoices.emptyTableDesc')
                : t('invoices.emptyDesc')
            }
            action={canCreateInvoice && !tableMissing ? openCreate : undefined}
            actionLabel={t('invoices.newInvoiceQuote')}
          />
        </div>
      ) : (
        <>
          {/* ── Mobile card list (hidden on sm+) ── */}
          <div className="sm:hidden space-y-3">
            {visibleInvoices.map((inv) => (
              <InvoiceCard
                key={inv.id}
                inv={inv}
                canEdit={canEditInvoice}
                formatDate={formatDate}
                onEdit={() => openEdit(inv)}
                onExportPDF={() => exportPDF(inv, t)}
                onMarkSent={() =>
                  openConfirm(t('invoices.confirmMarkSent'), t('invoices.confirmMarkSentMsg', { number: inv.invoice_number }), () => { closeConfirm(); updateStatus(inv, 'sent') })
                }
                onMarkPaid={() =>
                  openConfirm(t('invoices.confirmMarkPaid'), t('invoices.confirmMarkPaidMsg', { number: inv.invoice_number }), () => { closeConfirm(); updateStatus(inv, 'paid') })
                }
                onVoid={() =>
                  openConfirm(t('invoices.confirmVoidTitle'), t('invoices.confirmVoidMsg', { number: inv.invoice_number }), () => { closeConfirm(); updateStatus(inv, 'void') })
                }
                onDelete={canDeleteInvoice ? () => handleDelete(inv) : undefined}
              />
            ))}
          </div>

          {/* ── Desktop table (hidden on mobile) ── */}
          <div className="hidden sm:block bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-200 dark:border-[#212a38]">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colInvoiceNum')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colType')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colCustomer')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colTicket')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colStatus')}</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colTotal')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colDueDate')}</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wide">{t('invoices.colCreated')}</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-[#212a38]">
                  {visibleInvoices.map((inv) => (
                    <InvoiceRow
                      key={inv.id}
                      inv={inv}
                      canEdit={canEditInvoice}
                      canDelete={canDeleteInvoice}
                      formatDate={formatDate}
                      onEdit={() => openEdit(inv)}
                      onExportPDF={() => exportPDF(inv, t)}
                      onMarkSent={() =>
                        openConfirm(t('invoices.confirmMarkSent'), t('invoices.confirmMarkSentMsg', { number: inv.invoice_number }), () => { closeConfirm(); updateStatus(inv, 'sent') })
                      }
                      onMarkPaid={() =>
                        openConfirm(t('invoices.confirmMarkPaid'), t('invoices.confirmMarkPaidMsg', { number: inv.invoice_number }), () => { closeConfirm(); updateStatus(inv, 'paid') })
                      }
                      onVoid={() =>
                        openConfirm(t('invoices.confirmVoidTitle'), t('invoices.confirmVoidMsg', { number: inv.invoice_number }), () => { closeConfirm(); updateStatus(inv, 'void') })
                      }
                      onDelete={canDeleteInvoice ? () => handleDelete(inv) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Slide-over panel */}
      {panelOpen && (
        <InvoicePanel
          form={form}
          setForm={setForm}
          onSave={handleSave}
          onClose={() => setPanelOpen(false)}
          saving={saving}
          tickets={tickets}
          invoices={invoices}
          isEdit={!!editingId}
        />
      )}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel="Confirm"
        confirmClass="bg-indigo-600 hover:bg-indigo-700 text-white"
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  )
}

// ─── Invoice Card (mobile) ────────────────────────────────────────────────────

function InvoiceCard({ inv, canEdit, formatDate, onEdit, onExportPDF, onMarkSent, onMarkPaid, onVoid, onDelete }) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const canChangeStatus = canEdit

  return (
    <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4 shadow-sm">
      {/* Top row: invoice number + total */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <span className="font-mono text-sm font-semibold text-indigo-700">{inv.invoice_number}</span>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_CLS[inv.type] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}>
              {inv.type === 'quote' ? t('invoices.typeQuote') : t('invoices.typeInvoice')}
            </span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLS[inv.status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}>
              {inv.status ? inv.status.charAt(0).toUpperCase() + inv.status.slice(1) : 'Draft'}
            </span>
          </div>
        </div>
        <span className="text-lg font-bold text-gray-900 dark:text-[#e8ebf0] tabular-nums flex-shrink-0">${fmt(inv.total)}</span>
      </div>

      {/* Customer */}
      <p className="text-sm font-medium text-gray-800 dark:text-[#e8ebf0] truncate">{inv.customer_name || '—'}</p>
      {inv.customer_email && <p className="text-xs text-gray-500 dark:text-[#9aa4b2] truncate">{inv.customer_email}</p>}

      {/* Meta row */}
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-500 dark:text-[#9aa4b2] flex-wrap">
        {inv.rma_number_ref && <span className="font-mono">{inv.rma_number_ref}</span>}
        {inv.due_date && <span>{t('invoices.due', { date: formatDate(inv.due_date) })}</span>}
        {inv.created_at && <span>{t('invoices.createdDate', { date: formatDate(inv.created_at) })}</span>}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100 dark:border-[#212a38]">
        <button
          onClick={onExportPDF}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-gray-200 dark:border-[#212a38] text-xs font-medium text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          PDF
        </button>

        {(canEdit || onDelete) && (
          <div className="relative flex-1">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-gray-200 dark:border-[#212a38] text-xs font-medium text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors"
            >
              {t('common.actions')}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 bottom-full mb-1 w-44 bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-xl shadow-xl z-40 py-1 text-sm">
                  {canEdit && (
                    <button onClick={() => { setMenuOpen(false); onEdit() }} className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0]">{t('common.edit')}</button>
                  )}
                  {canChangeStatus && inv.status === 'draft' && (
                    <button onClick={() => { setMenuOpen(false); onMarkSent() }} className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0]">{t('invoices.markSent')}</button>
                  )}
                  {canChangeStatus && inv.status === 'sent' && (
                    <button onClick={() => { setMenuOpen(false); onMarkPaid() }} className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0]">{t('invoices.markPaid')}</button>
                  )}
                  {canChangeStatus && inv.status !== 'void' && inv.status !== 'paid' && (
                    <button onClick={() => { setMenuOpen(false); onVoid() }} className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600">{t('invoices.void')}</button>
                  )}
                  {onDelete && (
                    <button onClick={() => { setMenuOpen(false); onDelete() }} className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 border-t border-gray-100 dark:border-[#212a38]">{t('common.delete')}</button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Invoice Row ─────────────────────────────────────────────────────────────

function InvoiceRow({
  inv,
  canEdit,
  canDelete,
  formatDate,
  onEdit,
  onExportPDF,
  onMarkSent,
  onMarkPaid,
  onVoid,
  onDelete,
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)

  const canChangeStatus = canEdit

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] transition-colors">
      <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-700">
        {inv.invoice_number}
      </td>
      <td className="px-4 py-3">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_CLS[inv.type] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
        >
          {inv.type === 'quote' ? t('invoices.typeQuote') : t('invoices.typeInvoice')}
        </span>
      </td>
      <td className="px-4 py-3">
        <p className="font-medium text-gray-800 dark:text-[#e8ebf0] truncate max-w-[160px]">
          {inv.customer_name || '—'}
        </p>
        {inv.customer_email && (
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] truncate max-w-[160px]">{inv.customer_email}</p>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-[#9aa4b2]">{inv.rma_number_ref || '—'}</td>
      <td className="px-4 py-3">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLS[inv.status] || 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]'}`}
        >
          {inv.status ? inv.status.charAt(0).toUpperCase() + inv.status.slice(1) : 'Draft'}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-semibold text-gray-800 dark:text-[#e8ebf0]">${fmt(inv.total)}</td>
      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs">
        {inv.due_date ? formatDate(inv.due_date) : '—'}
      </td>
      <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2] text-xs">
        {inv.created_at ? formatDate(inv.created_at) : '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2 relative">
          <button
            onClick={onExportPDF}
            title={t('invoices.exportPDF')}
            aria-label={t('invoices.exportPDF')}
            className="p-1.5 rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
          </button>

          {(canEdit || canChangeStatus || canDelete) && (
            <div className="relative">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="p-1.5 rounded-lg text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-100 dark:bg-[#1a2230] transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                </svg>
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 w-44 bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-xl shadow-xl z-40 py-1 text-sm">
                    {canEdit && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onEdit()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0]"
                      >
                        {t('common.edit')}
                      </button>
                    )}
                    {canChangeStatus && inv.status === 'draft' && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onMarkSent()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0]"
                      >
                        {t('invoices.markSent')}
                      </button>
                    )}
                    {canChangeStatus && inv.status === 'sent' && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onMarkPaid()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 dark:hover:bg-[#1a2230] dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0]"
                      >
                        {t('invoices.markPaid')}
                      </button>
                    )}
                    {canChangeStatus && inv.status !== 'void' && inv.status !== 'paid' && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onVoid()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600"
                      >
                        {t('invoices.void')}
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onDelete()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 border-t border-gray-100 dark:border-[#212a38]"
                      >
                        {t('common.delete')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </td>
    </tr>
  )
}
