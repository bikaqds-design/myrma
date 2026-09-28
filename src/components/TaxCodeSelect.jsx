import React from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from './ui'
import { useTaxCodes } from '../lib/useTaxCodes'
import { applyTaxCode, codeOptions, fmtRate, taxCodeName } from '../pages/Accounting/_tax'

/**
 * A document line's tax code (A-04b). Picking a code sets the line's rate to
 * the code's (what the database stores anyway). Left empty, the line keeps its
 * rate and the database gives it the default code for that rate.
 * onChange receives the fields to merge into the line: { tax_code, tax_pct? }.
 */
export default function TaxCodeSelect({ value, rate, onChange, className = '', label }) {
  const { t, i18n } = useTranslation()
  const codes = useTaxCodes()
  const options = codeOptions(codes, value)
  return (
    <Select
      aria-label={label || t('accounting.taxCode')}
      value={value || ''}
      onChange={(e) => onChange(applyTaxCode(codes, e.target.value))}
      className={className}
    >
      <option value="">{t('accounting.taxByRate', { rate: fmtRate(rate) })}</option>
      {options.map((c) => (
        <option key={c.code} value={c.code}>
          {`${c.code} · ${taxCodeName(c, i18n.language)} (${fmtRate(c.rate)}%)`}
        </option>
      ))}
    </Select>
  )
}
