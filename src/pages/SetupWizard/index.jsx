import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button, Label, Select, Spinner } from '../../components/ui'
import { toUserMessage } from '../../lib/errorMessage'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import BusinessIdentity from '../cp/setup/BusinessIdentity'
import RegionalSettings from '../cp/setup/RegionalSettings'
import DocumentNumbering from '../cp/setup/DocumentNumbering'
import AiSettings from '../cp/setup/AiSettings'
import ChartOfAccounts from '../cp/ChartOfAccounts'
import CurrencySettings from '../cp/CurrencySettings'
import BrandingSettings from '../BrandingSettings'
import UserManagement from '../UserManagement'
import OpeningBalancesTab from '../Accounting/OpeningBalancesTab'
import { SETUP_KEY, STEPS, missingRequired, readState, stepDone, suggestedCurrency, writeState } from './_steps'

// The first-run setup wizard (B-03c). Each step hosts the panel that keeps
// that setting afterwards, so the wizard and Control Panel can never
// disagree: saving here is saving there.

const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'
const muted = 'text-[#6c6760] dark:text-[#9aa4b2]'

function configMap(rows) {
  const out = {}
  for (const r of rows || []) out[r.config_key] = r.config_value
  return out
}

// ── country and base currency ───────────────────────────────────────────────
function CountryStep({ config, currentUserEmail, onSaved }) {
  const { t } = useTranslation()
  const countries = useQuery({ queryKey: ['countries'], queryFn: () => db.geo.listCountries() })
  const currencies = useQuery({ queryKey: ['currencies', 'active'], queryFn: () => db.currencies.listActive() })
  const list = (countries.data?.data ?? EMPTY_ARRAY).filter((c) => c.is_active !== false)
  const [country, setCountry] = useState(config.default_country || 'EG')
  const [currency, setCurrency] = useState(config.default_currency || suggestedCurrency(list, config.default_country || 'EG') || 'EGP')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const pickCountry = (code) => {
    setCountry(code)
    const s = suggestedCurrency(list, code)
    if (s && (currencies.data ?? []).some((c) => c.code === s)) setCurrency(s)
  }

  const save = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      // the currency first: the database refuses changing the base once
      // documents use it, and a refusal must not leave the country changed
      if (currency !== config.default_currency) {
        await db.rmaConfig.set('default_currency', currency, currentUserEmail)
      }
      await db.rmaConfig.set('default_country', country, currentUserEmail)
      await onSaved()
      toast.success(t('setupWizard.savedToast'))
    } catch (err) {
      toast.error(toUserMessage(err), { duration: 8000 })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (countries.isLoading || currencies.isLoading) return <div className="py-6 flex justify-center"><Spinner /></div>
  return (
    <div className={`${card} p-[18px] space-y-4`}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="sw-country" required>{t('setupWizard.country')}</Label>
          <Select id="sw-country" value={country} onChange={(e) => pickCountry(e.target.value)}>
            {list.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
          <p className={`text-xs mt-1 ${muted}`}>{t('setupWizard.countryHint')}</p>
        </div>
        <div>
          <Label htmlFor="sw-currency" required>{t('setupWizard.baseCurrency')}</Label>
          <Select id="sw-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {(currencies.data ?? EMPTY_ARRAY).map((c) => <option key={c.code} value={c.code}>{`${c.code} — ${c.name}`}</option>)}
          </Select>
          <p className={`text-xs mt-1 ${muted}`}>{t('setupWizard.baseCurrencyHint')}</p>
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={save} loading={busy}>{t('setupWizard.saveCountry')}</Button>
      </div>
    </div>
  )
}

// ── the page ────────────────────────────────────────────────────────────────
export default function SetupWizard({ currentUserRole, currentUserEmail, currentUserPermissions, onStartPreview }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [stepIdx, setStepIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const cfg = useQuery({
    queryKey: ['rma-config', 'all'],
    queryFn: async () => {
      const r = await db.rmaConfig.getAll()
      return configMap(r.missing ? [] : r.data)
    },
  })
  const config = useMemo(() => cfg.data ?? {}, [cfg.data])
  const state = useMemo(() => readState(config[SETUP_KEY]), [config])
  const ctx = { config, state }
  const step = STEPS[stepIdx]
  const missing = missingRequired(ctx)

  const saveState = async (patch, okKey) => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    try {
      await db.rmaConfig.set(SETUP_KEY, writeState(state, patch), currentUserEmail)
      await queryClient.invalidateQueries({ queryKey: ['rma-config'] })
      if (okKey) toast.success(t(okKey))
      return true
    } catch (err) {
      toast.error(toUserMessage(err), { duration: 8000 })
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rma-config'] })
  const go = (i) => { setStepIdx(Math.max(0, Math.min(STEPS.length - 1, i))); window.scrollTo(0, 0) }
  const markDone = async (id) => {
    if (await saveState({ stepsDone: [...state.stepsDone, id] })) go(stepIdx + 1)
  }

  if (cfg.isLoading) return <div className="py-16 flex justify-center"><Spinner /></div>
  if (cfg.error) return <p role="alert" className="text-sm text-red-600 dark:text-red-400">{cfg.error.message}</p>

  const optional = !step.required && step.id !== 'welcome' && step.id !== 'finish'

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-[#211f1b] dark:text-[#e8ebf0]">{t('setupWizard.title')}</h1>
          <p className={`text-sm ${muted} max-w-[70ch]`}>{t('setupWizard.subtitle')}</p>
        </div>
        {state.status !== 'finished' && (
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={async () => { if (await saveState({ status: 'skipped' }, 'setupWizard.skippedToast')) navigate('/') }}>
            {t('setupWizard.skipForNow')}
          </Button>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* steps */}
        <nav aria-label={t('setupWizard.stepsLabel')} className={`${card} p-2 h-fit`}>
          <ol className="space-y-0.5">
            {STEPS.map((s, i) => {
              const done = stepDone(s.id, ctx)
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => go(i)} aria-current={i === stepIdx ? 'step' : undefined}
                    className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-start text-sm ${
                      i === stepIdx ? 'bg-[#f4f6f9] dark:bg-[#0f1520] font-semibold text-[#211f1b] dark:text-[#e8ebf0]' : `${muted} hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520]`}`}>
                    <span aria-hidden="true" className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      done && s.id !== 'welcome' ? 'bg-green-600 text-white' : 'border border-[#e6e9ef] dark:border-[#212a38]'}`}>
                      {done && s.id !== 'welcome' ? '✓' : i + 1}
                    </span>
                    <span className="flex-1">{t(`setupWizard.step_${s.id}`)}</span>
                    {s.required && !done && <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">{t('setupWizard.required')}</span>}
                    <span className="sr-only">{done && s.id !== 'welcome' ? t('setupWizard.done') : ''}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        {/* the step */}
        <section aria-labelledby="sw-step-title" className="space-y-4 min-w-0">
          <div>
            <h2 id="sw-step-title" className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0]">
              {t(`setupWizard.step_${step.id}`)}
            </h2>
            <p className={`text-sm ${muted} max-w-[75ch]`}>{t(`setupWizard.intro_${step.id}`)}</p>
          </div>

          {step.id === 'welcome' && (
            <div className={`${card} p-[18px] space-y-2 text-sm text-[#211f1b] dark:text-[#e8ebf0]`}>
              <p>{t('setupWizard.welcomeBody')}</p>
              <p className={muted}>{t('setupWizard.welcomeLater')}</p>
            </div>
          )}
          {step.id === 'company' && (
            <div className="space-y-4">
              <BusinessIdentity currentUserEmail={currentUserEmail} />
              <BrandingSettings currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} initialTab="branding" visibleTabs={['branding']} />
            </div>
          )}
          {step.id === 'country' && (
            <div className="space-y-4">
              <CountryStep config={config} currentUserEmail={currentUserEmail}
                onSaved={async () => { await saveState({ stepsDone: [...state.stepsDone, 'country'] }); refresh() }} />
              <CurrencySettings currentUserEmail={currentUserEmail} />
            </div>
          )}
          {step.id === 'regional' && <RegionalSettings currentUserEmail={currentUserEmail} />}
          {step.id === 'numbering' && <DocumentNumbering />}
          {step.id === 'chart' && (
            <div className="space-y-4">
              {!stepDone('chart', ctx) && (
                <div className={`${card} p-[18px] flex flex-wrap items-center gap-3`}>
                  <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0] flex-1 min-w-[14rem]">{t('setupWizard.keepDefaultChartHint')}</p>
                  <Button variant="secondary" disabled={busy}
                    onClick={() => saveState({ chartConfirmed: true }, 'setupWizard.savedToast')}>
                    {t('setupWizard.keepDefaultChart')}
                  </Button>
                </div>
              )}
              <ChartOfAccounts />
            </div>
          )}
          {step.id === 'users' && (
            <UserManagement currentUserRole={currentUserRole} currentUserEmail={currentUserEmail}
              currentUserPermissions={currentUserPermissions} onPreviewUser={onStartPreview} />
          )}
          {step.id === 'email' && (
            <BrandingSettings currentUserRole={currentUserRole} currentUserEmail={currentUserEmail}
              initialTab="email-settings" visibleTabs={['email-settings', 'notifications', 'templates']} />
          )}
          {step.id === 'opening' && <OpeningBalancesTab currentUserRole={currentUserRole} />}
          {step.id === 'ai' && <AiSettings currentUserEmail={currentUserEmail} />}
          {step.id === 'finish' && (
            <div className={`${card} p-[18px] space-y-3`}>
              <ul className="text-sm space-y-1">
                {STEPS.filter((s) => s.id !== 'welcome' && s.id !== 'finish').map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span aria-hidden="true" className={stepDone(s.id, ctx) ? 'text-green-700 dark:text-green-400' : muted}>
                      {stepDone(s.id, ctx) ? '✓' : '–'}
                    </span>
                    <span className="text-[#211f1b] dark:text-[#e8ebf0]">{t(`setupWizard.step_${s.id}`)}</span>
                    <span className={`text-xs ${muted}`}>
                      {stepDone(s.id, ctx) ? t('setupWizard.done') : s.required ? t('setupWizard.required') : t('setupWizard.optionalLater')}
                    </span>
                  </li>
                ))}
              </ul>
              {state.status === 'finished' ? (
                <p className="text-sm text-green-700 dark:text-green-400">{t('setupWizard.finishedNote')}</p>
              ) : missing.length > 0 ? (
                <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
                  {t('setupWizard.missingRequired', { steps: missing.map((m) => t(`setupWizard.step_${m}`)).join(', ') })}
                </p>
              ) : null}
            </div>
          )}

          {/* moving on */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {stepIdx > 0 && <Button variant="secondary" onClick={() => go(stepIdx - 1)}>{t('setupWizard.back')}</Button>}
            <span className="flex-1" />
            {optional && !stepDone(step.id, ctx) && (
              <>
                <Button variant="ghost" onClick={() => go(stepIdx + 1)}>{t('setupWizard.skipStep')}</Button>
                <Button disabled={busy} onClick={() => markDone(step.id)}>{t('setupWizard.markDone')}</Button>
              </>
            )}
            {(!optional || stepDone(step.id, ctx)) && step.id !== 'finish' && (
              <Button onClick={() => go(stepIdx + 1)}>{t('setupWizard.next')}</Button>
            )}
            {step.id === 'finish' && state.status !== 'finished' && (
              <Button disabled={busy || missing.length > 0}
                onClick={async () => {
                  if (await saveState({ status: 'finished', finishedAt: new Date().toISOString(), finishedBy: currentUserEmail }, 'setupWizard.finishedToast')) navigate('/')
                }}>
                {t('setupWizard.finish')}
              </Button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
