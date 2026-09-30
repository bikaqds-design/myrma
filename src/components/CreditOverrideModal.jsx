import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay, ModalCard, Button, Label, Textarea } from './ui'
import { validateOverrideReason } from '../pages/SalesDocuments/_credit'

// A-06 (20260919): the database refused a sale over the customer's credit
// limit. A manager may approve it, with a reason kept on the document; the
// caller then retries the approval. Everyone else only sees the refusal.

export default function CreditOverrideModal({ message, onCancel, onApprove }) {
  const { t, i18n } = useTranslation()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)

  const submit = async (e) => {
    e.preventDefault()
    const bad = validateOverrideReason(reason)
    if (bad) { setErr(t(bad)); return }
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await onApprove(reason.trim())
    } catch (ex) {
      setErr(ex?.message || t('common.error'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onCancel}>
      <ModalCard aria-label={t('salesDocuments.credOverrideTitle')} dir={i18n.language === 'ar' ? 'rtl' : 'ltr'}
        className="dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] max-w-lg w-full">
        <form onSubmit={submit} className="p-5 space-y-3">
          <h2 className="text-base font-bold text-[#211f1b] dark:text-[#e8ebf0]">{t('salesDocuments.credOverrideTitle')}</h2>
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{message}</p>
          <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.credOverrideHint')}</p>
          <div>
            <Label htmlFor="cred-override-reason" required>{t('salesDocuments.credOverrideReason')}</Label>
            <Textarea id="cred-override-reason" rows={3} value={reason}
              onChange={(e) => { setReason(e.target.value); setErr(null) }}
              aria-invalid={err ? true : undefined} aria-describedby={err ? 'cred-override-err' : undefined} />
          </div>
          {err && <p id="cred-override-err" role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
            <Button type="submit" loading={busy}>{t('salesDocuments.credOverrideApprove')}</Button>
          </div>
        </form>
      </ModalCard>
    </ModalOverlay>
  )
}
