import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../../lib/errorMessage'
import { Button, Label, Input, Textarea } from '../../../components/ui'
import { captureException } from '../../../lib/sentry'
import { SetupCard } from './_shared'
import { useConfigValue, saveConfig } from './_config'

/**
 * Who this business legally is.
 *
 * These already appear on invoices and purchase orders, but they were split
 * between branding_settings and the PDF layout, so two documents could carry
 * different tax numbers and nothing would notice. One place, one answer.
 *
 * Nothing here is required. A business that has not registered for VAT should
 * leave the tax number blank rather than be forced to invent one, and a blank
 * simply does not print.
 */
const FIELDS = [
  { key: 'legal_name', labelKey: 'cp.setup.legalName', hintKey: 'cp.setup.legalNameHint' },
  { key: 'tax_registration_number', labelKey: 'cp.setup.taxNumber', hintKey: 'cp.setup.taxNumberHint' },
  { key: 'commercial_registration', labelKey: 'cp.setup.crNumber', hintKey: null },
]

export default function BusinessIdentity({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const stored = {
    legal_name: useConfigValue('legal_name', ''),
    tax_registration_number: useConfigValue('tax_registration_number', ''),
    commercial_registration: useConfigValue('commercial_registration', ''),
    registered_address: useConfigValue('registered_address', ''),
  }

  const [form, setForm] = useState(stored)
  // Config arrives asynchronously; seed the form once it does, but never
  // overwrite something the user has started typing.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) setForm(stored)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored.legal_name, stored.tax_registration_number, stored.commercial_registration, stored.registered_address])

  const set = (key, value) => {
    setTouched(true)
    setForm((f) => ({ ...f, [key]: value }))
  }

  const save = async () => {
    setBusy(true)
    try {
      for (const [key, value] of Object.entries(form)) {
        await saveConfig(key, (value ?? '').trim(), currentUserEmail)
      }
      queryClient.invalidateQueries({ queryKey: ['rma-config'] })
      setTouched(false)
      toast.success(t('cp.setup.saved'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SetupCard
      title={t('cp.setup.identityTitle')}
      action={
        <Button onClick={save} disabled={busy || !touched}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
      }
    >
      <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-4">
        {t('cp.setup.identityHint')}
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <Label>{t(f.labelKey)}</Label>
            <Input
              aria-label={t(f.labelKey)}
              value={form[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
            />
            {f.hintKey && (
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">{t(f.hintKey)}</p>
            )}
          </div>
        ))}
        <div className="sm:col-span-2">
          <Label>{t('cp.setup.registeredAddress')}</Label>
          <Textarea
            aria-label={t('cp.setup.registeredAddress')}
            rows={3}
            value={form.registered_address ?? ''}
            onChange={(e) => set('registered_address', e.target.value)}
          />
        </div>
      </div>
    </SetupCard>
  )
}
