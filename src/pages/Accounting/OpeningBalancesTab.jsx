import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Input, Label, Select, Spinner, ModalOverlay, ModalCard, Textarea } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { accountName } from './_ledger'
import { isFinanceRole } from './_periods'
import { parseCsv } from './_bank'
import { SECTION_FIELDS, OPENING_SECTIONS, equityBalances, guessOpeningMapping, mapOpeningRows, missingFields } from './_opening'

// Accounting › Opening balances (B-03 over 20260921; owner decisions
// 2026-09-30): a company's books as they stood the day before it starts — the
// trial balance, each open customer invoice and supplier bill, and the stock —
// imported by CSV, reviewed here, then posted against Opening balance equity.
// Administrators and accountants act; managers read.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'
const th = 'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'
const muted = 'text-[#6c6760] dark:text-[#9aa4b2]'

function lastDayOfPreviousMonth() {
  const d = new Date()
  const last = new Date(d.getFullYear(), d.getMonth(), 0)
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
}

// ── import one section ───────────────────────────────────────────────────────
function ImportSectionModal({ batchId, section, onClose, onStored }) {
  const { t, i18n } = useTranslation()
  const [csv, setCsv] = useState(null)
  const [mapping, setMapping] = useState(null)
  const [format, setFormat] = useState('ymd')
  const [errors, setErrors] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const fields = Object.keys(SECTION_FIELDS[section])
  const hasDates = section === 'receivables' || section === 'payables'

  const onFile = async (file) => {
    setErr(null); setErrors([])
    if (!file) return
    const parsed = parseCsv(await file.text())
    if (parsed.headers.length === 0) { setErr(t('accounting.bankErrEmpty')); return }
    setCsv(parsed)
    setMapping(guessOpeningMapping(section, parsed.headers))
  }

  const mapped = csv && mapping ? mapOpeningRows(section, csv.rows, mapping, format) : []
  const missing = mapping ? missingFields(section, mapping) : []

  const save = async () => {
    setErr(null); setErrors([])
    if (missing.length > 0) { setErr(t('accounting.obErrMissing', { fields: missing.map((f) => t(`accounting.obField_${f}`)).join(', ') })); return }
    if (mapped.length === 0) { setErr(t('accounting.bankErrNoLines')); return }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const res = await db.openingBalances.setRows(batchId, section, mapped.map((m) => m.row))
      if (res.errors?.length) {
        // the database counts the rows it was sent; name them by their row in the file
        setErrors(res.errors.map((e) => ({ ...e, fileRow: mapped[e.row - 1]?.sourceRow ?? e.row })))
      } else {
        toast.success(t('accounting.obStoredToast', { count: res.stored }))
        onStored()
      }
    } catch (ex) {
      setErr(ex?.message || t('common.error'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('accounting.obImportTitle')} dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-3xl w-full">
        <div className="p-5 space-y-4 max-h-[85vh] overflow-y-auto">
          <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">
            {t('accounting.obImportTitle')} · {t(`accounting.obSection_${section}`)}
          </h2>
          <p className={`text-sm ${muted}`}>{t(`accounting.obColumns_${section}`)}</p>
          <p className={`text-xs ${muted}`}>{t('accounting.obReplaceNote')}</p>
          <div>
            <Label htmlFor="ob-file">{t('accounting.bankFile')}</Label>
            <Input id="ob-file" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
          </div>

          {csv && mapping && (
            <>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
                {fields.map((f) => (
                  <div key={f}>
                    <Label htmlFor={`ob-map-${f}`}>{t(`accounting.obField_${f}`)}</Label>
                    <Select id={`ob-map-${f}`} value={mapping[f] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })}>
                      <option value="">{t('accounting.bankColNone')}</option>
                      {csv.headers.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}
                    </Select>
                  </div>
                ))}
                {hasDates && (
                  <div>
                    <Label htmlFor="ob-format">{t('accounting.bankDateFormat')}</Label>
                    <Select id="ob-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                      <option value="ymd">YYYY-MM-DD</option>
                      <option value="dmy">DD/MM/YYYY</option>
                      <option value="mdy">MM/DD/YYYY</option>
                    </Select>
                  </div>
                )}
              </div>
              <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.obRowsRead', { count: mapped.length })}</p>
            </>
          )}

          {errors.length > 0 && (
            <div role="alert" className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 space-y-1">
              <p className="text-sm font-semibold text-red-700 dark:text-red-300">{t('accounting.obRowErrors', { count: errors.length })}</p>
              <ul className="text-sm text-red-700 dark:text-red-300 space-y-0.5 max-h-48 overflow-y-auto">
                {errors.slice(0, 100).map((e) => <li key={e.row}>{t('accounting.obRowError', { row: e.fileRow, error: e.error })}</li>)}
              </ul>
            </div>
          )}
          {err && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={save} loading={busy} disabled={!csv}>{t('accounting.bankImport')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}

// ── one section's rows ───────────────────────────────────────────────────────
function SectionRows({ batchId, section }) {
  const { t, i18n } = useTranslation()
  const q = useQuery({
    queryKey: ['opening-balances', 'rows', batchId, section],
    queryFn: () => section === 'accounts' ? db.openingBalances.accounts(batchId)
      : section === 'stock' ? db.openingBalances.stock(batchId)
        : db.openingBalances.documents(batchId, section === 'receivables' ? 'receivable' : 'payable'),
  })
  if (q.isLoading) return <div className="py-4 flex justify-center"><Spinner /></div>
  if (q.error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{q.error.message}</p>
  const rows = q.data ?? EMPTY_ARRAY
  if (rows.length === 0) return <p className={`text-sm ${muted} px-3 py-3`}>{t('accounting.obNoRows')}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={t(`accounting.obSection_${section}`)}>
        <thead>
          <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
            {section === 'accounts' && <>
              <th className={`${th} text-start`}>{t('accounting.obField_account_code')}</th>
              <th className={`${th} text-end`}>{t('accounting.obField_debit')}</th>
              <th className={`${th} text-end`}>{t('accounting.obField_credit')}</th>
            </>}
            {(section === 'receivables' || section === 'payables') && <>
              <th className={`${th} text-start`}>{t(`accounting.obParty_${section}`)}</th>
              <th className={`${th} text-start`}>{t('accounting.obField_doc_no')}</th>
              <th className={`${th} text-start`}>{t('accounting.obField_doc_date')}</th>
              <th className={`${th} text-start`}>{t('accounting.obField_due_date')}</th>
              <th className={`${th} text-end`}>{t('accounting.obField_amount')}</th>
            </>}
            {section === 'stock' && <>
              <th className={`${th} text-start`}>{t('accounting.obField_sku')}</th>
              <th className={`${th} text-start`}>{t('accounting.obField_warehouse')}</th>
              <th className={`${th} text-end`}>{t('accounting.obField_qty')}</th>
              <th className={`${th} text-end`}>{t('accounting.obField_unit_cost')}</th>
              <th className={`${th} text-end`}>{t('accounting.obSerialCount')}</th>
            </>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
              {section === 'accounts' && <>
                <td className={td}><span className="font-mono">{r.account?.code}</span> {r.account ? accountName(r.account, i18n.language) : ''}</td>
                <td className={`${td} text-end tabular-nums`}>{Number(r.debit) ? fmtMoney(r.debit) : ''}</td>
                <td className={`${td} text-end tabular-nums`}>{Number(r.credit) ? fmtMoney(r.credit) : ''}</td>
              </>}
              {(section === 'receivables' || section === 'payables') && <>
                <td className={td}>{r.customer ? (r.customer.company_name || r.customer.customer_code) : r.vendor?.brand_name}</td>
                <td className={`${td} font-mono`}>{r.doc_no}</td>
                <td className={`${td} tabular-nums`}>{r.doc_date}</td>
                <td className={`${td} tabular-nums`}>{r.due_date || '—'}</td>
                <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.amount)} {r.currency}</td>
              </>}
              {section === 'stock' && <>
                <td className={td}><span className="font-mono">{r.product?.sku}</span> {r.product?.product_name}</td>
                <td className={td}>{r.warehouse?.name}</td>
                <td className={`${td} text-end tabular-nums`}>{r.qty}</td>
                <td className={`${td} text-end tabular-nums`}>{r.unit_cost == null ? t('accounting.obUnknownCost') : fmtMoney(r.unit_cost)}</td>
                <td className={`${td} text-end tabular-nums`}>{(r.serials || []).length || '—'}</td>
              </>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── the summary: each control account against its detail ────────────────────
function Summary({ s }) {
  const { t } = useTranslation()
  const cur = s.currency
  const cmp = (key, detail, tb, diff) => (
    <div key={key} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm">
      <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t(`accounting.obCheck_${key}`)}</span>
      <span className={`tabular-nums ${Math.round(Number(diff) * 100) === 0 ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>
        {Math.round(Number(diff) * 100) === 0 ? t('accounting.obAgrees') : t('accounting.obDiffers', { amount: fmtMoney(diff), currency: cur })}
      </span>
      <span className={`text-xs ${muted}`}>{t('accounting.obDetailVsTb', { detail: fmtMoney(detail), tb: fmtMoney(tb), currency: cur })}</span>
    </div>
  )
  return (
    <div className={`${card} p-4 space-y-3`} aria-label={t('accounting.obSummary')}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="text-sm space-y-0.5">
          <div className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.obSection_accounts')}</div>
          <div className={`text-xs ${muted}`}>{t('accounting.obTbTotals', { debit: fmtMoney(s.accounts.debit), credit: fmtMoney(s.accounts.credit), currency: cur })}</div>
          {s.tb_balanced
            ? <div className="text-xs text-green-700 dark:text-green-400">{t('accounting.obTbBalanced')}</div>
            : <div role="alert" className="text-xs text-amber-700 dark:text-amber-400">{t('accounting.obTbUnbalanced')}</div>}
        </div>
        {cmp('receivables', s.receivables.total_base, s.receivables.trial_balance, s.receivables.difference)}
        {cmp('payables', s.payables.total_base, s.payables.trial_balance, s.payables.difference)}
        {cmp('stock', s.stock.known_cost, s.stock.trial_balance, s.stock.difference)}
      </div>
      {Number(s.stock.uncosted_units) > 0 && <p className={`text-xs ${muted}`}>{t('accounting.obUncosted', { count: s.stock.uncosted_units })}</p>}
      <div className="border-t border-[#f0f2f6] dark:border-[#1a2230] pt-3 flex flex-wrap items-baseline gap-x-3">
        <span className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.obEquity')}</span>
        {equityBalances(s)
          ? <span className="text-sm font-bold text-green-700 dark:text-green-400">{t('accounting.obEquityZero')}</span>
          : <span className="text-sm font-bold text-amber-700 dark:text-amber-400 tabular-nums">{fmtMoney(s.equity_difference)} {cur}</span>}
        <span className={`text-xs ${muted} w-full`}>{t('accounting.obEquityHint')}</span>
      </div>
    </div>
  )
}

// ── the tab ──────────────────────────────────────────────────────────────────
export default function OpeningBalancesTab({ currentUserRole }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const canEdit = isFinanceRole(currentUserRole)
  const [openDate, setOpenDate] = useState(lastDayOfPreviousMonth())
  const [notes, setNotes] = useState('')
  const [importing, setImporting] = useState(null)
  const [shown, setShown] = useState(null)
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const current = useQuery({ queryKey: ['opening-balances', 'current'], queryFn: () => db.openingBalances.current() })
  const b = current.data
  const summary = useQuery({ queryKey: ['opening-balances', 'summary', b?.id], queryFn: () => db.openingBalances.summary(b.id), enabled: !!b })
  const history = useQuery({ queryKey: ['opening-balances', 'reversed'], queryFn: () => db.openingBalances.reversed() })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['opening-balances'] })
    queryClient.invalidateQueries({ queryKey: ['ledger'] })
  }
  const run = async (fn, okKey) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      toast.success(t(okKey))
      refresh()
      return true
    } catch (ex) {
      toast.error(ex?.message || t('common.error'), { duration: 8000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (current.isLoading) return <div className="py-10 flex justify-center"><Spinner /></div>
  if (current.error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{current.error.message}</p>

  const s = summary.data
  const counts = s ? { accounts: s.accounts.rows, receivables: s.receivables.rows, payables: s.payables.rows, stock: s.stock.rows } : {}

  return (
    <div className="space-y-4">
      <p className={`text-sm ${muted} max-w-[75ch]`}>{t('accounting.obHint')}</p>

      {!b && (
        <div className={`${card} p-4 space-y-3`}>
          <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.obNone')}</p>
          {canEdit ? (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="ob-date" required>{t('accounting.obOpeningDate')}</Label>
                <Input id="ob-date" type="date" value={openDate} onChange={(e) => setOpenDate(e.target.value)} />
              </div>
              <div className="flex-1 min-w-[12rem]">
                <Label htmlFor="ob-notes">{t('accounting.obNotes')}</Label>
                <Input id="ob-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
              <Button disabled={busy || !openDate}
                onClick={() => run(() => db.openingBalances.create(openDate, notes.trim() || null), 'accounting.obStartedToast')}>
                {t('accounting.obStart')}
              </Button>
              <p className={`text-xs ${muted} w-full`}>{t('accounting.obDateHint')}</p>
            </div>
          ) : <p className={`text-xs ${muted}`}>{t('accounting.obFinanceOnly')}</p>}
        </div>
      )}

      {b && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.obAsAt', { date: b.opening_date })}</h3>
            <span className={b.status === 'posted' ? 'text-sm text-green-700 dark:text-green-400' : 'text-sm text-amber-700 dark:text-amber-400'}>
              {t(`accounting.obStatus_${b.status}`)}
            </span>
            {b.notes && <span className={`text-sm ${muted}`}>{b.notes}</span>}
            <span className="flex-1" />
            {canEdit && b.status === 'draft' && (
              <>
                <Button variant="ghost" size="sm" disabled={busy}
                  onClick={() => confirm({
                    title: t('accounting.obDeleteTitle'), message: t('accounting.obDeleteConfirm'), confirmLabel: t('accounting.bankDelete'),
                    onConfirm: () => run(() => db.openingBalances.remove(b.id), 'accounting.obDeletedToast'),
                  })}>
                  {t('accounting.bankDelete')}
                </Button>
                <Button size="sm" disabled={busy || !s}
                  onClick={() => confirm({
                    title: t('accounting.obPostTitle'),
                    message: [t('accounting.obPostConfirm', { date: b.opening_date }),
                      s && !equityBalances(s) ? t('accounting.obPostWarnEquity') : null,
                      s && !s.tb_balanced ? t('accounting.obTbUnbalanced') : null].filter(Boolean).join(' '),
                    confirmLabel: t('accounting.obPost'), tone: 'primary',
                    onConfirm: () => run(() => db.openingBalances.post(b.id), 'accounting.obPostedToast'),
                  })}>
                  {t('accounting.obPost')}
                </Button>
              </>
            )}
            {canEdit && b.status === 'posted' && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setReason(''); setReversing(true) }}>
                {t('accounting.obReverse')}
              </Button>
            )}
          </div>
          {b.status === 'posted' && <p className={`text-xs ${muted}`}>{t('accounting.obPostedNote')}</p>}

          {summary.isLoading && <div className="py-4 flex justify-center"><Spinner /></div>}
          {summary.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{summary.error.message}</p>}
          {s && <Summary s={s} />}

          <div className="space-y-3">
            {OPENING_SECTIONS.map((sec) => (
              <div key={sec} className={card}>
                <div className="flex flex-wrap items-center gap-3 p-3">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t(`accounting.obSection_${sec}`)}</div>
                    <div className={`text-xs ${muted}`}>{t('accounting.obRowCount', { count: Number(counts[sec] || 0) })}</div>
                  </div>
                  <Button size="sm" variant="ghost" aria-expanded={shown === sec} onClick={() => setShown((x) => (x === sec ? null : sec))}>
                    {t(shown === sec ? 'accounting.obHideRows' : 'accounting.obShowRows')}
                  </Button>
                  {canEdit && b.status === 'draft' && (
                    <Button size="sm" variant="secondary" onClick={() => setImporting(sec)}>{t('accounting.obImport')}</Button>
                  )}
                </div>
                {shown === sec && <div className="border-t border-[#f0f2f6] dark:border-[#1a2230]"><SectionRows batchId={b.id} section={sec} /></div>}
              </div>
            ))}
          </div>
        </>
      )}

      {(history.data ?? EMPTY_ARRAY).length > 0 && (
        <div className={`${card} p-3`}>
          <div className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-2">{t('accounting.obReversedList')}</div>
          <ul className="text-sm space-y-1">
            {history.data.map((h) => (
              <li key={h.id} className={muted}>{t('accounting.obReversedItem', { date: h.opening_date, by: h.reversed_by, reason: h.reverse_reason })}</li>
            ))}
          </ul>
        </div>
      )}

      {importing && b && (
        <ImportSectionModal batchId={b.id} section={importing} onClose={() => setImporting(null)}
          onStored={() => { setImporting(null); setShown(importing); refresh() }} />
      )}

      {reversing && b && (
        <ModalOverlay onClose={() => setReversing(false)}>
          <ModalCard aria-label={t('accounting.obReverseTitle')} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full">
            <div className="p-5 space-y-3">
              <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.obReverseTitle')}</h2>
              <p className={`text-sm ${muted}`}>{t('accounting.obReverseHint')}</p>
              <div>
                <Label htmlFor="ob-reason" required>{t('accounting.obReason')}</Label>
                <Textarea id="ob-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setReversing(false)}>{t('common.cancel')}</Button>
                <Button variant="danger" loading={busy} disabled={reason.trim().length < 10}
                  onClick={async () => { if (await run(() => db.openingBalances.reverse(b.id, reason.trim()), 'accounting.obReversedToast')) setReversing(false) }}>
                  {t('accounting.obReverse')}
                </Button>
              </div>
            </div>
          </ModalCard>
        </ModalOverlay>
      )}
      {confirmDialog}
    </div>
  )
}
