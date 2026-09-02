import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ShieldOff } from 'lucide-react'
import { Button } from './ui'

/**
 * Shown when a signed-in user opens a module their role does not include.
 *
 * Previously these routes rendered `<Navigate to="/" replace />`: the person
 * clicked a link or opened a bookmark and silently arrived on the dashboard,
 * with nothing to say why. Verified during the audit — a viewer requesting
 * /control-panel landed on the dashboard with no message (UX-GLOBAL-014).
 * Access control was working; only the explanation was missing.
 *
 * Distinct from AccessDenied, which replaces the whole app for an account that
 * may not use the system at all (suspended, expired, no role). This one renders
 * inside the normal shell, because the person is a legitimate user who simply
 * took a wrong turn — the sidebar stays, showing what they *can* reach.
 *
 * The module is named and the current role stated, so the request they make to
 * an administrator is specific rather than "it doesn't work".
 */
export default function NoModuleAccess({ module, role }) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  // Fall back to the raw key rather than showing nothing if a module has no
  // nav label yet.
  const moduleName = module ? t(`nav.${module}`, { defaultValue: module }) : null

  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center mb-4">
        <ShieldOff className="w-7 h-7 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      </div>

      <h2 className="text-lg font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-2">
        {moduleName
          ? t('noAccess.titleNamed', { module: moduleName })
          : t('noAccess.title')}
      </h2>

      <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-sm mb-1">
        {t('noAccess.body')}
      </p>

      {role && (
        <p className="text-xs text-[#746f65] dark:text-[#a4acb7] mb-6">
          {t('noAccess.yourRole')}{' '}
          <span className="font-medium">{t(`roles.${role}`, { defaultValue: role })}</span>
        </p>
      )}

      <Button onClick={() => navigate('/')}>{t('noAccess.backToDashboard')}</Button>
    </div>
  )
}
