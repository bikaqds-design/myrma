import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../../lib/errorMessage'
import { Button, Label, Input } from '../../../components/ui'
import { captureException } from '../../../lib/sentry'
import { SetupCard } from './_shared'
import { useConfigValue, saveConfig } from './_config'

/**
 * The Knowledge Center's answer engine.
 *
 * Three settings, and one thing that is deliberately absent.
 *
 * The API KEY IS NOT HERE and must never be. Everything on this page is
 * readable by every staff member and travels in every backup. The key lives
 * only in the Edge Function's secret store, which is why the instructions for
 * setting it are on this page but the field is not.
 */
export default function AiSettings({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const storedModel = useConfigValue('kb_llm_model', '')
  const storedBaseUrl = useConfigValue('kb_llm_base_url', '')
  const storedMaxTokens = useConfigValue('kb_llm_max_tokens', 4096)

  const [form, setForm] = useState({ model: '', baseUrl: '', maxTokens: '4096' })
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!touched) {
      setForm({
        model: storedModel || '',
        baseUrl: storedBaseUrl || '',
        maxTokens: String(storedMaxTokens ?? 4096),
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedModel, storedBaseUrl, storedMaxTokens])

  const set = (key, value) => {
    setTouched(true)
    setForm((f) => ({ ...f, [key]: value }))
  }

  const tokens = Number(form.maxTokens)
  const tokensValid = Number.isFinite(tokens) && tokens >= 256 && tokens <= 32768

  const save = async () => {
    setBusy(true)
    try {
      await saveConfig('kb_llm_model', form.model.trim(), currentUserEmail)
      await saveConfig('kb_llm_base_url', form.baseUrl.trim(), currentUserEmail)
      await saveConfig('kb_llm_max_tokens', tokens, currentUserEmail)
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

  // A key pasted into the model box would be stored in plain text and read by
  // everyone. Catching it here is worth more than the migration's guard,
  // because this is where someone would actually do it.
  const looksLikeKey = /^(nvapi-|sk-|gsk_)/.test(form.model.trim())

  return (
    <div className="space-y-6">
      <SetupCard
        title={t('cp.setup.aiTitle')}
        action={
          <Button onClick={save} disabled={busy || !touched || !tokensValid || looksLikeKey}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        }
      >
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-4">{t('cp.setup.aiHint')}</p>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Label>{t('cp.setup.aiModel')}</Label>
            <Input
              aria-label={t('cp.setup.aiModel')}
              value={form.model}
              placeholder="nvidia/nemotron-3-ultra-550b-a55b"
              onChange={(e) => set('model', e.target.value)}
            />
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
              {t('cp.setup.aiModelHint')}
            </p>
            {looksLikeKey && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1 font-medium">
                {t('cp.setup.aiModelIsKey')}
              </p>
            )}
          </div>

          <div>
            <Label>{t('cp.setup.aiBaseUrl')}</Label>
            <Input
              aria-label={t('cp.setup.aiBaseUrl')}
              value={form.baseUrl}
              placeholder="https://integrate.api.nvidia.com/v1"
              onChange={(e) => set('baseUrl', e.target.value)}
            />
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
              {t('cp.setup.aiBaseUrlHint')}
            </p>
          </div>

          <div>
            <Label>{t('cp.setup.aiMaxTokens')}</Label>
            <Input
              aria-label={t('cp.setup.aiMaxTokens')}
              type="number"
              min="256"
              max="32768"
              step="256"
              value={form.maxTokens}
              onChange={(e) => set('maxTokens', e.target.value)}
            />
            {/* The one that catches people out. A reasoning model spends this
                budget thinking before it writes anything, so a small number
                returns an empty answer rather than a short one. */}
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
              {t('cp.setup.aiMaxTokensHint')}
            </p>
            {!tokensValid && (
              <p className="text-xs text-red-600 mt-1">{t('cp.setup.aiMaxTokensRange')}</p>
            )}
          </div>
        </div>
      </SetupCard>

      <SetupCard title={t('cp.setup.aiKeyTitle')}>
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">{t('cp.setup.aiKeyBody')}</p>
        <pre className="mt-3 p-3 rounded-lg bg-gray-900 text-gray-100 text-xs overflow-x-auto">
          {t('cp.setup.aiKeyCommand')}
        </pre>
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2] mt-4">{t('cp.setup.aiDeploy')}</p>
        <pre className="mt-2 p-3 rounded-lg bg-gray-900 text-gray-100 text-xs overflow-x-auto">
          {t('cp.setup.aiDeployCommand')}
        </pre>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-3">
          {t('cp.setup.aiKeyWhyNotHere')}
        </p>
      </SetupCard>
    </div>
  )
}
