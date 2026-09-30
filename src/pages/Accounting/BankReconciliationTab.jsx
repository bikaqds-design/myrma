import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Input, Label, Select, Spinner, ModalOverlay, ModalCard } from '../../components/ui'
import Pagination from '../../components/Pagination'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { accountName } from './_ledger'
import { isFinanceRole } from './_periods'
import { guessMapping, lastDate, linesTotal, mapStatementRows, parseCsv } from './_bank'

// Accounting › Bank (A-07 over 20260920; owner decisions 2026-09-30): import
// a bank statement from its CSV, match each line to the entry it clears
// (auto-match takes the unambiguous ones), book lines with no entry yet (bank
// charges, interest) to a chosen account, and complete the statement when
// every line is matched and it adds up. Accountants and administrators change
// it; managers read it.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'
const th = 'px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-3 py-2 text-[#211f1b] dark:text-[#e8ebf0]'
const FIELDS = ['date', 'description', 'reference', 'amount', 'debit', 'credit']

// ── import ───────────────────────────────────────────────────────────────────
function ImportStatementModal({ account, previousClosing, onClose, onCreated }) {
  const { t, i18n } = useTranslation()
  const [csv, setCsv] = useState(null)             // { headers, rows }
  const [mapping, setMapping] = useState(null)
  const [format, setFormat] = useState('ymd')
  const [opening, setOpening] = useState(previousClosing != null ? String(previousClosing) : '')
  const [closing, setClosing] = useState('')
  const [date, setDate] = useState('')
  const [reference, setReference] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const onFile = async (file) => {
    setErr(null)
    if (!file) return
    const parsed = parseCsv(await file.text())
    if (parsed.headers.length === 0) { setErr(t('accounting.bankErrEmpty')); return }
    setCsv(parsed)
    setMapping(guessMapping(parsed.headers))
    setReference(file.name.replace(/\.[^.]+$/, ''))
  }

  const mapped = csv && mapping ? mapStatementRows(csv.rows, mapping, format) : { lines: [], errors: [] }
  const total = linesTotal(mapped.lines)
  const suggestedClosing = opening !== '' && Number.isFinite(Number(opening)) ? (Math.round(Number(opening) * 100) + Math.round(total * 100)) / 100 : null
  const effectiveDate = date || lastDate(mapped.lines)

  const save = async () => {
    if (mapped.lines.length === 0) { setErr(t('accounting.bankErrNoLines')); return }
    if (mapped.errors.length > 0) { setErr(t('accounting.bankErrRows', { rows: mapped.errors.slice(0, 5).map((e) => e.row).join(', ') })); return }
    const o = Number(opening)
    const c = closing === '' ? suggestedClosing : Number(closing)
    if (opening === '' || !Number.isFinite(o) || c == null || !Number.isFinite(c)) { setErr(t('accounting.bankErrBalances')); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) { setErr(t('accounting.bankErrStatementDate')); return }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const id = await db.bankRec.create({
        accountId: account.id, statementDate: effectiveDate, reference: reference.trim() || null,
        openingBalance: o, closingBalance: c, lines: mapped.lines,
      })
      toast.success(t('accounting.bankImportedToast', { count: mapped.lines.length }))
      onCreated(id)
    } catch (ex) {
      setErr(ex?.message || t('common.error'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const col = (k) => (
    <div key={k}>
      <Label htmlFor={`bank-map-${k}`}>{t(`accounting.bankCol_${k}`)}</Label>
      <Select id={`bank-map-${k}`} value={mapping[k] ?? ''}
        onChange={(e) => setMapping({ ...mapping, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
        <option value="">{t('accounting.bankColNone')}</option>
        {csv.headers.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}
      </Select>
    </div>
  )

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={t('accounting.bankImportTitle')} dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-3xl w-full">
        <div className="p-5 space-y-4 max-h-[85vh] overflow-y-auto">
          <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">
            {t('accounting.bankImportTitle')} · <span className="font-mono text-sm">{account.code}</span> {accountName(account, i18n.language)}
          </h2>
          <div>
            <Label htmlFor="bank-file">{t('accounting.bankFile')}</Label>
            <Input id="bank-file" type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-1">{t('accounting.bankFileHint')}</p>
          </div>

          {csv && mapping && (
            <>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
                {FIELDS.map(col)}
                <div>
                  <Label htmlFor="bank-format">{t('accounting.bankDateFormat')}</Label>
                  <Select id="bank-format" value={format} onChange={(e) => setFormat(e.target.value)}>
                    <option value="ymd">YYYY-MM-DD</option>
                    <option value="dmy">DD/MM/YYYY</option>
                    <option value="mdy">MM/DD/YYYY</option>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankMapHint')}</p>

              <div className={`${card} overflow-x-auto`}>
                <table className="w-full text-sm" aria-label={t('accounting.bankPreview')}>
                  <thead>
                    <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
                      <th className={`${th} text-start`}>{t('accounting.repColDate')}</th>
                      <th className={`${th} text-start`}>{t('accounting.bankCol_description')}</th>
                      <th className={`${th} text-end`}>{t('accounting.bankCol_amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mapped.lines.slice(0, 8).map((l, i) => (
                      <tr key={i} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                        <td className={`${td} tabular-nums`}>{l.txn_date}</td>
                        <td className={td}>{l.description || '—'}</td>
                        <td className={`${td} text-end tabular-nums`}>{fmtMoney(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0]">
                {t('accounting.bankPreviewCount', { count: mapped.lines.length, total: fmtMoney(total) })}
                {mapped.errors.length > 0 && (
                  <span className="text-red-600 dark:text-red-400"> {t('accounting.bankErrRows', { rows: mapped.errors.slice(0, 5).map((e) => e.row).join(', ') })}</span>
                )}
              </p>

              <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
                <div>
                  <Label htmlFor="bank-opening" required>{t('accounting.bankOpening')}</Label>
                  <Input id="bank-opening" inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="bank-closing" required>{t('accounting.bankClosing')}</Label>
                  <Input id="bank-closing" inputMode="decimal" value={closing}
                    placeholder={suggestedClosing != null ? suggestedClosing.toFixed(2) : ''} onChange={(e) => setClosing(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="bank-date" required>{t('accounting.bankStatementDate')}</Label>
                  <Input id="bank-date" type="date" value={effectiveDate} onChange={(e) => setDate(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="bank-ref">{t('accounting.bankReference')}</Label>
                  <Input id="bank-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
                </div>
              </div>
            </>
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

// ── one statement ────────────────────────────────────────────────────────────
function StatementView({ statementId, canEdit, isLatest, onChanged }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const [booking, setBooking] = useState(null)       // { line, accountId, memo }
  const [picks, setPicks] = useState({})             // line id → journal line id
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const st = useQuery({ queryKey: ['bank-rec', 'statement', statementId], queryFn: () => db.bankRec.statement(statementId) })
  const lines = useQuery({ queryKey: ['bank-rec', 'lines', statementId], queryFn: () => db.bankRec.lines(statementId) })
  const cands = useQuery({ queryKey: ['bank-rec', 'candidates', statementId], queryFn: () => db.bankRec.candidates(statementId) })
  const sum = useQuery({ queryKey: ['bank-rec', 'summary', statementId], queryFn: () => db.bankRec.summary(statementId) })
  const accounts = useQuery({ queryKey: ['ledger', 'accounts'], queryFn: () => db.ledger.accounts(), enabled: !!booking })
  const open = st.data?.status === 'open'
  const editable = canEdit && open
  const byLine = (cands.data ?? EMPTY_ARRAY).reduce((m, c) => { (m[c.statement_line_id] ||= []).push(c); return m }, {})

  const run = async (fn, okKey, vars) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      const r = await fn()
      toast.success(t(okKey, typeof vars === 'function' ? vars(r) : vars))
      queryClient.invalidateQueries({ queryKey: ['bank-rec'] })
      queryClient.invalidateQueries({ queryKey: ['ledger'] })
      queryClient.invalidateQueries({ queryKey: ['accounting-periods'] })
      onChanged?.()
      return true
    } catch (ex) {
      toast.error(ex?.message || t('common.error'), { duration: 7000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (st.isLoading || lines.isLoading) return <div className="py-10 flex justify-center"><Spinner /></div>
  if (st.error || lines.error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{(st.error || lines.error).message}</p>
  const s = sum.data

  return (
    <div className="space-y-3">
      {s && (
        <div className={`${card} p-4 grid gap-3 grid-cols-2 sm:grid-cols-4 text-sm`} aria-label={t('accounting.bankSummary')}>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankOpening')}</div><div className="tabular-nums font-semibold">{fmtMoney(s.opening_balance)}</div></div>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankLinesTotal')}</div><div className="tabular-nums font-semibold">{fmtMoney(s.lines_total)}</div></div>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankClosing')}</div><div className="tabular-nums font-semibold">{fmtMoney(s.closing_balance)}</div></div>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankUnmatched')}</div><div className="tabular-nums font-semibold">{s.unmatched_count} / {s.lines_count}</div></div>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankLedger')}</div><div className="tabular-nums">{fmtMoney(s.ledger_balance)}</div></div>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankUncleared', { count: s.uncleared_count })}</div><div className="tabular-nums">{fmtMoney(s.uncleared_total)}</div></div>
          <div><div className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankDifference')}</div>
            <div className={`tabular-nums font-bold ${Number(s.difference) === 0 ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}>{fmtMoney(s.difference)}</div></div>
          <div className="text-xs self-center">
            {s.statement_balances
              ? <span className="text-green-700 dark:text-green-400">{t('accounting.bankAddsUp')}</span>
              : <span role="alert" className="text-red-600 dark:text-red-400">{t('accounting.bankNotAddsUp')}</span>}
          </div>
          <p className="col-span-2 sm:col-span-4 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankDifferenceHint')}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {editable && (
          <>
            <Button size="sm" variant="secondary" disabled={busy}
              onClick={() => run(() => db.bankRec.autoMatch(statementId), 'accounting.bankAutoMatchedToast', (n) => ({ count: n }))}>
              {t('accounting.bankAutoMatch')}
            </Button>
            <Button size="sm" disabled={busy || !s || s.unmatched_count > 0 || !s.statement_balances}
              onClick={() => confirm({
                title: t('accounting.bankCompleteTitle'), message: t('accounting.bankCompleteConfirm'), confirmLabel: t('accounting.bankComplete'), tone: 'primary',
                onConfirm: () => run(() => db.bankRec.complete(statementId), 'accounting.bankCompletedToast'),
              })}>
              {t('accounting.bankComplete')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => confirm({
                title: t('accounting.bankDeleteTitle'), message: t('accounting.bankDeleteConfirm'), confirmLabel: t('accounting.bankDelete'),
                onConfirm: () => run(() => db.bankRec.remove(statementId), 'accounting.bankDeletedToast'),
              })}>
              {t('accounting.bankDelete')}
            </Button>
          </>
        )}
        {canEdit && !open && isLatest && (
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => run(() => db.bankRec.reopen(statementId), 'accounting.bankReopenedToast')}>
            {t('accounting.bankReopen')}
          </Button>
        )}
      </div>

      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm" aria-label={t('accounting.bankLines')}>
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.repColDate')}</th>
              <th className={`${th} text-start`}>{t('accounting.bankCol_description')}</th>
              <th className={`${th} text-end`}>{t('accounting.bankCol_amount')}</th>
              <th className={`${th} text-start`}>{t('accounting.bankMatch')}</th>
            </tr>
          </thead>
          <tbody>
            {(lines.data ?? EMPTY_ARRAY).map((l) => {
              const options = byLine[l.id] ?? EMPTY_ARRAY
              const pick = picks[l.id] ?? options[0]?.journal_line_id ?? ''
              return (
                <tr key={l.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] align-top">
                  <td className={`${td} tabular-nums whitespace-nowrap`}>{l.txn_date}</td>
                  <td className={td}>
                    {l.description || '—'}
                    {l.reference && <div className="text-xs text-[#6c6760] dark:text-[#9aa4b2] font-mono">{l.reference}</div>}
                  </td>
                  <td className={`${td} text-end tabular-nums ${Number(l.amount) < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{fmtMoney(l.amount)}</td>
                  <td className={td}>
                    {l.journal_line_id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-green-700 dark:text-green-400 text-xs">{t(l.booked_entry_id ? 'accounting.bankBooked' : 'accounting.bankMatched')}</span>
                        <span className="font-mono text-xs">{l.journal_line?.entry?.entry_no || ''}</span>
                        {editable && !l.booked_entry_id && (
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => db.bankRec.unmatch(l.id), 'accounting.bankUnmatchedToast')}>
                            {t('accounting.bankUnmatch')}
                          </Button>
                        )}
                      </span>
                    ) : editable ? (
                      <span className="flex flex-wrap items-center gap-2">
                        {options.length > 0 ? (
                          <>
                            <Select aria-label={t('accounting.bankCandidate')} value={pick} className="w-auto max-w-[16rem]"
                              onChange={(e) => setPicks({ ...picks, [l.id]: e.target.value })}>
                              {options.map((c) => (
                                <option key={c.journal_line_id} value={c.journal_line_id}>
                                  {`${c.entry_no} · ${c.entry_date} · ${c.source_code || c.memo || c.source_type}`}
                                </option>
                              ))}
                            </Select>
                            <Button size="sm" variant="secondary" disabled={busy || !pick}
                              onClick={() => run(() => db.bankRec.match(l.id, pick), 'accounting.bankMatchedToast')}>
                              {t('accounting.bankMatchIt')}
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankNoCandidate')}</span>
                        )}
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBooking({ line: l, accountId: '', memo: l.description || '' })}>
                          {t('accounting.bankBook')}
                        </Button>
                      </span>
                    ) : (
                      <span className="text-xs text-amber-700 dark:text-amber-400">{t('accounting.bankNotMatched')}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {booking && (
        <ModalOverlay onClose={() => setBooking(null)}>
          <ModalCard aria-label={t('accounting.bankBookTitle')} dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}
            className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full">
            <div className="p-5 space-y-3">
              <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.bankBookTitle')}</h2>
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                {t(Number(booking.line.amount) < 0 ? 'accounting.bankBookOut' : 'accounting.bankBookIn', { amount: fmtMoney(Math.abs(booking.line.amount)), date: booking.line.txn_date })}
              </p>
              <div>
                <Label htmlFor="bank-book-account" required>{t('accounting.bankBookAccount')}</Label>
                <Select id="bank-book-account" value={booking.accountId} onChange={(e) => setBooking({ ...booking, accountId: e.target.value })}>
                  <option value="">{t('accounting.bankColNone')}</option>
                  {(accounts.data ?? EMPTY_ARRAY).filter((a) => a.is_postable && a.is_active && !a.is_bank).map((a) => (
                    <option key={a.id} value={a.id}>{`${a.code} ${accountName(a, i18n.language)}`}</option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="bank-book-memo">{t('accounting.bankBookMemo')}</Label>
                <Input id="bank-book-memo" value={booking.memo} onChange={(e) => setBooking({ ...booking, memo: e.target.value })} />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setBooking(null)}>{t('common.cancel')}</Button>
                <Button loading={busy} disabled={!booking.accountId}
                  onClick={async () => { if (await run(() => db.bankRec.book(booking.line.id, booking.accountId, booking.memo.trim() || null), 'accounting.bankBookedToast')) setBooking(null) }}>
                  {t('accounting.bankBookIt')}
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

// ── the tab ──────────────────────────────────────────────────────────────────
export default function BankReconciliationTab({ currentUserRole }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const canEdit = isFinanceRole(currentUserRole)
  const [accountId, setAccountId] = useState('')
  const [openId, setOpenId] = useState(null)
  const [importing, setImporting] = useState(false)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(12)

  const accounts = useQuery({ queryKey: ['bank-rec', 'accounts'], queryFn: () => db.bankRec.accounts() })
  const list = accounts.data ?? EMPTY_ARRAY
  const account = list.find((a) => a.id === accountId) ?? list[0] ?? null
  useEffect(() => { setOpenId(null); setPage(1) }, [account?.id])

  const statements = useQuery({
    queryKey: ['bank-rec', 'statements', account?.id, page, perPage],
    queryFn: () => db.bankRec.statementsPage(account.id, page, perPage),
    enabled: !!account,
    placeholderData: keepPreviousData,
  })
  const latest = useQuery({ queryKey: ['bank-rec', 'latest', account?.id], queryFn: () => db.bankRec.latest(account.id), enabled: !!account })
  const rows = statements.data?.data ?? EMPTY_ARRAY
  const hasOpen = latest.data?.status === 'open'

  if (accounts.isLoading) return <div className="py-10 flex justify-center"><Spinner /></div>
  if (accounts.error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{accounts.error.message}</p>
  if (!account) return <p className={`${card} p-6 text-sm text-center text-[#6c6760] dark:text-[#9aa4b2]`}>{t('accounting.bankNoAccounts')}</p>

  return (
    <div className="space-y-4">
      <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-[75ch]">{t('accounting.bankHint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="bank-account">{t('accounting.bankAccount')}</Label>
          <Select id="bank-account" value={account.id} onChange={(e) => setAccountId(e.target.value)} className="w-auto">
            {list.map((a) => <option key={a.id} value={a.id}>{`${a.code} ${accountName(a, i18n.language)}`}</option>)}
          </Select>
        </div>
        {canEdit && (
          <Button onClick={() => setImporting(true)} disabled={hasOpen}>
            {t('accounting.bankNew')}
          </Button>
        )}
        {canEdit && hasOpen && <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] pb-2">{t('accounting.bankOneOpen')}</p>}
      </div>

      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm" aria-label={t('accounting.bankStatements')}>
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.bankStatementDate')}</th>
              <th className={`${th} text-start`}>{t('accounting.bankReference')}</th>
              <th className={`${th} text-end`}>{t('accounting.bankOpening')}</th>
              <th className={`${th} text-end`}>{t('accounting.bankClosing')}</th>
              <th className={`${th} text-start`}>{t('accounting.bankStatus')}</th>
              <th className={th}><span className="sr-only">{t('accounting.bankOpenIt')}</span></th>
            </tr>
          </thead>
          <tbody>
            {statements.error ? (
              <tr><td colSpan={6} role="alert" className="py-6 text-center text-sm text-red-600 dark:text-red-400">{statements.error.message}</td></tr>
            ) : rows.length === 0 && !statements.isLoading ? (
              <tr><td colSpan={6} className="py-6 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.bankNoStatements')}</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className={`border-b border-[#f0f2f6] dark:border-[#1a2230] ${openId === r.id ? 'bg-[#f8f9fb] dark:bg-[#0f1520]' : ''}`}>
                <td className={`${td} tabular-nums`}>{r.statement_date}</td>
                <td className={td}>{r.reference || '—'}</td>
                <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.opening_balance)}</td>
                <td className={`${td} text-end tabular-nums`}>{fmtMoney(r.closing_balance)}</td>
                <td className={td}>
                  <span className={r.status === 'completed' ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}>
                    {t(`accounting.bankStatus_${r.status}`)}
                  </span>
                </td>
                <td className={`${td} text-end`}>
                  <Button size="sm" variant="secondary" aria-expanded={openId === r.id} onClick={() => setOpenId((o) => (o === r.id ? null : r.id))}>
                    {t(openId === r.id ? 'accounting.bankCloseIt' : 'accounting.bankOpenIt')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(statements.data?.count ?? 0) > perPage && (
        <Pagination total={statements.data.count} page={page} itemsPerPage={perPage} setItemsPerPage={(n) => { setPerPage(n); setPage(1) }} onPage={setPage} />
      )}

      {openId && (
        <StatementView key={openId} statementId={openId} canEdit={canEdit} isLatest={latest.data?.id === openId}
          onChanged={() => {
            queryClient.invalidateQueries({ queryKey: ['bank-rec', 'statements'] })
            queryClient.invalidateQueries({ queryKey: ['bank-rec', 'latest'] })
          }} />
      )}

      {importing && (
        <ImportStatementModal account={account}
          previousClosing={latest.data?.status === 'completed' ? latest.data.closing_balance : null}
          onClose={() => setImporting(false)}
          onCreated={(id) => {
            setImporting(false)
            queryClient.invalidateQueries({ queryKey: ['bank-rec'] })
            setOpenId(id)
          }} />
      )}
    </div>
  )
}
