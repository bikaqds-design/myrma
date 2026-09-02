import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../../lib/errorMessage'
import { db } from '../../../api/supabaseClient'
import { toRules } from '../../../api/db/geo'
import { Button, Label, Input, Select } from '../../../components/ui'
import { captureException } from '../../../lib/sentry'
import { EMPTY_ARRAY } from '../../../lib/stableEmpty'
import { validateMobile, validateLandline, PHONE_OK } from '../../../lib/phone'
import { SetupCard } from './_shared'
import { useConfigValue, saveConfig } from './_config'

/**
 * Countries and the phone rules that hang off them.
 *
 * The default country is what every customer and vendor validates against
 * unless its own record says otherwise. It is also the link the brief asked
 * for: a country carries a currency, so choosing Egypt implies EGP.
 *
 * The tester at the bottom exists because a rule you cannot try is a rule
 * nobody trusts. Someone adding a governorate should be able to paste a real
 * number and see it accepted before a customer is turned away by it.
 */
export default function CountrySetup({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ areaCode: '', name: '', digits: '7' })
  const [testMobile, setTestMobile] = useState('')
  const [testLandline, setTestLandline] = useState('')

  const { data: countriesRes, isLoading } = useQuery({
    queryKey: ['countries'],
    queryFn: () => db.geo.listCountries(),
  })
  const { data: areaCodes = EMPTY_ARRAY } = useQuery({
    queryKey: ['country-area-codes'],
    queryFn: () => db.geo.listAreaCodes(),
  })
  const defaultCountry = useConfigValue('default_country', 'EG')

  const countries = countriesRes?.data ?? EMPTY_ARRAY
  const missing = countriesRes?.missing
  const active = selected || defaultCountry
  const country = countries.find((c) => c.code === active)
  const rules = country ? toRules(country, areaCodes) : null
  const areas = areaCodes.filter((a) => a.country_code === active)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['countries'] })
    queryClient.invalidateQueries({ queryKey: ['country-area-codes'] })
    queryClient.invalidateQueries({ queryKey: ['rma-config'] })
  }

  const setDefault = async (code) => {
    setBusy(true)
    try {
      await saveConfig('default_country', code, currentUserEmail)
      refresh()
      toast.success(t('cp.setup.saved'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const addArea = async () => {
    setBusy(true)
    try {
      await db.geo.addAreaCode({
        countryCode: active,
        areaCode: form.areaCode,
        name: form.name,
        digits: Number(form.digits) || 7,
      })
      setForm({ areaCode: '', name: '', digits: '7' })
      setAdding(false)
      refresh()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const removeArea = async (id) => {
    setBusy(true)
    try {
      await db.geo.removeAreaCode(id)
      refresh()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) return <div className="py-12 text-center text-sm text-gray-500">{t('common.loading')}</div>
  if (missing) {
    return (
      <SetupCard title={t('cp.setup.countryTitle')}>
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">{t('cp.setup.countryNotProvisioned')}</p>
      </SetupCard>
    )
  }

  const mobileResult = testMobile ? validateMobile(testMobile, rules) : null
  const landlineResult = testLandline ? validateLandline(testLandline, rules) : null

  return (
    <div className="space-y-6">
      <SetupCard title={t('cp.setup.defaultCountryTitle')}>
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2] mb-3">
          {t('cp.setup.defaultCountryHint')}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px]">
            <Label>{t('cp.setup.defaultCountry')}</Label>
            <Select
              aria-label={t('cp.setup.defaultCountry')}
              value={defaultCountry || ''}
              onChange={(e) => setDefault(e.target.value)}
              disabled={busy}
            >
              {countries.filter((c) => c.is_active).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.dial_code}){c.currency_code ? ` · ${c.currency_code}` : ''}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] pb-2">
            {t('cp.setup.defaultCountryCurrency')}
          </p>
        </div>
      </SetupCard>

      <SetupCard
        title={t('cp.setup.rulesTitle')}
        action={
          <Select
            aria-label={t('cp.setup.viewingCountry')}
            value={active || ''}
            onChange={(e) => { setSelected(e.target.value); setAdding(false) }}
            className="w-auto"
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </Select>
        }
      >
        {!country ? (
          <p className="text-sm text-gray-500">{t('cp.setup.noCountry')}</p>
        ) : (
          <>
            <div className="grid sm:grid-cols-4 gap-4 text-sm">
              <Fact label={t('cp.setup.dialCode')} value={country.dial_code} />
              <Fact
                label={t('cp.setup.trunkPrefix')}
                value={country.trunk_prefix === '' ? t('cp.setup.none') : country.trunk_prefix}
              />
              <Fact
                label={t('cp.setup.mobilePrefixes')}
                value={(country.mobile_prefixes || []).join(', ') || t('cp.setup.any')}
              />
              <Fact
                label={t('cp.setup.mobileDigits')}
                value={country.mobile_digits ?? '—'}
              />
            </div>

            {/* The digit count is written the way the country says it, and
                whether the trunk prefix is counted differs — Egypt's 11
                includes the 0, a Kuwaiti 8 has none to include. */}
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-3">
              {t('cp.setup.digitsExplain', {
                digits: country.mobile_digits ?? '—',
                trunk: country.trunk_prefix === '' ? t('cp.setup.none') : country.trunk_prefix,
              })}
            </p>
          </>
        )}
      </SetupCard>

      <SetupCard
        title={t('cp.setup.areaCodesTitle')}
        action={
          !adding && country && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t('cp.setup.addAreaCode')}
            </Button>
          )
        }
      >
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-3">
          {areas.length === 0
            ? t('cp.setup.noAreaCodes')
            : t('cp.setup.areaCodesHint')}
        </p>

        {areas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
                  <th className="py-2 text-start text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colAreaCode')}</th>
                  <th className="py-2 text-start text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colArea')}</th>
                  <th className="py-2 text-center text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colSubscriberDigits')}</th>
                  <th className="py-2 text-start text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.setup.colExample')}</th>
                  <th className="py-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr key={a.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                    <td className="py-2.5 font-mono font-semibold text-gray-900 dark:text-[#e8ebf0]">
                      {country?.trunk_prefix}{a.area_code}
                    </td>
                    <td className="py-2.5 text-gray-700 dark:text-[#e8ebf0]">{a.name}</td>
                    <td className="py-2.5 text-center text-gray-700 dark:text-[#e8ebf0]">{a.digits}</td>
                    {/* An example is worth more than the two numbers beside it:
                        it is the thing a person can compare against a real
                        number on a business card. */}
                    <td className="py-2.5 font-mono text-xs text-gray-500 dark:text-[#9aa4b2]">
                      {country?.trunk_prefix}{a.area_code}{'x'.repeat(a.digits)}
                    </td>
                    <td className="py-2.5 text-end">
                      <button
                        type="button"
                        onClick={() => removeArea(a.id)}
                        disabled={busy}
                        aria-label={`${t('common.delete')} ${a.area_code}`}
                        className="text-[#6c6760] dark:text-[#9aa4b2] hover:text-red-600 disabled:opacity-50"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adding && (
          <div className="grid sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <div>
              <Label required>{t('cp.setup.colAreaCode')}</Label>
              <Input
                aria-label={t('cp.setup.colAreaCode')}
                value={form.areaCode}
                placeholder="2"
                onChange={(e) => setForm({ ...form, areaCode: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label required>{t('cp.setup.colArea')}</Label>
              <Input
                aria-label={t('cp.setup.colArea')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <Label required>{t('cp.setup.colSubscriberDigits')}</Label>
              <Input
                aria-label={t('cp.setup.colSubscriberDigits')}
                type="number"
                min="4"
                max="12"
                value={form.digits}
                onChange={(e) => setForm({ ...form, digits: e.target.value })}
              />
            </div>
            <div className="sm:col-span-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
              <Button
                onClick={addArea}
                disabled={busy || !form.areaCode.trim() || !form.name.trim()}
              >
                {busy ? t('common.saving') : t('common.add')}
              </Button>
            </div>
          </div>
        )}
      </SetupCard>

      {/* A rule you cannot try is a rule nobody trusts. */}
      <SetupCard title={t('cp.setup.testerTitle')}>
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-3">
          {t('cp.setup.testerHint', { country: country?.name ?? '—' })}
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label>{t('cp.setup.testMobile')}</Label>
            <Input
              aria-label={t('cp.setup.testMobile')}
              value={testMobile}
              placeholder="01012345678"
              onChange={(e) => setTestMobile(e.target.value)}
            />
            <Verdict result={mobileResult} />
          </div>
          <div>
            <Label>{t('cp.setup.testLandline')}</Label>
            <Input
              aria-label={t('cp.setup.testLandline')}
              value={testLandline}
              placeholder="0223456789"
              onChange={(e) => setTestLandline(e.target.value)}
            />
            <Verdict result={landlineResult} />
          </div>
        </div>
      </SetupCard>
    </div>
  )
}

function Fact({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2]">{label}</div>
      <div className="font-medium text-gray-900 dark:text-[#e8ebf0] mt-0.5">{value}</div>
    </div>
  )
}

function Verdict({ result }) {
  const { t } = useTranslation()
  if (!result) return null
  const ok = result.code === PHONE_OK
  return (
    <p className={`text-xs mt-1 ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
      {t(`phone.${result.code}`, {
        expected: result.expected,
        actual: result.actual,
        area: result.area?.name,
      })}
    </p>
  )
}
