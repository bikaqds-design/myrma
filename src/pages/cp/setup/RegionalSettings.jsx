import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Button, Label, Input, Select } from '../../../components/ui'
import { captureException } from '../../../lib/sentry'
import { SetupCard } from './_shared'
import { useConfigValue, saveConfig } from './_config'

/**
 * Tax, fiscal year, timezone, and the email typo warning.
 *
 * Each of these was an assumption baked into code: every tax percentage was
 * typed by hand on every line, every "this year" filter meant the calendar
 * year, and every timestamp was rendered in whatever timezone the viewer's
 * browser happened to be in — which for a business with one office is a
 * silently wrong answer whenever someone travels.
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/** Kept short deliberately: a full IANA list is 400 entries of noise here. */
const TIMEZONES = [
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Istanbul',
  'America/New_York',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'UTC',
]

export default function RegionalSettings({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const taxRate = useConfigValue('default_tax_rate', 14)
  const fiscalMonth = useConfigValue('fiscal_year_start_month', 1)
  const timezone = useConfigValue('timezone', 'Africa/Cairo')
  const typoWarnings = useConfigValue('email_typo_warnings', true)

  const [draftTax, setDraftTax] = useState(null)

  const write = async (key, value) => {
    setBusy(true)
    try {
      await saveConfig(key, value, currentUserEmail)
      queryClient.invalidateQueries({ queryKey: ['rma-config'] })
      toast.success(t('cp.setup.saved'))
    } catch (err) {
      captureException(err)
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  const taxValue = draftTax ?? String(taxRate ?? '')
  const taxNumber = Number(taxValue)
  const taxValid = Number.isFinite(taxNumber) && taxNumber >= 0 && taxNumber <= 100

  return (
    <div className="space-y-6">
      <SetupCard title={t('cp.setup.taxTitle')}>
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-3">
          {t('cp.setup.taxHint')}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <Label>{t('cp.setup.taxRate')}</Label>
            <Input
              aria-label={t('cp.setup.taxRate')}
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={taxValue}
              onChange={(e) => setDraftTax(e.target.value)}
            />
          </div>
          <Button
            onClick={async () => { await write('default_tax_rate', taxNumber); setDraftTax(null) }}
            disabled={busy || !taxValid || draftTax === null}
          >
            {busy ? t('common.saving') : t('common.save')}
          </Button>
          {!taxValid && (
            <p className="text-xs text-red-600 pb-2">{t('cp.setup.taxRange')}</p>
          )}
        </div>
        {/* This is a default for new lines. Changing it never touches a line
            already typed, which is the only safe behaviour for a rate that
            appears on issued documents. */}
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-3">
          {t('cp.setup.taxNotRetroactive')}
        </p>
      </SetupCard>

      <SetupCard title={t('cp.setup.fiscalTitle')}>
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-3">
          {t('cp.setup.fiscalHint')}
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label>{t('cp.setup.fiscalStart')}</Label>
            <Select
              aria-label={t('cp.setup.fiscalStart')}
              value={String(fiscalMonth ?? 1)}
              onChange={(e) => write('fiscal_year_start_month', Number(e.target.value))}
              disabled={busy}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={i + 1}>{t(`months.${m}`)}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('cp.setup.timezone')}</Label>
            <Select
              aria-label={t('cp.setup.timezone')}
              value={timezone || 'Africa/Cairo'}
              onChange={(e) => write('timezone', e.target.value)}
              disabled={busy}
            >
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </div>
        </div>
      </SetupCard>

      <SetupCard title={t('cp.setup.emailTitle')}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">
              {t('cp.setup.emailHint')}
            </p>
            {/* Stated plainly because it is a deliberate choice, not an
                omission: an allowlist would reject a new customer on their own
                company domain, which is the worst possible thing to reject. */}
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-2">
              {t('cp.setup.emailNoAllowlist')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => write('email_typo_warnings', !typoWarnings)}
            disabled={busy}
            aria-label={t('cp.setup.emailTitle')}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
              typoWarnings ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-[#2a3441]'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                typoWarnings ? 'translate-x-4' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </SetupCard>
    </div>
  )
}
