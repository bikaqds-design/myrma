import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { ModalOverlay, ModalCard, Button, Input, Label, Select } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { isFinanceRole } from './_periods'
import { TAX_KINDS, fmtRate, lastMonth, taxCodeName, validateTaxCode, vatSummary } from './_tax'

// Accounting › Tax (A-04b over 20260911): the VAT return for a period — output
// and input tax by code and rate, from what the ledger posted, tied to the
// ledger's VAT accounts — and the tax codes, which administrators and
// accountants maintain. A code's rate may change; posted documents keep the
// rate they were posted at, and the database refuses what would break that.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const th = 'px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]'
const td = 'px-4 py-2.5 text-[#211f1b] dark:text-[#e8ebf0]'
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-x-auto'

export default function TaxTab({ currentUserRole }) {
  const canEdit = isFinanceRole(currentUserRole)
  return (
    <div className="space-y-6">
      <VatReturn />
      <TaxCodes canEdit={canEdit} />
    </div>
  )
}

function VatReturn() {
  const { t, i18n } = useTranslation()
  const initial = lastMonth()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const valid = Boolean(from && to && to >= from)

  const { data: rows = EMPTY_ARRAY, isLoading, error } = useQuery({
    queryKey: ['tax', 'vat-return', from, to],
    queryFn: () => db.taxCodes.vatReturn(from, to),
    enabled: valid,
    staleTime: 30_000,
  })
  const { data: ledger } = useQuery({
    queryKey: ['tax', 'vat-ledger', from, to],
    queryFn: () => db.taxCodes.vatLedger(from, to),
    enabled: valid,
    staleTime: 30_000,
  })
  const sum = vatSummary(rows, ledger)

  const section = (side, titleKey, total) => {
    const list = rows.filter((r) => r.side === side)
    return (
      <>
        <tr className="bg-[#f8f9fb] dark:bg-[#0f1520]">
          <td colSpan={5} className="px-4 py-2 text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{t(titleKey)}</td>
        </tr>
        {list.length === 0 ? (
          <tr><td colSpan={5} className="px-4 py-2.5 text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.taxNoRows')}</td></tr>
        ) : list.map((r) => (
          <tr key={`${side}-${r.tax_code}-${r.rate}`} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
            <td className={td}>
              <span className="font-mono text-xs">{r.tax_code || '—'}</span>{' '}
              {r.tax_code ? taxCodeName(r, i18n.language) : t('accounting.taxNoCode')}
            </td>
            <td className={`${td} text-end`}>{fmtRate(r.rate)}%</td>
            <td className={`${td} text-end`}>{fmtMoney(r.net_amount)}</td>
            <td className={`${td} text-end`}>{fmtMoney(r.tax_amount)}</td>
            <td className={`${td} text-end text-[#6c6760] dark:text-[#9aa4b2]`}>{r.documents}</td>
          </tr>
        ))}
        <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
          <td className={`${td} font-semibold`} colSpan={2}>{t('accounting.taxTotal')}</td>
          <td className={`${td} text-end font-semibold`}>{fmtMoney(total.net)}</td>
          <td className={`${td} text-end font-semibold`}>{fmtMoney(total.tax)}</td>
          <td />
        </tr>
      </>
    )
  }

  return (
    <section className="space-y-3" aria-labelledby="vat-return-title">
      <div>
        <h2 id="vat-return-title" className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.taxReturnTitle')}</h2>
        <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.taxReturnHint')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="vat-from">{t('accounting.glFrom')}</Label>
          <Input id="vat-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="vat-to">{t('accounting.glTo')}</Label>
          <Input id="vat-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {!valid ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('accounting.taxErrPeriod')}</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error.message}</p>
      ) : (
        <div className={card}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
                <th className={`${th} text-start`}>{t('accounting.taxCode')}</th>
                <th className={`${th} text-end`}>{t('accounting.taxColRate')}</th>
                <th className={`${th} text-end`}>{t('accounting.taxColNet')}</th>
                <th className={`${th} text-end`}>{t('accounting.taxColTax')}</th>
                <th className={`${th} text-end`}>{t('accounting.taxColDocs')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.loading')}</td></tr>
              ) : (
                <>
                  {section('output', 'accounting.taxOutput', sum.output)}
                  {section('input', 'accounting.taxInput', sum.input)}
                </>
              )}
            </tbody>
            {!isLoading && (
              <tfoot>
                <tr className="bg-[#f8f9fb] dark:bg-[#0f1520]">
                  <td className={`${td} font-bold`} colSpan={3}>
                    {t(sum.payable >= 0 ? 'accounting.taxPayable' : 'accounting.taxRefundable')}
                  </td>
                  <td className={`${td} text-end font-bold`}>{fmtMoney(Math.abs(sum.payable))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {valid && !error && sum.tie && (
        sum.tie.output && sum.tie.input ? (
          <p className="text-xs text-green-700 dark:text-green-400">{t('accounting.taxLedgerTies')}</p>
        ) : (
          <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
            {t('accounting.taxLedgerDiff', { output: fmtMoney(sum.tie.outputDiff), input: fmtMoney(sum.tie.inputDiff) })}
          </p>
        )
      )}
    </section>
  )
}

function TaxCodes({ canEdit }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const [editing, setEditing] = useState(null) // null | 'new' | code row
  const [busy, setBusy] = useState(false)

  const { data: codes = EMPTY_ARRAY, error } = useQuery({
    queryKey: ['tax-codes'],
    queryFn: () => db.taxCodes.list(),
    staleTime: 5 * 60_000,
  })

  // a ref as well as the state: a second click can land before the re-render
  const inFlight = useRef(false)
  const run = async (fn, okKey) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      toast.success(t(okKey))
      queryClient.invalidateQueries({ queryKey: ['tax-codes'] })
      return true
    } catch (err) {
      toast.error(err?.message || t('common.error'), { duration: 7000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const save = async (fields) => {
    if (editing === 'new') {
      if (await run(() => db.taxCodes.create(fields), 'accounting.taxCreatedToast')) setEditing(null)
      return
    }
    const { code, kind: _kind, ...changes } = fields
    const apply = async () => {
      if (await run(() => db.taxCodes.update(code, changes), 'accounting.taxSavedToast')) setEditing(null)
    }
    if (Number(changes.rate) !== Number(editing.rate)) {
      confirm({
        title: t('accounting.taxRateChangeTitle', { code }),
        message: t('accounting.taxRateChangeConfirm', { from: fmtRate(editing.rate), to: fmtRate(changes.rate) }),
        confirmLabel: t('accounting.taxSave'),
        tone: 'primary',
        onConfirm: apply,
      })
    } else {
      await apply()
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="tax-codes-title">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 id="tax-codes-title" className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('accounting.taxCodesTitle')}</h2>
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.taxCodesHint')}</p>
        </div>
        {canEdit && <Button size="sm" onClick={() => setEditing('new')}>+ {t('accounting.taxAdd')}</Button>}
      </div>
      <div className={card}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className={`${th} text-start`}>{t('accounting.taxCode')}</th>
              <th className={`${th} text-start`}>{t('accounting.taxColKind')}</th>
              <th className={`${th} text-end`}>{t('accounting.taxColRate')}</th>
              <th className={`${th} text-start`}>{t('accounting.taxColStatus')}</th>
              {canEdit && <th className={`${th} text-end`}><span className="sr-only">{t('accounting.taxEdit')}</span></th>}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={5} role="alert" className="py-8 text-center text-sm text-red-600 dark:text-red-400">{error.message}</td></tr>
            ) : codes.map((c) => (
              <tr key={c.code} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className={td}><span className="font-mono text-xs">{c.code}</span> {taxCodeName(c, i18n.language)}</td>
                <td className={`${td} text-[#6c6760] dark:text-[#9aa4b2]`}>{t(`accounting.taxKind_${c.kind}`)}</td>
                <td className={`${td} text-end`}>{fmtRate(c.rate)}%</td>
                <td className={td}>
                  <span className={`text-xs ${c.is_active ? 'text-green-700 dark:text-green-400' : 'text-[#a09d99] dark:text-[#4a5568]'}`}>
                    {t(c.is_active ? 'accounting.taxActive' : 'accounting.taxInactive')}
                  </span>
                  {c.is_default && (
                    <span className="ms-2 inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-indigo-50 dark:bg-indigo-900/20 text-[#4338ca] dark:text-[#a5b4fc]">
                      {t('accounting.taxDefault', { rate: fmtRate(c.rate) })}
                    </span>
                  )}
                </td>
                {canEdit && (
                  <td className={`${td} text-end`}>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>{t('accounting.taxEdit')}</Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <CodeModal initial={editing === 'new' ? null : editing} busy={busy} onClose={() => setEditing(null)} onSubmit={save} />
      )}
      {confirmDialog}
    </section>
  )
}

function CodeModal({ initial, busy, onClose, onSubmit }) {
  const { t } = useTranslation()
  const isNew = !initial
  const [code, setCode] = useState(initial?.code || '')
  const [name, setName] = useState(initial?.name || '')
  const [nameAr, setNameAr] = useState(initial?.name_ar || '')
  const [kind, setKind] = useState(initial?.kind || 'standard')
  const [rate, setRate] = useState(initial ? String(initial.rate) : '')
  const [isDefault, setIsDefault] = useState(Boolean(initial?.is_default))
  const [isActive, setIsActive] = useState(initial ? Boolean(initial.is_active) : true)
  const [err, setErr] = useState(null)

  const submit = () => {
    const bad = validateTaxCode({ code, name, kind, rate })
    if (bad) { setErr(bad); return }
    onSubmit({
      code: code.trim().toUpperCase(),
      name: name.trim(),
      name_ar: nameAr.trim() || null,
      kind,
      rate: Number(rate),
      // a default code must be active (the database checks it too)
      is_default: isDefault && isActive,
      is_active: isActive,
    })
  }
  const title = isNew ? t('accounting.taxAdd') : t('accounting.taxEditTitle', { code: initial.code })
  const invalid = (f) => (err?.field === f ? { 'aria-invalid': true, 'aria-describedby': 'tax-code-err' } : {})

  return (
    <ModalOverlay onClose={onClose}>
      <ModalCard aria-label={title} className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-md w-full">
        <div className="px-5 py-4 space-y-3">
          <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">{title}</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="tc-code" required>{t('accounting.taxCode')}</Label>
              <Input id="tc-code" value={code} disabled={!isNew} onChange={(e) => { setCode(e.target.value.toUpperCase()); setErr(null) }} {...invalid('code')} />
            </div>
            <div>
              <Label htmlFor="tc-kind" required>{t('accounting.taxColKind')}</Label>
              <Select id="tc-kind" value={kind} disabled={!isNew} onChange={(e) => { setKind(e.target.value); setErr(null) }} {...invalid('kind')}>
                {TAX_KINDS.map((k) => <option key={k} value={k}>{t(`accounting.taxKind_${k}`)}</option>)}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="tc-name" required>{t('accounting.taxColName')}</Label>
            <Input id="tc-name" value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} {...invalid('name')} />
          </div>
          <div>
            <Label htmlFor="tc-name-ar">{t('accounting.taxColNameAr')}</Label>
            <Input id="tc-name-ar" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tc-rate" required>{t('accounting.taxColRate')}</Label>
            <Input id="tc-rate" type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => { setRate(e.target.value); setErr(null) }} {...invalid('rate')} />
          </div>
          <label className="flex items-center gap-2 text-sm text-[#211f1b] dark:text-[#e8ebf0]">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            {t('accounting.taxMakeDefault')}
          </label>
          <label className="flex items-center gap-2 text-sm text-[#211f1b] dark:text-[#e8ebf0]">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            {t('accounting.taxActive')}
          </label>
          {err && <p id="tax-code-err" role="alert" className="text-xs text-red-600 dark:text-red-400">{t(err.key)}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" loading={busy} onClick={submit}>{t('accounting.taxSave')}</Button>
          </div>
        </div>
      </ModalCard>
    </ModalOverlay>
  )
}
