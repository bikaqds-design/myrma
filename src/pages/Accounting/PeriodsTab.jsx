import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Label, Textarea } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { monthsToShow, periodActions, validateReopenReason, REOPEN_REASON_MIN } from './_periods'

// Accounting › Periods (A-03 over 20260910). A month is open, soft closed
// (only an accountant or administrator may post dated in it) or closed
// (nothing posts). Finance soft closes, closes, and reopens a soft-closed
// month; a closed month is reopened only when an administrator other than the
// one who asked approves. The database enforces all of it; this screen offers
// what it allows and shows its refusal as it is.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const th = 'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const STATUS_CLS = {
  open: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-300',
  soft_closed: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
  closed: 'bg-slate-200 dark:bg-[#212a38] text-[#211f1b] dark:text-[#e8ebf0]',
}
// items whose amount is money worth showing
const MONEY_ITEMS = new Set(['draft_sales_invoices', 'unissued_credit_notes', 'unapproved_supplier_invoices',
  'pending_supplier_payments', 'pending_refunds', 'grni_balance'])

export default function PeriodsTab({ currentUserEmail, currentUserRole }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(null)
  const [asking, setAsking] = useState(null)   // month for a reopen request
  const [deciding, setDeciding] = useState(null) // { request, approve: boolean }

  const { data: periods = EMPTY_ARRAY, error } = useQuery({
    queryKey: ['accounting-periods', 'list'],
    queryFn: () => db.periods.list(),
    staleTime: 30_000,
  })
  const { data: requests = EMPTY_ARRAY } = useQuery({
    queryKey: ['accounting-periods', 'requests'],
    queryFn: () => db.periods.pendingRequests(),
    staleTime: 30_000,
  })

  const byMonth = new Map(periods.map((p) => [String(p.period_start).slice(0, 10), p]))
  const pendingByMonth = new Map(requests.map((r) => [String(r.period_start).slice(0, 10), r]))
  const months = monthsToShow(periods)
  const monthLabel = (m) => {
    const [y, mo] = m.split('-').map(Number)
    return new Date(y, mo - 1, 1).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })
  }

  // a ref as well as the state: a second click can land before the re-render
  const inFlight = useRef(false)
  const run = async (fn, okKey) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      toast.success(t(okKey))
      queryClient.invalidateQueries({ queryKey: ['accounting-periods'] })
      return true
    } catch (err) {
      toast.error(err?.message || t('common.error'), { duration: 7000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const act = (action, month, pending) => {
    const label = monthLabel(month)
    if (action === 'soft_close') {
      confirm({
        title: t('accounting.pcSoftCloseTitle', { month: label }),
        message: t('accounting.pcSoftCloseConfirm'),
        confirmLabel: t('accounting.pcSoftClose'),
        tone: 'primary',
        onConfirm: () => run(() => db.periods.softClose(month), 'accounting.pcSoftClosedToast'),
      })
    } else if (action === 'close') {
      confirm({
        title: t('accounting.pcCloseTitle', { month: label }),
        message: t('accounting.pcCloseConfirm'),
        confirmLabel: t('accounting.pcClose'),
        tone: 'primary',
        onConfirm: () => run(() => db.periods.close(month), 'accounting.pcClosedToast'),
      })
    } else if (action === 'reopen') {
      confirm({
        title: t('accounting.pcReopenTitle', { month: label }),
        message: t('accounting.pcReopenConfirm'),
        confirmLabel: t('accounting.pcReopen'),
        tone: 'primary',
        onConfirm: () => run(() => db.periods.reopenSoftClosed(month), 'accounting.pcReopenedToast'),
      })
    } else if (action === 'request_reopen') {
      setAsking(month)
    } else if (action === 'approve') {
      setDeciding({ request: pending, approve: true })
    } else if (action === 'reject') {
      setDeciding({ request: pending, approve: false })
    } else if (action === 'withdraw') {
      confirm({
        title: t('accounting.pcWithdrawTitle', { month: label }),
        message: t('accounting.pcWithdrawConfirm'),
        confirmLabel: t('accounting.pcWithdraw'),
        onConfirm: () => run(() => db.periods.rejectReopen(pending.id), 'accounting.pcWithdrawnToast'),
      })
    }
  }

  const ACTION_LABEL = {
    soft_close: 'accounting.pcSoftClose',
    close: 'accounting.pcClose',
    reopen: 'accounting.pcReopen',
    request_reopen: 'accounting.pcRequestReopen',
    approve: 'accounting.pcApprove',
    reject: 'accounting.pcReject',
    withdraw: 'accounting.pcWithdraw',
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.pcHint')}</p>
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.pcColMonth')}</th>
              <th className={`${th} text-start`}>{t('accounting.pcColStatus')}</th>
              <th className={`${th} text-start`}>{t('accounting.pcColBy')}</th>
              <th className={`${th} text-end`}>{t('accounting.pcColActions')}</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={4} role="alert" className="py-12 text-center text-sm text-red-600 dark:text-red-400">{error.message}</td>
              </tr>
            ) : (
              months.map((m) => {
                const p = byMonth.get(m)
                const status = p?.status || 'open'
                const pending = pendingByMonth.get(m) || null
                const actions = periodActions({ month: m, status, role: currentUserRole, me: currentUserEmail, pending })
                const by = status === 'closed' ? p?.closed_by : status === 'soft_closed' ? p?.soft_closed_by : p?.reopened_by
                return (
                  <React.Fragment key={m}>
                    <tr className="border-b border-[#f0f2f6] dark:border-[#1a2230] align-top">
                      <td className="px-4 py-3 font-medium text-[#211f1b] dark:text-[#e8ebf0]">
                        <button
                          type="button"
                          className="hover:underline text-start"
                          aria-expanded={expanded === m}
                          aria-controls={`pc-check-${m}`}
                          onClick={() => setExpanded(expanded === m ? null : m)}
                        >
                          {monthLabel(m)}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLS[status]}`}>
                          {t(`accounting.pcStatus_${status}`)}
                        </span>
                        {pending && (
                          <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">
                            {t('accounting.pcPendingBy', { email: pending.requested_by })}: {pending.reason}
                          </div>
                        )}
                        {status !== 'closed' && p?.reopen_reason && (
                          <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">
                            {t('accounting.pcReopenedFor', { reason: p.reopen_reason })}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{by || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-2">
                          {actions.map((a) => a === 'waiting' ? (
                            <span key={a} className="text-xs text-[#6c6760] dark:text-[#9aa4b2] self-center">{t('accounting.pcWaiting')}</span>
                          ) : (
                            <Button
                              key={a}
                              size="sm"
                              variant={a === 'reject' || a === 'withdraw' ? 'secondary' : 'primary'}
                              disabled={busy}
                              onClick={() => act(a, m, pending)}
                            >
                              {t(ACTION_LABEL[a])}
                            </Button>
                          ))}
                          <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === m ? null : m)} aria-expanded={expanded === m}>
                            {t('accounting.pcChecklist')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {expanded === m && (
                      <tr id={`pc-check-${m}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230] bg-[#f8f9fb] dark:bg-[#0f1520]">
                        <td colSpan={4} className="px-4 py-3">
                          <Checklist month={m} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {asking && (
        <ReopenRequestModal
          month={monthLabel(asking)}
          busy={busy}
          onClose={() => setAsking(null)}
          onSubmit={async (reason) => {
            if (await run(() => db.periods.requestReopen(asking, reason), 'accounting.pcRequestedToast')) setAsking(null)
          }}
        />
      )}
      {deciding && (
        <DecideModal
          month={monthLabel(String(deciding.request.period_start).slice(0, 10))}
          request={deciding.request}
          approve={deciding.approve}
          busy={busy}
          onClose={() => setDeciding(null)}
          onSubmit={async (note) => {
            const ok = await run(
              () => deciding.approve
                ? db.periods.approveReopen(deciding.request.id, note)
                : db.periods.rejectReopen(deciding.request.id, note),
              deciding.approve ? 'accounting.pcApprovedToast' : 'accounting.pcRejectedToast'
            )
            if (ok) setDeciding(null)
          }}
        />
      )}
      {confirmDialog}
    </div>
  )
}

function Checklist({ month }) {
  const { t } = useTranslation()
  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['accounting-periods', 'checklist', month],
    queryFn: () => db.periods.checklist(month),
    staleTime: 30_000,
  })
  if (isLoading) return <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</p>
  if (error) return <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error.message}</p>
  return (
    <div>
      <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mb-2">{t('accounting.pcChecklistHint')}</p>
      <ul className="space-y-1">
        {rows.map((r) => {
          const na = r.item_count === null || r.item_count === undefined
          const clear = !na && Number(r.item_count) === 0
          return (
            <li key={r.item} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-[#211f1b] dark:text-[#e8ebf0]">
                <span aria-hidden="true" className={na ? 'text-[#a09d99]' : clear ? 'text-green-600' : 'text-amber-600'}>
                  {na ? '–' : clear ? '✓' : '!'}
                </span>{' '}
                {t(`accounting.pcItem_${r.item}`)}
              </span>
              <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">
                {na
                  ? t('accounting.pcNotAvailable')
                  : r.item === 'grni_balance'
                    ? fmtMoney(r.amount)
                    : MONEY_ITEMS.has(r.item) && Number(r.item_count) > 0
                      ? `${r.item_count} · ${fmtMoney(r.amount)}`
                      : String(r.item_count)}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ReopenRequestModal({ month, busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState(null)
  const submit = () => {
    const e = validateReopenReason(reason)
    if (e) { setErr(t(e, { min: REOPEN_REASON_MIN })); return }
    onSubmit(reason.trim())
  }
  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('accounting.pcRequestTitle', { month })} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full">
        <div className="px-5 py-4 space-y-3">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.pcRequestTitle', { month })}</h2>
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.pcRequestHint')}</p>
          <Label htmlFor="pc-reason" required>{t('accounting.pcReason')}</Label>
          <Textarea id="pc-reason" rows={3} value={reason} aria-invalid={Boolean(err)} onChange={(e) => { setReason(e.target.value); setErr(null) }} />
          {err && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" loading={busy} onClick={submit}>{t('accounting.pcRequestReopen')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

function DecideModal({ month, request, approve, busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const [note, setNote] = useState('')
  const title = t(approve ? 'accounting.pcApproveTitle' : 'accounting.pcRejectTitle', { month })
  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={title} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full">
        <div className="px-5 py-4 space-y-3">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{title}</h2>
          <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0]">
            {t('accounting.pcPendingBy', { email: request.requested_by })}: {request.reason}
          </p>
          {approve && <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.pcApproveHint')}</p>}
          <Label htmlFor="pc-note">{t('accounting.pcNote')}</Label>
          <Textarea id="pc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" variant={approve ? 'primary' : 'danger'} loading={busy} onClick={() => onSubmit(note.trim())}>
              {t(approve ? 'accounting.pcApprove' : 'accounting.pcReject')}
            </Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
