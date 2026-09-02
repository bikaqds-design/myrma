import { useState, useEffect, useCallback } from 'react'
import { useBaseCurrency } from './useBaseCurrency'
import { useCurrencyOptions } from './useCurrencyOptions'

/**
 * Currency and exchange-rate state for a purchasing document.
 *
 * Shared by the purchase order and vendor invoice forms because the rules are
 * identical and easy to get subtly different: a document in the base currency
 * must carry a rate of exactly 1, and a foreign one must not. The database
 * enforces both (20260792), so a form that lets either through produces an
 * error the user did not cause and cannot interpret.
 *
 * `payload` is what to send: currency always set, rate forced to 1 for base so
 * a stale value left in the field can never be submitted.
 */
export function useDocumentCurrency(initial) {
  const baseCurrency = useBaseCurrency()
  const options = useCurrencyOptions(baseCurrency)

  const [currency, setCurrency] = useState(initial?.currency || '')
  const [exchangeRate, setExchangeRate] = useState(
    initial?.exchange_rate != null ? String(initial.exchange_rate) : '1'
  )

  // A new document opens in the base currency. An existing one keeps its own,
  // so editing a USD invoice does not silently convert it to EGP on save.
  useEffect(() => {
    if (!currency) setCurrency(baseCurrency)
  }, [baseCurrency, currency])

  const isForeign = Boolean(currency) && currency !== baseCurrency
  const rateValue = Number(exchangeRate)
  const rateValid = !isForeign || (Number.isFinite(rateValue) && rateValue > 0)

  /**
   * Stable across renders, and updates the rate functionally rather than by
   * reading `exchangeRate` from the closure. Callers put it in effect
   * dependency arrays — a caller that follows the currency of the document it
   * was opened on has to — and an identity that changed whenever the rate was
   * typed into would restart those effects on every keystroke.
   */
  const selectCurrency = useCallback(
    (next) => {
      setCurrency(next)
      setExchangeRate((prev) => {
        // Snap rather than leave a stale foreign rate that the database rejects.
        if (next === baseCurrency) return '1'
        // Clear the placeholder 1 so a foreign document cannot be saved at par
        // by simply not touching the field — that would record foreign amounts
        // as though they were already base currency.
        return prev === '1' || !prev ? '' : prev
      })
    },
    [baseCurrency]
  )

  return {
    baseCurrency,
    options,
    currency,
    selectCurrency,
    exchangeRate,
    setExchangeRate,
    isForeign,
    rateValue,
    rateValid,
    payload: {
      currency: currency || baseCurrency,
      exchangeRate: isForeign ? rateValue : 1,
    },
  }
}
