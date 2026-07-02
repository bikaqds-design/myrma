import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { useURLTab } from '../../hooks/useURLTab'
import { PageHeader, Button } from '../../components/ui'
import { PageSkeleton } from '../../components/Skeleton'
import {
  CreateVendorModal,
  CreateProformaInvoiceModal,
  CreatePurchaseOrderModal,
  CreateVendorInvoiceModal,
} from './_modals'

const DOC_TYPE_BADGE = {
  proforma_invoice: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400',
  purchase_order: 'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400',
  vendor_invoice: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
}

const STATUS_PILL = {
  draft: 'bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]',
  sent: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  accepted: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  confirmed: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  partially_received: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  received: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  cancelled: 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#4a5568]',
}

function statusPillCls(status) {
  return STATUS_PILL[status] ?? STATUS_PILL.draft
}

// ─── Purchasing — Sprint 9: Vendor -> PI -> PO -> Vendor Invoice -> Receive ────
// Mirrors /sales structurally, powered by v_purchase_documents (same
// UNION-view pattern as v_sales_documents). Deliberately a smaller v1 than
// SalesDocuments (no sort/filter/pagination/bulk actions yet) — this is a
// new module, not a many-iteration-refined one; add those if usage justifies it.
export default function Purchasing({ currentUserEmail }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [tab, setTab] = useURLTab('tab', 'all')
  const [search, setSearch] = useState('')
  const [createModal, setCreateModal] = useState(null)

  const { data, isLoading } = useQuery({
    queryKey: ['purchasing'],
    queryFn: async () => {
      const [allRes, vendorList] = await Promise.all([
        db.purchaseDocuments.listAll(),
        db.vendors.list().catch(() => []),
      ])
      return { allRes, vendorList }
    },
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['purchasing'] })

  const allDocs = useMemo(
    () => (data?.allRes?.missing ? [] : (data?.allRes?.data ?? [])),
    [data]
  )
  const vendors = useMemo(() => data?.vendorList ?? [], [data])
  const vendorName = (id) => vendors.find((v) => v.id === id)?.name || '—'

  const filteredDocs = useMemo(() => {
    let rows = allDocs
    if (tab !== 'all') rows = rows.filter((d) => d.doc_type === tab)
    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((d) => {
        const vName = vendors.find((v) => v.id === d.vendor_id)?.name || ''
        return d.doc_code?.toLowerCase().includes(q) || vName.toLowerCase().includes(q)
      })
    }
    return rows
  }, [allDocs, tab, search, vendors])

  const tabs = [
    { id: 'all', label: t('purchasing.tabAll'), count: allDocs.length },
    {
      id: 'proforma_invoice',
      label: t('purchasing.tabProformaInvoices'),
      count: allDocs.filter((d) => d.doc_type === 'proforma_invoice').length,
    },
    {
      id: 'purchase_order',
      label: t('purchasing.tabPurchaseOrders'),
      count: allDocs.filter((d) => d.doc_type === 'purchase_order').length,
    },
    {
      id: 'vendor_invoice',
      label: t('purchasing.tabVendorInvoices'),
      count: allDocs.filter((d) => d.doc_type === 'vendor_invoice').length,
    },
    { id: 'vendors', label: t('purchasing.tabVendors'), count: vendors.length },
  ]

  if (isLoading) return <PageSkeleton cols={6} />

  return (
    <div className="space-y-6">
      <PageHeader title={t('purchasing.title')} subtitle={t('purchasing.subtitle')}>
        {tab === 'vendors' ? (
          <Button variant="primary" size="sm" onClick={() => setCreateModal('vendor')}>
            {t('purchasing.newVendor')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateModal('proforma_invoice')}>
              {t('purchasing.newProformaInvoice')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setCreateModal('purchase_order')}>
              {t('purchasing.newPurchaseOrder')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreateModal('vendor_invoice')}>
              {t('purchasing.newVendorInvoice')}
            </Button>
          </>
        )}
      </PageHeader>

      <div className="border-b border-[#e6e9ef] dark:border-[#212a38]">
        <div className="flex gap-1 overflow-x-auto">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === tb.id ? 'border-[#4338ca] text-[#4338ca] dark:border-[#a5b4fc] dark:text-[#a5b4fc]' : 'border-transparent text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]'}`}
            >
              {tb.label} ({tb.count})
            </button>
          ))}
        </div>
      </div>

      {tab !== 'vendors' && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('purchasing.searchPlaceholder')}
          className="max-w-md w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] shadow-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
        />
      )}

      {tab === 'vendors' ? (
        <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('purchasing.colVendorName'),
                    t('purchasing.colContactPerson'),
                    t('purchasing.colEmail'),
                    t('purchasing.colPhone'),
                    t('purchasing.colPaymentTerms'),
                  ].map((h, i) => (
                    <th key={i} className="px-5 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
                {vendors.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                      {t('purchasing.noVendorsYet')}
                    </td>
                  </tr>
                ) : (
                  vendors.map((v) => (
                    <tr key={v.id} className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]">
                      <td className="px-5 py-3 font-medium text-[#211f1b] dark:text-[#e8ebf0]">{v.name}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.contact_person || '—'}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.email || '—'}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.phone || '—'}</td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{v.payment_terms || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">
                <tr>
                  {[
                    t('purchasing.colType'),
                    t('purchasing.colCode'),
                    t('purchasing.colVendor'),
                    t('purchasing.colDate'),
                    t('purchasing.colTotal'),
                    t('purchasing.colStatus'),
                  ].map((h, i) => (
                    <th key={i} className="px-5 py-3 text-left text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
                {filteredDocs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                      {t('purchasing.noDocumentsYet')}
                    </td>
                  </tr>
                ) : (
                  filteredDocs.map((d) => (
                    <tr
                      key={`${d.doc_type}-${d.id}`}
                      className="hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230] cursor-pointer transition-colors"
                      onClick={() => navigate(`/purchasing/${d.doc_type}/${d.id}`)}
                    >
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${DOC_TYPE_BADGE[d.doc_type]}`}>
                          {t(`purchasing.docType_${d.doc_type}`)}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-[#211f1b] dark:text-[#e8ebf0]">
                        {d.doc_code || t('purchasing.pendingCode')}
                      </td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{vendorName(d.vendor_id)}</td>
                      <td className="px-5 py-3 text-[#6c6760] dark:text-[#9aa4b2]">
                        {new Date(d.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{Number(d.total).toLocaleString()}</td>
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusPillCls(d.doc_status)}`}>
                          {t(`purchasing.st_${d.doc_status}`)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {createModal === 'vendor' && (
        <CreateVendorModal
          onClose={() => setCreateModal(null)}
          userEmail={currentUserEmail}
          onSuccess={invalidate}
        />
      )}
      {createModal === 'proforma_invoice' && (
        <CreateProformaInvoiceModal
          onClose={() => setCreateModal(null)}
          vendors={vendors}
          userEmail={currentUserEmail}
          onSuccess={invalidate}
        />
      )}
      {createModal === 'purchase_order' && (
        <CreatePurchaseOrderModal
          onClose={() => setCreateModal(null)}
          vendors={vendors}
          userEmail={currentUserEmail}
          onSuccess={invalidate}
        />
      )}
      {createModal === 'vendor_invoice' && (
        <CreateVendorInvoiceModal
          onClose={() => setCreateModal(null)}
          vendors={vendors}
          userEmail={currentUserEmail}
          onSuccess={invalidate}
        />
      )}
    </div>
  )
}
