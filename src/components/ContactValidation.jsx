import React from 'react'
import { useTranslation } from 'react-i18next'
import { isPhoneProblem, PHONE_OK, PHONE_EMPTY } from '../lib/phone'

/**
 * The note under a phone field.
 *
 * Silent when the field is empty, when the number is fine, and when the country
 * has no rules — three cases where saying something would be noise. Red on a
 * new record because it will stop the save; amber on an existing one because it
 * will not.
 */
export function PhoneNote({ result, editing }) {
  const { t } = useTranslation()
  if (!result) return null
  if (result.code === PHONE_OK || result.code === PHONE_EMPTY) return null
  // "No rules" means nothing was checked. Announcing that on every field would
  // train people to ignore the line where a real problem later appears.
  if (!isPhoneProblem(result)) return null

  const tone = editing
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-red-600 dark:text-red-400'

  return (
    <p className={`text-xs mt-1 ${tone}`}>
      {t(`phone.${result.code}`, {
        expected: result.expected,
        actual: result.actual,
        area: result.area?.name,
      })}
      {editing && <span className="ms-1 opacity-80">{t('phone.savedAnyway')}</span>}
    </p>
  )
}

/** The note under an email field. Always a suggestion, never a refusal. */
export function EmailNote({ result, onAccept }) {
  const { t } = useTranslation()
  if (!result?.warning) return null
  return (
    <p className="text-xs mt-1 text-amber-600 dark:text-amber-400">
      {t('phone.emailTypo', { domain: result.domain, suggestion: result.suggestion })}
      {onAccept && (
        <button
          type="button"
          onClick={() => onAccept(result.suggestion)}
          className="ms-1 underline font-medium"
        >
          {t('phone.emailUseSuggestion')}
        </button>
      )}
    </p>
  )
}
