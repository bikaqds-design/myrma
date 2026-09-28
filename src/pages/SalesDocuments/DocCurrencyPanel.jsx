import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { Button } from '../../components/ui'
import { CurrencyRateFields } from '../../components/CurrencyRateFields'
import { useDocumentCurrency } from '../../hooks/useDocumentCurrency'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { currencyLock, fmtCurrency, toBase } from '../Accounting/_currency'

// A sales document's currency and rate (A-05b over 20260912): what it is in,
// its total in the base currency at its rate, and — on a draft its author may
// edit — a way to change them (set_document_currency; the database checks who
// and when, and keeps a document made from another in that one's currency).

export default function DocCurrencyPanel({ docType, doc, status, canEdit, onChanged }) {
  const { t } = useTranslation()
  const baseCurrency = useBaseCurrency()
  const [editing, setEditing] = useState(false)
  if (!doc) return null
  const currency = doc.currency || baseCurrency
  const rate = Number(doc.exchange_rate) || 1
  const foreign = currency !== baseCurrency
  const lock = currencyLock(docType, doc)
  const canChange = canEdit && status === 'draft' && lock !== 'both'

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label={t('salesDocuments.fxPanel')}>
      <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fxCurrency')}</span>
      <span className="font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{currency}</span>
      {foreign && (
        <>
          <span className="text-[#6c6760] dark:text-[#9aa4b2]">{t('salesDocuments.fxRateValue', { currency, rate: rate.toLocaleString(undefined, { maximumFractionDigits: 8 }), base: baseCurrency })}</span>
          <span className="text-[#6c6760] dark:text-[#9aa4b2]">
            {t('salesDocuments.fxTotalInBase', { amount: fmtCurrency(toBase(doc.total, rate), baseCurrency) })}
          </span>
        </>
      )}
      {canChange && !editing && (
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t('salesDocuments.fxChange')}</Button>
      )}
      {editing && (
        <CurrencyEditor
          doc={doc}
          docType={docType}
          currencyLocked={lock === 'currency'}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged?.() }}
        />
      )}
    </div>
  )
}

function CurrencyEditor({ doc, docType, currencyLocked, onClose, onSaved }) {
  const { t } = useTranslation()
  const cx = useDocumentCurrency({ currency: doc.currency, exchange_rate: doc.exchange_rate })
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  // a document made from another keeps its currency: only the rate is offered
  const view = currencyLocked ? { ...cx, options: cx.options.filter((c) => c.code === doc.currency) } : cx

  const save = async () => {
    if (!cx.rateValid || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await db.exchangeRates.setDocumentCurrency(docType, doc.id, cx.payload.currency, cx.isForeign ? cx.payload.exchangeRate : null)
      toast.success(t('salesDocuments.fxSavedToast'))
      onSaved()
    } catch (e) {
      toast.error(e?.message || t('common.error'), { duration: 7000 })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <div className="w-full grid gap-3 sm:grid-cols-3 items-end p-3 rounded-lg border border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
      <CurrencyRateFields cx={view} />
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
        <Button size="sm" loading={busy} disabled={!cx.rateValid} onClick={save}>{t('common.save')}</Button>
      </div>
    </div>
  )
}
