import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { PageSkeleton } from '../../components/Skeleton'
import EmptyState from '../../components/EmptyState'
import { Button, Ltr } from '../../components/ui'
import { DOC_TYPE_BADGE, docTypeLabel, statusLabel, statusPillCls } from './_shared'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

/**
 * VendorDetails — the AP counterpart to CustomerDetails.
 *
 * Vendors previously existed only as a row in a table with an Edit modal, so
 * "what have we bought from ASRock and what do we still owe them" meant reading
 * three separate screens and adding it up by hand. This puts the vendor's
 * documents, their statement and their balance on one page.
 *
 * The ledger and running balance mirror the Customer Details Billing tab
 * deliberately — same signed-amount convention, same running total — so the AR
 * and AP statements read identically. Positive is what we owe them (an invoice),
 * negative is what we have paid.
 *
 * Vendors are Brands (Purchase Module redesign 9R): there is no vendors table,
 * so the profile fields come from `brands`.
 */

/** Money in the vendor's documents was never committed if the doc was killed. */
const DEAD_STATUSES = new Set(['cancelled', 'void', 'voided'])

function fmtMoney(n) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString() : '—'
}

function StatTile({ label, value, tone = 'default', hint = null }) {
  const toneCls =
    tone === 'warn'
      ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
      : 'bg-gray-50 dark:bg-[#0f1520] border-gray-200 dark:border-[#212a38]'
  return (
    <div className={`rounded-xl border p-4 ${toneCls}`}>
      <div className="text-xs uppercase text-gray-500 dark:text-[#9aa4b2] mb-1">{label}</div>
      <div className="text-xl font-bold text-gray-900 dark:text-[#e8ebf0]">{value}</div>
      {hint && <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">{hint}</div>}
    </div>
  )
}

/**
 * `autoDir` renders the value with dir="auto" so the browser infers direction
 * from its first strong character. Needed for free-text fields a user may type
 * in either script: "30 days" inside an RTL page renders as "days 30" without
 * it, because the digits and the Latin word get reordered by the bidi algorithm.
 * Unlike <Ltr>, this stays correct if the value is actually Arabic.
 */
function Field({ label, children, autoDir = false }) {
  return (
    <div>
      <div className="text-xs uppercase text-gray-500 dark:text-[#9aa4b2] mb-0.5">{label}</div>
      <div className="text-sm text-gray-900 dark:text-[#e8ebf0]" {...(autoDir ? { dir: 'auto' } : {})}>
        {children || '—'}
      </div>
    </div>
  )
}

export default function VendorDetails({ vendorId, onBack, onOpenDocument, onEditVendor, canEdit = false }) {
  const { t } = useTranslation()

  const { data: vendorList = EMPTY_ARRAY, isLoading: loadingVendor } = useQuery({
    queryKey: ['brands'],
    queryFn: () => db.brands.list(),
    staleTime: 60_000,
  })
  const vendor = useMemo(() => vendorList.find((v) => v.id === vendorId) || null, [vendorList, vendorId])

  const { data: docsRes, isLoading: loadingDocs } = useQuery({
    queryKey: ['purchase-documents'],
    queryFn: () => db.purchaseDocuments.listAll(),
  })
  const documents = useMemo(() => {
    const all = docsRes?.missing ? [] : (docsRes?.data ?? [])
    return all
      .filter((d) => d.vendor_id === vendorId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [docsRes, vendorId])

  const { data: ledger = EMPTY_ARRAY, isLoading: loadingLedger } = useQuery({
    queryKey: ['vendor-ledger', vendorId],
    queryFn: () => db.vendorLedger.list(vendorId),
    enabled: !!vendorId,
  })

  // Spend counts only documents that still stand — a cancelled PO never cost
  // anything, and including it would inflate every vendor's total.
  const totalSpend = useMemo(
    () =>
      documents
        .filter((d) => !DEAD_STATUSES.has(String(d.doc_status || '').toLowerCase()))
        .reduce((sum, d) => sum + (Number(d.total) || 0), 0),
    [documents]
  )

  // The ledger is signed: invoices positive, payments negative. The sum is what
  // is still owed, which is why it needs no separate query.
  const outstanding = useMemo(
    () => ledger.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    [ledger]
  )

  if (loadingVendor || loadingDocs) return <PageSkeleton />

  if (!vendor) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="text-sm text-gray-500 hover:text-indigo-600 mb-4">
          ← {t('common.back')}
        </button>
        <EmptyState title={t('purchasing.vendorNotFound')} />
      </div>
    )
  }

  const LEDGER_TYPE_LABEL_KEY = {
    vendor_invoice: 'purchasing.ledgerTypeVendorInvoice',
    vendor_payment: 'purchasing.ledgerTypeVendorPayment',
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <button onClick={onBack} className="text-sm text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 flex items-center gap-1">
          ← {t('common.back')}
        </button>
        {canEdit && (
          <Button variant="secondary" size="sm" onClick={() => onEditVendor?.(vendor)}>
            {t('common.edit')}
          </Button>
        )}
      </div>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] p-5">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-[#e8ebf0]">{vendor.brand_name}</h1>
        {vendor.contact_person && (
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">{vendor.contact_person}</p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
          <Field label={t('purchasing.vendorEmail')}>
            {vendor.email ? <Ltr>{vendor.email}</Ltr> : null}
          </Field>
          <Field label={t('purchasing.vendorPhone')}>
            {vendor.phone ? <Ltr>{vendor.phone}</Ltr> : null}
          </Field>
          <Field label={t('purchasing.vendorTaxId')} autoDir>{vendor.tax_id}</Field>
          <Field label={t('purchasing.vendorPaymentTerms')} autoDir>{vendor.payment_terms}</Field>
        </div>
      </div>

      {/* ── Totals ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile
          label={t('purchasing.vendorTotalSpend')}
          value={`${fmtMoney(totalSpend)} ${t('purchasing.currencyCode')}`}
          hint={t('purchasing.vendorSpendHint')}
        />
        <StatTile
          label={t('purchasing.vendorOutstanding')}
          value={`${fmtMoney(outstanding)} ${t('purchasing.currencyCode')}`}
          tone={outstanding > 0.001 ? 'warn' : 'default'}
        />
        <StatTile label={t('purchasing.vendorDocumentCount')} value={documents.length.toLocaleString()} />
      </div>

      {/* ── Documents ──────────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
        <div className="px-5 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {t('purchasing.vendorDocuments')}
          </h2>
        </div>
        {documents.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-[#9aa4b2]">
            {t('purchasing.vendorNoDocuments')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('purchasing.colType')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('purchasing.colCode')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('purchasing.colStatus')}</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('purchasing.colTotal')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('purchasing.colCreated')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
                {documents.map((doc) => (
                  <tr
                    key={`${doc.doc_type}-${doc.id}`}
                    onClick={() => onOpenDocument?.(doc)}
                    className="cursor-pointer hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]"
                  >
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${DOC_TYPE_BADGE[doc.doc_type] || ''}`}>
                        {docTypeLabel(doc.doc_type, t)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc]">
                      {doc.doc_code || t('purchasing.pendingCode')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(doc.doc_status)}`}>
                          {statusLabel(doc.doc_status, t)}
                        </span>
                        {doc.doc_type === 'vendor_invoice' && doc.payment_status && (
                          <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusPillCls(doc.payment_status)}`}>
                            {statusLabel(doc.payment_status, t)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900 dark:text-[#e8ebf0]">{fmtMoney(doc.total)}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-[#9aa4b2]">{fmtDate(doc.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Statement ──────────────────────────────────────────────────────── */}
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38]">
        <div className="px-5 py-3 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {t('purchasing.vendorStatement')}
          </h2>
        </div>
        {loadingLedger ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-[#9aa4b2]">{t('common.loading')}</div>
        ) : ledger.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-[#9aa4b2]">
            {t('purchasing.vendorNoLedger')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerDate')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerType')}</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerCode')}</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerAmount')}</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase">{t('customerDetails.colLedgerBalance')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-[#1a2230]">
                {(() => {
                  let running = 0
                  return ledger.map((entry) => {
                    running += Number(entry.amount) || 0
                    return (
                      <tr key={entry.id}>
                        <td className="px-4 py-3 text-gray-500 dark:text-[#9aa4b2]">{fmtDate(entry.entry_date)}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-[#9aa4b2]">
                          {t(LEDGER_TYPE_LABEL_KEY[entry.entry_type] ?? entry.entry_type)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-[#e8ebf0]">{entry.entry_code || '—'}</td>
                        <td className={`px-4 py-3 text-right font-medium ${entry.amount >= 0 ? 'text-gray-900 dark:text-[#e8ebf0]' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {entry.amount >= 0 ? '+' : ''}{fmtMoney(entry.amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-500 dark:text-[#9aa4b2]">{fmtMoney(running)}</td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
