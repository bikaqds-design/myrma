import { useTranslation } from 'react-i18next'
import { ShieldOff, Clock, LogOut, Mail } from 'lucide-react'
import { ACCESS_DENIED } from '../lib/permissions'

/**
 * Shown to a signed-in account that may not use the app.
 *
 * Every reason here is one the database enforces independently: since 20260786
 * rma_user_role() returns NULL for a suspended, locked, deactivated, pending or
 * expired account, and for one with no user_roles row at all, so every RLS
 * policy denies. This screen exists so the person is told which of those it is
 * instead of meeting an app shell where nothing loads.
 *
 * The reason comes from accessDenialReason(), which mirrors the SQL helper.
 * An unrecognised status falls through to the generic message rather than
 * being treated as access.
 */
export default function AccessDenied({ reason, email, row, onSignOut }) {
  const { t } = useTranslation()

  const isExpiry = reason === ACCESS_DENIED.EXPIRED
  const Icon = isExpiry ? Clock : ShieldOff

  const KNOWN = [
    ACCESS_DENIED.NO_ROLE,
    ACCESS_DENIED.SUSPENDED,
    ACCESS_DENIED.LOCKED,
    ACCESS_DENIED.DEACTIVATED,
    ACCESS_DENIED.PENDING,
    ACCESS_DENIED.EXPIRED,
    ACCESS_DENIED.LOOKUP_FAILED,
  ]
  const key = KNOWN.includes(reason) ? reason : 'unknown'

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f4f6f9] dark:bg-[#0b0f17] px-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-[#1a2230] bg-white dark:bg-[#111726] p-8 text-center shadow-sm">
        <div
          className={
            'mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full ' +
            (isExpiry
              ? 'bg-amber-100 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400'
              : 'bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400')
          }
        >
          <Icon className="h-7 w-7" aria-hidden="true" />
        </div>

        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {t(`accessDenied.${key}.title`)}
        </h1>

        <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-[#9aa4b2]">
          {t(`accessDenied.${key}.body`)}
        </p>

        {email && (
          <p className="mt-4 flex items-center justify-center gap-2 text-xs text-gray-500 dark:text-[#6b7684]">
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            <span dir="ltr">{email}</span>
          </p>
        )}

        {/* The reason an administrator typed when suspending or locking the
            account. Shown because "contact your administrator" is far less
            useful than "returned equipment not handed back". */}
        {row?.suspended_reason && (
          <div className="mt-5 rounded-lg bg-gray-50 dark:bg-[#0b0f17] px-4 py-3 text-start">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-[#6b7684]">
              {t('accessDenied.reasonLabel')}
            </div>
            <div className="mt-1 text-sm text-gray-800 dark:text-gray-200">
              {row.suspended_reason}
            </div>
          </div>
        )}

        {isExpiry && row?.access_expires_at && (
          <div className="mt-5 rounded-lg bg-gray-50 dark:bg-[#0b0f17] px-4 py-3 text-start">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-[#6b7684]">
              {t('accessDenied.expiredOnLabel')}
            </div>
            <div className="mt-1 text-sm text-gray-800 dark:text-gray-200">
              {new Date(row.access_expires_at).toLocaleString()}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onSignOut}
          className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 dark:bg-[#1a2230] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 dark:hover:bg-[#232c3d]"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {t('accessDenied.signOut')}
        </button>
      </div>
    </div>
  )
}
