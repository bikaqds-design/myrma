import React, { useState, useEffect, useMemo } from 'react'
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
  draft: 'bg-gray-100 text-gray-600',
  sent: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  void: 'bg-red-100 text-red-700',
}

const TYPE_CLS = {
  invoice: 'bg-indigo-100 text-indigo-700',
  quote: 'bg-purple-100 text-purple-700',
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

function exportPDF(invoice) {
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
    toast.error('Pop-up blocked — allow pop-ups and try again')
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
      <div className="w-full max-w-xl bg-white shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Edit Invoice / Quote' : 'New Invoice / Quote'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <svg
              className="w-5 h-5 text-gray-500"
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="invoice">Invoice</option>
              <option value="quote">Quote</option>
            </select>
          </div>

          {/* Invoice Number */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Invoice / Quote Number
            </label>
            <input
              type="text"
              value={form.invoice_number}
              onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* RMA Link */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Link to RMA Number (optional)
            </label>
            <input
              type="text"
              placeholder="e.g. RMA-01012025-0001"
              value={form.rma_number_ref}
              onChange={(e) => handleRmaLookup(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {form.ticket_id && (
              <p className="text-xs text-green-600 mt-1">
                Ticket found — customer details auto-filled.
              </p>
            )}
          </div>

          {/* Customer */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
              <input
                type="text"
                value={form.customer_name}
                onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Customer Email</label>
              <input
                type="email"
                value={form.customer_email}
                onChange={(e) => setForm((f) => ({ ...f, customer_email: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Line Items</label>
              <button
                onClick={addLine}
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                + Add Row
              </button>
            </div>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Description</th>
                    <th className="px-2 py-2 text-right text-gray-500 font-medium w-14">Qty</th>
                    <th className="px-2 py-2 text-right text-gray-500 font-medium w-20">Unit $</th>
                    <th className="px-2 py-2 text-right text-gray-500 font-medium w-20">Total</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {form.lineItems.map((li, idx) => (
                    <tr key={idx} className="border-t border-gray-100">
                      <td className="px-2 py-1.5">
                        <input
                          type="text"
                          value={li.description}
                          onChange={(e) => updateLine(idx, 'description', e.target.value)}
                          placeholder="Item description"
                          className="w-full bg-transparent focus:outline-none focus:ring-1 focus:ring-indigo-400 rounded px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          min="0"
                          value={li.qty}
                          onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                          className="w-full bg-transparent text-right focus:outline-none focus:ring-1 focus:ring-indigo-400 rounded px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={li.unitPrice}
                          onChange={(e) => updateLine(idx, 'unitPrice', e.target.value)}
                          className="w-full bg-transparent text-right focus:outline-none focus:ring-1 focus:ring-indigo-400 rounded px-1 py-0.5"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-600">
                        ${fmt((parseFloat(li.qty) || 0) * (parseFloat(li.unitPrice) || 0))}
                      </td>
                      <td className="px-1 py-1.5">
                        {form.lineItems.length > 1 && (
                          <button
                            onClick={() => removeLine(idx)}
                            className="text-gray-300 hover:text-red-500 transition-colors"
                          >
                            <svg
                              className="w-3.5 h-3.5"
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
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Labour */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Labour Hours</label>
              <input
                type="number"
                min="0"
                step="0.25"
                value={form.labour_hours}
                onChange={(e) => setForm((f) => ({ ...f, labour_hours: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Labour Rate ($/h)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.labour_rate}
                onChange={(e) => setForm((f) => ({ ...f, labour_rate: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Discount + Tax */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Discount %</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={form.discount_pct}
                onChange={(e) => setForm((f) => ({ ...f, discount_pct: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tax %</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={form.tax_pct}
                onChange={(e) => setForm((f) => ({ ...f, tax_pct: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Totals summary */}
          <div className="bg-gray-50 rounded-lg p-4 text-sm space-y-1.5">
            <div className="flex justify-between text-gray-600">
              <span>Parts Subtotal</span>
              <span>${fmt(totals.partsSubtotal)}</span>
            </div>
            {totals.labourTotal > 0 && (
              <div className="flex justify-between text-gray-600">
                <span>Labour</span>
                <span>${fmt(totals.labourTotal)}</span>
              </div>
            )}
            <div className="flex justify-between text-gray-600 border-t border-gray-200 pt-1.5">
              <span>Subtotal</span>
              <span>${fmt(totals.subtotal)}</span>
            </div>
            {totals.discountAmt > 0 && (
              <div className="flex justify-between text-gray-500">
                <span>Discount ({form.discount_pct}%)</span>
                <span>−${fmt(totals.discountAmt)}</span>
              </div>
            )}
            {totals.taxAmt > 0 && (
              <div className="flex justify-between text-gray-500">
                <span>Tax ({form.tax_pct}%)</span>
                <span>${fmt(totals.taxAmt)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-gray-900 text-base border-t border-gray-300 pt-2 mt-1">
              <span>Total</span>
              <span>${fmt(totals.total)}</span>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Additional notes or payment terms..."
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Due Date */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Due Date</label>
            <input
              type="date"
              value={form.due_date}
              onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-end gap-3 flex-shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} loading={saving}>
            {isEdit ? 'Save Changes' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Invoices({ currentUserRole, currentUserEmail, currentUserPermissions }) {
  const { formatDate } = useAppearance()

  const _canDo = (s, a) =>
    [ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(currentUserRole) || currentUserPermissions?.[s]?.[a]

  const isAdmin = [ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(currentUserRole)
  const isManager = currentUserRole === ROLES.MANAGER || isAdmin
  const isTech = currentUserRole === ROLES.TECHNICIAN
  const isViewer = currentUserRole === ROLES.VIEWER

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
    if (invoicesError) toast.error('Failed to load invoices')
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
      toast.error('Invoice number is required')
      return
    }
    if (!form.customer_name.trim()) {
      toast.error('Customer name is required')
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
          toast.error('Invoices table not found')
          return
        }
        queryClient.invalidateQueries({ queryKey: ['invoices'] })
        toast.success('Invoice updated')
      } else {
        const res = await db.invoices.create(payload)
        if (res?.missing) {
          toast.error('Invoices table not found')
          return
        }
        queryClient.invalidateQueries({ queryKey: ['invoices'] })
        toast.success(`${form.type === 'quote' ? 'Quote' : 'Invoice'} created`)
      }
      setPanelOpen(false)
    } catch (err) {
      captureException(err)
      toast.error(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // ─── Status changes ──────────────────────────────────────────────────────────
  const updateStatus = async (inv, newStatus) => {
    try {
      await db.invoices.update(inv.id, { status: newStatus })
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success(`Marked as ${newStatus}`)
    } catch (err) {
      toast.error(err.message || 'Failed to update status')
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────
  const handleDelete = (inv) => {
    openConfirm(
      'Delete Invoice',
      `Delete ${inv.invoice_number}? This cannot be undone.`,
      async () => {
        closeConfirm()
        try {
          await db.invoices.delete(inv.id)
          queryClient.invalidateQueries({ queryKey: ['invoices'] })
          toast.success('Invoice deleted')
        } catch (err) {
          toast.error(err.message || 'Delete failed')
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
    <div className="p-6">
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
            <p className="font-semibold text-amber-800">Invoices table not found</p>
            <p className="text-amber-700 mt-0.5">
              Run the invoices migration in your Supabase SQL editor to enable this feature. Create
              the <code className="font-mono bg-amber-100 px-1 rounded">invoices</code> table with
              the columns used by this page.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <PageHeader
        title="Invoices & Quotes"
        subtitle="Manage invoices and quotes for RMA jobs"
        className="mb-6"
      >
        {!isViewer && !tableMissing && (
          <Button onClick={openCreate}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            New Invoice / Quote
          </Button>
        )}
      </PageHeader>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab}
            {tab !== 'All' && (
              <span className="ml-1.5 text-xs text-gray-500">
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

      {/* Table */}
      {visibleInvoices.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          <EmptyState
            title={tableMissing ? 'Invoices table not set up' : 'No invoices found'}
            description={
              tableMissing
                ? 'Run the migration to get started.'
                : 'Try a different filter or create a new invoice.'
            }
            action={!isViewer && !tableMissing ? openCreate : undefined}
            actionLabel="New Invoice / Quote"
          />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Invoice #
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Customer
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Ticket
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Total
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Due Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Created
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleInvoices.map((inv) => (
                  <InvoiceRow
                    key={inv.id}
                    inv={inv}
                    isAdmin={isAdmin}
                    isManager={isManager}
                    isTech={isTech}
                    formatDate={formatDate}
                    onEdit={() => openEdit(inv)}
                    onExportPDF={() => exportPDF(inv)}
                    onMarkSent={() =>
                      openConfirm('Mark as Sent', `Mark ${inv.invoice_number} as Sent?`, () => {
                        closeConfirm()
                        updateStatus(inv, 'sent')
                      })
                    }
                    onMarkPaid={() =>
                      openConfirm('Mark as Paid', `Mark ${inv.invoice_number} as Paid?`, () => {
                        closeConfirm()
                        updateStatus(inv, 'paid')
                      })
                    }
                    onVoid={() =>
                      openConfirm('Void Invoice', `Void ${inv.invoice_number}?`, () => {
                        closeConfirm()
                        updateStatus(inv, 'void')
                      })
                    }
                    onDelete={isAdmin ? () => handleDelete(inv) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
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

// ─── Invoice Row ─────────────────────────────────────────────────────────────

function InvoiceRow({
  inv,
  isAdmin,
  isManager,
  isTech: _isTech,
  formatDate,
  onEdit,
  onExportPDF,
  onMarkSent,
  onMarkPaid,
  onVoid,
  onDelete,
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const canChangeStatus = isManager
  const canEdit = isManager
  const canDelete = isAdmin

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 font-mono text-xs font-semibold text-indigo-700">
        {inv.invoice_number}
      </td>
      <td className="px-4 py-3">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_CLS[inv.type] || 'bg-gray-100 text-gray-600'}`}
        >
          {inv.type === 'quote' ? 'Quote' : 'Invoice'}
        </span>
      </td>
      <td className="px-4 py-3">
        <p className="font-medium text-gray-800 truncate max-w-[160px]">
          {inv.customer_name || '—'}
        </p>
        {inv.customer_email && (
          <p className="text-xs text-gray-500 truncate max-w-[160px]">{inv.customer_email}</p>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-gray-500">{inv.rma_number_ref || '—'}</td>
      <td className="px-4 py-3">
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLS[inv.status] || 'bg-gray-100 text-gray-600'}`}
        >
          {inv.status ? inv.status.charAt(0).toUpperCase() + inv.status.slice(1) : 'Draft'}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-semibold text-gray-800">${fmt(inv.total)}</td>
      <td className="px-4 py-3 text-gray-500 text-xs">
        {inv.due_date ? formatDate(inv.due_date) : '—'}
      </td>
      <td className="px-4 py-3 text-gray-500 text-xs">
        {inv.created_at ? formatDate(inv.created_at) : '—'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2 relative">
          <button
            onClick={onExportPDF}
            title="Export PDF"
            aria-label="Export PDF"
            className="p-1.5 rounded-lg text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
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
                className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                </svg>
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-xl z-40 py-1 text-sm">
                    {canEdit && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onEdit()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700"
                      >
                        Edit
                      </button>
                    )}
                    {canChangeStatus && inv.status === 'draft' && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onMarkSent()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700"
                      >
                        Mark Sent
                      </button>
                    )}
                    {canChangeStatus && inv.status === 'sent' && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onMarkPaid()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-gray-50 text-gray-700"
                      >
                        Mark Paid
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
                        Void
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={() => {
                          setMenuOpen(false)
                          onDelete()
                        }}
                        className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 border-t border-gray-100"
                      >
                        Delete
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
