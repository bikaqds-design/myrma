import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Input, Label, Select } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import {
  CHART_COUNTRIES, POSTING_ROLES, accountName, chartRows, parseChartCsv, summarizeImport, validateAccount,
} from '../Accounting/_ledger'

// Control Panel › Chart of accounts (A-01c). Administrators add accounts,
// rename them, make them inactive, and choose which account each kind of
// posting uses. The database refuses anything that would change the meaning
// of an account with postings (code, type, becoming a header, deletion) and
// any rule pointing at a header or an inactive account; its message is shown
// as it is.
//
// A-02: before anything is posted, an administrator can replace the whole chart
// with a country's template (Egypt, UAE, Saudi Arabia — drafts pending an
// accountant's review), and at any time import accounts from a CSV file (new
// codes are created, existing ones renamed; one result per row).

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense']
const EMPTY_FORM = { code: '', name: '', name_ar: '', account_type: 'asset', parent_id: '', is_postable: true }

export default function ChartOfAccounts() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(null)
  const [editing, setEditing] = useState(null) // { id, name, name_ar }
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const { confirm, confirmDialog } = useConfirm()
  const [country, setCountry] = useState('')
  const [importFile, setImportFile] = useState(null) // { name, rows }
  const [importError, setImportError] = useState(null)
  const [importResult, setImportResult] = useState(null) // summarizeImport(...)

  const { data: accounts = EMPTY_ARRAY, isLoading } = useQuery({ queryKey: ['ledger', 'accounts'], queryFn: db.ledger.accounts })
  const { data: rules = EMPTY_ARRAY } = useQuery({ queryKey: ['ledger', 'posting-rules'], queryFn: db.ledger.postingRules })
  const { data: templates = EMPTY_ARRAY } = useQuery({ queryKey: ['ledger', 'chart-templates'], queryFn: db.ledger.chartTemplates })
  const { data: applied = null } = useQuery({ queryKey: ['ledger', 'chart-template-applied'], queryFn: db.ledger.appliedTemplate })
  const templateSize = useMemo(() => Object.fromEntries(templates.map((x) => [x.country, x.accounts])), [templates])

  const rows = useMemo(() => chartRows(accounts), [accounts])
  const headers = useMemo(() => accounts.filter((a) => !a.is_postable), [accounts])
  const postable = useMemo(() => accounts.filter((a) => a.is_postable && a.is_active), [accounts])
  const ruleFor = useMemo(() => Object.fromEntries(rules.map((r) => [r.role, r.account_id])), [rules])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ledger'] })

  // One write at a time: a second click can land before the button re-renders disabled.
  const run = async (fn, okKey) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await fn()
      if (okKey) toast.success(t(okKey))
      refresh()
      return true
    } catch (err) {
      toast.error(err?.message || t('common.error'), { duration: 7000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const addAccount = async (e) => {
    e.preventDefault()
    const bad = validateAccount(form)
    if (bad) return setFormError(t(bad))
    setFormError(null)
    const ok = await run(
      () =>
        db.ledger.createAccount({
          code: form.code,
          name: form.name.trim(),
          name_ar: form.name_ar.trim() || null,
          account_type: form.account_type,
          parent_id: form.parent_id || null,
          is_postable: form.is_postable,
        }),
      'accounting.glAccountAdded'
    )
    if (ok) setForm(EMPTY_FORM)
  }

  const applyTemplate = () => {
    if (!country) return
    confirm({
      title: t('accounting.glTemplateConfirmTitle'),
      message: t('accounting.glTemplateConfirm', { country: t(`accounting.glCountry_${country}`) }),
      confirmLabel: t('accounting.glTemplateApply'),
      onConfirm: () =>
        run(async () => {
          const r = await db.ledger.applyChartTemplate(country)
          toast.success(t('accounting.glTemplateApplied', r))
        }),
    })
  }

  const pickFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    setImportResult(null)
    setImportFile(null)
    setImportError(null)
    if (!file) return
    const parsed = parseChartCsv(await file.text())
    if (parsed.error) return setImportError(t(parsed.error))
    setImportFile({ name: file.name, rows: parsed.rows })
  }

  const runImport = async () => {
    if (!importFile) return
    let results = null
    const ok = await run(async () => {
      results = await db.ledger.importChartAccounts(importFile.rows)
    })
    if (ok) {
      setImportResult(summarizeImport(results))
      setImportFile(null)
    }
  }

  const saveEdit = async () => {
    const ok = await run(
      () => db.ledger.updateAccount(editing.id, { name: editing.name.trim(), name_ar: editing.name_ar.trim() || null }),
      'accounting.glAccountSaved'
    )
    if (ok) setEditing(null)
  }

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
        <h2 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-1">{t('accounting.glTemplateTitle')}</h2>
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mb-3">{t('accounting.glTemplateHint')}</p>
        {applied && (
          <p className="text-xs text-[#211f1b] dark:text-[#e8ebf0] mb-3">
            {t('accounting.glTemplateCurrent', { country: t(`accounting.glCountry_${applied}`) })}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="chart-country">{t('accounting.glTemplateCountry')}</Label>
            <Select id="chart-country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">{t('accounting.glTemplatePick')}</option>
              {CHART_COUNTRIES.filter((c) => templateSize[c]).map((c) => (
                <option key={c} value={c}>
                  {t(`accounting.glCountry_${c}`)} ({t('accounting.glTemplateAccounts', { count: templateSize[c] })})
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={applyTemplate} disabled={busy || !country}>{t('accounting.glTemplateApply')}</Button>
        </div>
      </section>

      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
        <h2 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-1">{t('accounting.glImportTitle')}</h2>
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mb-3">{t('accounting.glImportHint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="chart-file">{t('accounting.glImportFile')}</Label>
            <input id="chart-file" type="file" accept=".csv,text/csv" onChange={pickFile} className="block text-sm text-[#211f1b] dark:text-[#e8ebf0]" />
          </div>
          {importFile && (
            <Button onClick={runImport} disabled={busy}>
              {t('accounting.glImportRun', { count: importFile.rows.length })}
            </Button>
          )}
        </div>
        {importError && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{importError}</p>}
        {importResult && (
          <div className="mt-3 text-sm text-[#211f1b] dark:text-[#e8ebf0]" role="status">
            <p>{t('accounting.glImportDone', { created: importResult.created, updated: importResult.updated, errors: importResult.errors.length })}</p>
            {importResult.errors.length > 0 && (
              <ul className="mt-2 list-disc ps-5 text-red-600 dark:text-red-400">
                {importResult.errors.map((e, i) => (
                  <li key={`${e.code ?? ''}-${i}`}>
                    <span className="font-mono">{e.code ?? t('accounting.glImportNoCode')}</span>: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
        <h2 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-1">{t('accounting.glRulesTitle')}</h2>
        <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mb-3">{t('accounting.glRulesHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {POSTING_ROLES.map((role) => (
            <div key={role}>
              <Label htmlFor={`rule-${role}`}>{t(`accounting.glRole_${role}`)}</Label>
              <Select
                id={`rule-${role}`}
                value={ruleFor[role] ?? ''}
                disabled={busy}
                onChange={(e) => run(() => db.ledger.setPostingRule(role, e.target.value), 'accounting.glRuleSaved')}
              >
                {!ruleFor[role] && <option value="">{t('accounting.glNoAccount')}</option>}
                {postable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {accountName(a, i18n.language)}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
        <h2 className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-3">{t('accounting.glAddAccount')}</h2>
        <form onSubmit={addAccount} className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="acc-code" required>{t('accounting.glCode')}</Label>
            <Input id="acc-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="acc-name" required>{t('accounting.glName')}</Label>
            <Input id="acc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="acc-name-ar">{t('accounting.glNameAr')}</Label>
            <Input id="acc-name-ar" dir="rtl" value={form.name_ar} onChange={(e) => setForm({ ...form, name_ar: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="acc-type">{t('accounting.glColType')}</Label>
            <Select id="acc-type" value={form.account_type} onChange={(e) => setForm({ ...form, account_type: e.target.value })}>
              {TYPES.map((ty) => (
                <option key={ty} value={ty}>{t(`accounting.glType_${ty}`)}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="acc-parent">{t('accounting.glParent')}</Label>
            <Select id="acc-parent" value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">{t('accounting.glNoParent')}</option>
              {headers.map((a) => (
                <option key={a.id} value={a.id}>{a.code} {accountName(a, i18n.language)}</option>
              ))}
            </Select>
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-sm text-[#211f1b] dark:text-[#e8ebf0]">
              <input
                type="checkbox"
                checked={!form.is_postable}
                onChange={(e) => setForm({ ...form, is_postable: !e.target.checked })}
              />
              {t('accounting.glIsHeader')}
            </label>
            <Button type="submit" disabled={busy}>{t('accounting.glAdd')}</Button>
          </div>
          {formError && <p role="alert" className="sm:col-span-3 text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </form>
      </section>

      <section className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
              <th className="px-4 py-2.5 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glColAccount')}</th>
              <th className="px-4 py-2.5 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glColType')}</th>
              <th className="px-4 py-2.5 text-start text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.colStatus')}</th>
              <th className="px-4 py-2.5 text-end text-xs font-semibold uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {!isLoading && rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-12 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('accounting.glNoAccounts')}</td>
              </tr>
            ) : (
              rows.map((a) => (
                <tr key={a.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230] last:border-0">
                  <td className="px-4 py-2.5 text-[#211f1b] dark:text-[#e8ebf0]" style={{ paddingInlineStart: `${16 + a.depth * 20}px` }}>
                    {editing?.id === a.id ? (
                      <span className="flex flex-wrap gap-2">
                        <Input aria-label={t('accounting.glName')} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                        <Input aria-label={t('accounting.glNameAr')} dir="rtl" value={editing.name_ar} onChange={(e) => setEditing({ ...editing, name_ar: e.target.value })} />
                      </span>
                    ) : (
                      <span className={a.is_postable ? '' : 'font-semibold'}>
                        <span className="font-mono text-xs">{a.code}</span> {accountName(a, i18n.language)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-[#6c6760] dark:text-[#9aa4b2]">
                    {t(`accounting.glType_${a.account_type}`)}{!a.is_postable && ` · ${t('accounting.glHeader')}`}{a.is_bank && ` · ${t('accounting.bankBadge')}`}
                  </td>
                  <td className="px-4 py-2.5 text-[#6c6760] dark:text-[#9aa4b2]">
                    {a.is_active ? t('accounting.glActive') : t('accounting.glInactive')}
                  </td>
                  <td className="px-4 py-2.5 text-end whitespace-nowrap">
                    {editing?.id === a.id ? (
                      <>
                        <Button size="sm" onClick={saveEdit} disabled={busy || !editing.name.trim()}>{t('common.save')}</Button>{' '}
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: a.id, name: a.name, name_ar: a.name_ar || '' })}>
                          {t('accounting.glRename')}
                        </Button>{' '}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => run(() => db.ledger.updateAccount(a.id, { is_active: !a.is_active }), 'accounting.glAccountSaved')}
                        >
                          {a.is_active ? t('accounting.glDeactivate') : t('accounting.glActivate')}
                        </Button>
                        {/* A-07: a bank or cash account can be reconciled against a statement */}
                        {a.is_postable && a.account_type === 'asset' && (
                          <>
                            {' '}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => run(() => db.ledger.updateAccount(a.id, { is_bank: !a.is_bank }), 'accounting.glAccountSaved')}
                            >
                              {a.is_bank ? t('accounting.bankUnmark') : t('accounting.bankMark')}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      {confirmDialog}
    </div>
  )
}
