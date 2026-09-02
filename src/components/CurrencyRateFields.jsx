import React from 'react'
import { useTranslation } from 'react-i18next'
import { Label, Select, Input } from './ui'
import { formatMoney } from '../lib/money'

/**
 * Currency picker and, for a foreign document, its exchange rate.
 *
 * Shared by the purchase order and vendor invoice forms. The rate field only
 * appears when it is needed — showing a disabled "1" on every local purchase
 * would be noise on the common case, and this business buys locally most of the
 * time.
 *
 * The preview line matters more than it looks. An exchange rate is a number
 * with a direction, and "48.5" tells you nothing about which way it goes.
 * "$ 1.00 = E£ 48.50" is unambiguous, and catches an inverted rate — the
 * mistake that would cost a whole shipment at a fiftieth of its value — before
 * it is saved rather than after it has priced the stock.
 */
export function CurrencyRateFields({ cx }) {
  const { t } = useTranslation()
  const { baseCurrency, options, currency, selectCurrency, exchangeRate, setExchangeRate, isForeign, rateValue, rateValid } = cx

  return (
    <>
      <div>
        <Label>{t('purchasing.currency')}</Label>
        <Select
          aria-label={t('purchasing.currency')}
          value={currency}
          onChange={(e) => selectCurrency(e.target.value)}
          className="w-full"
        >
          {options.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code === baseCurrency
                ? `${c.code} — ${t('purchasing.baseCurrency')}`
                : `${c.code} — ${c.name}`}
            </option>
          ))}
        </Select>
      </div>

      {isForeign && (
        <div>
          <Label>{t('purchasing.exchangeRate', { currency, base: baseCurrency })}</Label>
          <Input
            aria-label={t('purchasing.exchangeRate', { currency, base: baseCurrency })}
            type="number"
            step="0.00000001"
            min="0"
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
            className="w-full"
            placeholder={t('purchasing.exchangeRateHint', { currency, base: baseCurrency })}
          />
          {rateValid && rateValue > 0 ? (
            <p className="text-xs text-gray-500 mt-1">
              {t('purchasing.exchangeRatePreview', {
                amount: formatMoney(1, currency),
                converted: formatMoney(rateValue, baseCurrency),
              })}
            </p>
          ) : (
            <p className="text-xs text-red-600 mt-1">
              {t('purchasing.exchangeRateRequired', { currency })}
            </p>
          )}
        </div>
      )}
    </>
  )
}
