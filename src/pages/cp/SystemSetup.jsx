import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import CurrencySettings from './CurrencySettings'
import CountrySetup from './setup/CountrySetup'
import BusinessIdentity from './setup/BusinessIdentity'
import RegionalSettings from './setup/RegionalSettings'
import DocumentNumbering from './setup/DocumentNumbering'
import AiSettings from './setup/AiSettings'

/**
 * System Setup — the installation-wide settings, in one place.
 *
 * These were scattered or absent: the currency knobs were reachable only by
 * pasting SQL, the legal name and tax number were split between branding and
 * the PDF layout so two documents could disagree, there was no country anywhere
 * in the schema, and the document counters could not be seen at all.
 *
 * Ordered by how often they are touched and how much depends on them. Currency
 * first because everything downstream is denominated in it; countries second
 * because the phone rules hang off them; then identity, regional settings and
 * numbering, which are set once and rarely revisited.
 */
const SECTIONS = [
  { id: 'currency', labelKey: 'cp.setup.tabCurrency' },
  { id: 'country', labelKey: 'cp.setup.tabCountry' },
  { id: 'identity', labelKey: 'cp.setup.tabIdentity' },
  { id: 'regional', labelKey: 'cp.setup.tabRegional' },
  { id: 'numbering', labelKey: 'cp.setup.tabNumbering' },
  { id: 'ai', labelKey: 'cp.setup.tabAi' },
]

export default function SystemSetup({ currentUserEmail }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState('currency')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-[#e8ebf0]">
          {t('cp.setup.header')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">
          {t('cp.setup.subtitle')}
        </p>
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-[#212a38] overflow-x-auto">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setTab(s.id)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === s.id
                ? 'border-indigo-600 text-indigo-600 dark:text-[#a5b4fc] dark:border-[#a5b4fc]'
                : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700'
            }`}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>

      {tab === 'currency' && <CurrencySettings currentUserEmail={currentUserEmail} />}
      {tab === 'country' && <CountrySetup currentUserEmail={currentUserEmail} />}
      {tab === 'identity' && <BusinessIdentity currentUserEmail={currentUserEmail} />}
      {tab === 'regional' && <RegionalSettings currentUserEmail={currentUserEmail} />}
      {tab === 'numbering' && <DocumentNumbering />}
      {tab === 'ai' && <AiSettings currentUserEmail={currentUserEmail} />}
    </div>
  )
}
