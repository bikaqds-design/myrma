import React from 'react'
import { useAppearance } from '../contexts/AppearanceContext'

/**
 * Language switch for the screens shown before sign-in.
 *
 * The app has a language setting, but it lived behind authentication: an Arabic
 * speaker had to read an English login screen, sign in, find Appearance, and
 * only then get their own language. The two screens where a new colleague
 * arrives cold — login and the invitation password page — are exactly the ones
 * that could not be switched (UX-AUTH-005).
 *
 * Deliberately not a dropdown. There are two languages; a dropdown would cost a
 * click and hide the choice behind a control whose label is itself in a
 * language the reader may not have.
 *
 * Each option is written in its own script, so it is legible to the person who
 * needs it regardless of the current setting — someone who reads only Arabic
 * can find "العربية" without understanding the word "Arabic".
 */
export default function LanguageToggle({ className = '' }) {
  const { language, setLanguage } = useAppearance()

  const OPTIONS = [
    { code: 'en', label: 'English' },
    { code: 'ar', label: 'العربية' },
  ]

  return (
    <div
      className={`inline-flex items-center rounded-lg border border-gray-200 bg-white p-0.5 ${className}`}
      role="group"
      aria-label="Language / اللغة"
    >
      {OPTIONS.map(({ code, label }) => {
        const active = language === code
        return (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={active}
            onClick={() => setLanguage(code)}
            className={`min-h-[32px] px-3 text-xs font-medium rounded-md transition-colors ${
              active
                ? 'bg-indigo-600 text-white'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
