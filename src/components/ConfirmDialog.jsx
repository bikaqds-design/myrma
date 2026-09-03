import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The app's confirmation dialog.
 *
 * Both button labels used to be hardcoded English — "Cancel", and a
 * `confirmLabel` defaulting to "Delete". Ten of the eleven call sites took that
 * default, so under Arabic every one of them rendered a right-to-left dialog
 * with two English buttons. They are keyed now, and the default confirm label
 * follows suit; callers that pass their own (Leads passes "Disqualify") are
 * unaffected.
 *
 * The panel was also light-only — `bg-white` and `text-gray-900` with no dark
 * variants — so it flashed white over a dark page.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmClass = 'bg-red-600 hover:bg-red-700 text-white',
  onConfirm,
  onCancel,
}) {
  const { t } = useTranslation()
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (e.key === 'Escape') onCancel?.()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-confirm flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white dark:bg-[#121823] rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 border border-gray-100 dark:border-[#212a38]">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <svg
              className="w-5 h-5 text-red-600 dark:text-red-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-[#e8ebf0]">{title}</h3>
            <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-1 leading-relaxed">{message}</p>
          </div>
        </div>
        <div className="flex gap-3 mt-6 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#e8ebf0] border border-gray-200 dark:border-[#212a38] rounded-xl hover:bg-gray-50 dark:hover:bg-[#1a2230] transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium rounded-xl transition-colors ${confirmClass}`}
          >
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  )
}
