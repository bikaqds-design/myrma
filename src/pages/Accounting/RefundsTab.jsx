import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { useCustomerSearch, useCustomer } from '../../lib/useLookups'
import { ModalOverlay, ModalCard, Button, Label, Input, Select, Textarea } from '../../components/ui'
import Pagination from '../../components/Pagination'
import { ROLES } from '../../lib/constants'
import { canDo } from '../../lib/permissions'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { canApproveRefund, validateRefund } from './_refunds'

// Customer refunds (P-05d over 20260904). A manager records one; a DIFFERENT
// manager approves it (owner decision) — the database enforces both and every
// amount rule, this screen only offers what they allow and shows its refusal.

const METHODS = ['bank_transfer', 'cash', 'check', 'card', 'other']
const METHOD_LABEL_KEY = {
  cash: 'accounting.methodCash',
  bank_transfer: 'accounting.methodBankTransfer',
  check: 'accounting.methodCheck',
  card: 'accounting.methodCard',
  other: 'accounting.methodOther',
}
const PILL = {
  pending_approval: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  approved: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  rejected: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
}
const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function RefundsTab({ currentUserEmail, currentUserRole, currentUserPermissions, perPage, setPerPage }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isManager = [ROLES.MANAGER, ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(currentUserRole)
  // recording / rejecting and approving are separate permissions in the
  // database (accounting.refund, accounting.approve_refund; 20260914)
  const canRecordRefund = isManager && canDo(currentUserRole, currentUserPermissions, 'accounting', 'refund')
  const canApproveRefunds = isManager && canDo(currentUserRole, currentUserPermissions, 'accounting', 'approve_refund')
  const [page, setPage] = useState(1)
  const [showRecord, setShowRecord] = useState(false)
  const [rejecting, setRejecting] = useState(null)
  const [busy, setBusy] = useState(false)

  const { data: result, isLoading } = useQuery({
    queryKey: ['customer-refunds', 'page', page, perPage],
    queryFn: () => db.customerRefunds.listPage(page, perPage),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const rows = result?.data ?? EMPTY_ARRAY
  const count = result?.count ?? 0
  useEffect(() => {
    const pages = Math.ceil(count / perPage)
    if (result && pages >= 1 && page > pages) setPage(pages)
  }, [result, count, page, perPage])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['customer-refunds'] })
    queryClient.invalidateQueries({ queryKey: ['payments'] })
    queryClient.invalidateQueries({ queryKey: ['ar-aging'] })
    queryClient.invalidateQueries({ queryKey: ['sales-documents'] })
  }
  // A ref, not only the busy state: a second click can land before the
  // re-render, and approving must reach the server once.
  const inFlight = useRef(false)
  const run = async (fn, okKey) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      toast.success(t(okKey))
      refresh()
    } catch (err) {
      toast.error(err?.message || t('common.error'), { duration: 7000 })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const th = 'px-4 py-3 text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] uppercase'
  const sourceCode = (r) => r.credit_note?.cn_code || r.payment?.payment_code || '—'

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.rfHint')}</p>
        {canRecordRefund && <Button onClick={() => setShowRecord(true)}>+ {t('accounting.rfRecord')}</Button>}
      </div>

      <div className="bg-white dark:bg-[#121823] rounded-xl border border-[#e6e9ef] dark:border-[#212a38] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.colCode')}</th>
              <th className={`${th} text-start`}>{t('accounting.colCustomer')}</th>
              <th className={`${th} text-start`}>{t('accounting.rfColSource')}</th>
              <th className={`${th} text-start`}>{t('accounting.colMethod')}</th>
              <th className={`${th} text-start`}>{t('accounting.colDate')}</th>
              <th className={`${th} text-end`}>{t('accounting.colAmount')}</th>
              <th className={`${th} text-start`}>{t('accounting.colStatus')}</th>
              <th className={`${th} text-end`}>{t('accounting.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.rfNone')}</td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-[#211f1b] dark:text-[#e8ebf0]">{r.refund_code || '—'}</td>
                  <td className="px-4 py-3 text-[#211f1b] dark:text-[#e8ebf0]">{r.customer?.company_name || r.customer?.contact_person || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[#6c6760] dark:text-[#9aa4b2]">{sourceCode(r)}</td>
                  <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{t(METHOD_LABEL_KEY[r.method] ?? r.method)}</td>
                  <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2]">{r.refund_date}</td>
                  <td className="px-4 py-3 text-end font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.amount)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PILL[r.status] ?? PILL.pending_approval}`}>
                      {t(`accounting.rfStatus_${r.status}`)}
                    </span>
                    {r.status === 'rejected' && r.reject_reason && (
                      <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{r.reject_reason}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end">
                    {r.status === 'pending_approval' && (canRecordRefund || canApproveRefunds) && (
                      <div className="flex justify-end gap-2">
                        {canApproveRefunds && canApproveRefund(r, currentUserEmail) ? (
                          <Button size="sm" loading={busy}
                            onClick={() => run(() => db.customerRefunds.approve(r.id, currentUserEmail), 'accounting.rfApprovedToast')}>
                            {t('accounting.rfApprove')}
                          </Button>
                        ) : (
                          <span className="text-xs italic text-[#6c6760] dark:text-[#9aa4b2] self-center">{t('accounting.rfAwaitingOther')}</span>
                        )}
                        {canRecordRefund && (
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRejecting(r)}>
                            {t('accounting.rfReject')}
                          </Button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {count > 0 && <Pagination total={count} page={page} itemsPerPage={perPage} setItemsPerPage={setPerPage} onPage={setPage} />}

      {showRecord && (
        <RecordRefundModal
          busy={busy}
          onClose={() => setShowRecord(false)}
          onSubmit={(input) => run(async () => {
            await db.customerRefunds.record({ ...input, actorEmail: currentUserEmail })
            setShowRecord(false)
          }, 'accounting.rfRecordedToast')}
        />
      )}
      {rejecting && (
        <RejectRefundModal
          busy={busy}
          onClose={() => setRejecting(null)}
          onSubmit={(reason) => run(async () => {
            await db.customerRefunds.reject(rejecting.id, reason, currentUserEmail)
            setRejecting(null)
          }, 'accounting.rfRejectedToast')}
        />
      )}
    </>
  )
}

function RecordRefundModal({ busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const [customerId, setCustomerId] = useState('')
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerOpen, setCustomerOpen] = useState(false)
  const { results: matches } = useCustomerSearch(customerQuery, { limit: 8, enabled: customerOpen })
  const customer = useCustomer(customerId)
  const { data: sources = EMPTY_ARRAY, isFetching: sourcesLoading } = useQuery({
    queryKey: ['refund-sources', customerId],
    queryFn: () => db.customerRefunds.sources(customerId),
    enabled: Boolean(customerId),
  })
  const [sourceKey, setSourceKey] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('bank_transfer')
  const [reference, setReference] = useState('')
  const [date, setDate] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState(null)

  const source = sources.find((s) => `${s.type}:${s.id}` === sourceKey) || null

  const submit = () => {
    const res = validateRefund({ source, amount })
    if (res.error) { setError(t(res.error, { balance: source ? source.balance.toFixed(2) : '' })); return }
    onSubmit({
      sourceType: source.type, sourceId: source.id, amount: res.amount, method,
      referenceNumber: reference.trim() || null, refundDate: date || null, notes: notes.trim() || null,
    })
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('accounting.rfRecordTitle')} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-lg w-full">
        <div className="px-5 py-4 border-b border-[#e6e9ef] dark:border-[#212a38]">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.rfRecordTitle')}</h2>
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">{t('accounting.rfRecordHint')}</p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="relative">
            <Label htmlFor="rf-customer" required>{t('salesDocuments.fCustomer')}</Label>
            <Input
              id="rf-customer"
              autoComplete="off"
              placeholder={t('salesDocuments.selectCustomer')}
              value={customerId ? (customer?.company_name || customer?.contact_person || '') : customerQuery}
              onChange={(e) => { setCustomerId(''); setSourceKey(''); setError(null); setCustomerQuery(e.target.value); setCustomerOpen(true) }}
            />
            {customerOpen && !customerId && matches.length > 0 && (
              <div className="absolute top-full start-0 mt-1 w-full z-30 bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-[#e6e9ef] dark:border-[#212a38] py-1 max-h-48 overflow-y-auto">
                {matches.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setCustomerId(c.id); setCustomerQuery(''); setCustomerOpen(false) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]"
                  >
                    {c.company_name || c.contact_person}
                  </button>
                ))}
              </div>
            )}
          </div>

          {customerId && (
            <div>
              <Label htmlFor="rf-source" required>{t('accounting.rfSource')}</Label>
              {sourcesLoading ? (
                <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</p>
              ) : sources.length === 0 ? (
                <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.rfNoSources')}</p>
              ) : (
                <Select id="rf-source" value={sourceKey} onChange={(e) => { setError(null); setSourceKey(e.target.value) }}>
                  <option value="">{t('accounting.rfChooseSource')}</option>
                  {sources.map((s) => (
                    <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>
                      {t(s.type === 'credit_note' ? 'accounting.rfSourceCreditNote' : 'accounting.rfSourcePayment',
                        { code: s.code || '—', balance: fmtMoney(s.balance) })}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="rf-amount" required>{t('accounting.amount')}</Label>
              <Input id="rf-amount" type="number" min={0.01} step={0.01} value={amount}
                onChange={(e) => { setError(null); setAmount(e.target.value) }} aria-invalid={error ? true : undefined} />
            </div>
            <div>
              <Label htmlFor="rf-method">{t('accounting.method')}</Label>
              <Select id="rf-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => <option key={m} value={m}>{t(METHOD_LABEL_KEY[m])}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="rf-ref">{t('accounting.reference')}</Label>
              <Input id="rf-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="rf-date">{t('accounting.colDate')}</Label>
              <Input id="rf-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="rf-notes">{t('salesDocuments.fNotes')}</Label>
            <Textarea id="rf-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={submit} loading={busy}>{t('accounting.rfRecordSubmit')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

function RejectRefundModal({ busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('accounting.rfRejectTitle')} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full">
        <div className="px-5 py-4 space-y-3">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.rfRejectTitle')}</h2>
          <Label htmlFor="rf-reject-reason" required>{t('accounting.rfRejectReason')}</Label>
          <Textarea id="rf-reject-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" variant="danger" disabled={!reason.trim()} loading={busy} onClick={() => onSubmit(reason.trim())}>
              {t('accounting.rfReject')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
