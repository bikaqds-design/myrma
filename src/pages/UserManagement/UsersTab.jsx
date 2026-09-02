import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmailNote } from '../../components/ContactValidation'
import { checkEmail } from '../../lib/emailPolicy'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { ROLES } from '../../lib/constants'
import { StatusBadge, RoleBadge, ASSIGNABLE_ROLES } from './_shared'

export function UsersTab({
  users,
  customRoles,
  currentUserRole,
  currentUserEmail,
  onUpdateRole,
  onEditPermissions,
  onUserControl,
  onViewActivity,
  onResetPassword,
  onPreview,
  openMenuId,
  setOpenMenuId,
}) {
  const { t } = useTranslation()
  const isSuperAdmin = currentUserRole === ROLES.SUPER_ADMIN
  // Admin + super_admin can manage permissions (consistent with admin bypass; the
  // whole page is already admin-only). Was hardcoded super_admin-only before (UM-5).
  const canManagePermissions =
    currentUserRole === ROLES.ADMIN || currentUserRole === ROLES.SUPER_ADMIN
  // An empty {} is not a real override — only treat a non-empty object as "Custom" (UM-4)
  const hasCustomPerms = (u) =>
    !!u.permissions && typeof u.permissions === 'object' && Object.keys(u.permissions).length > 0
  // Built-ins plus whatever custom roles exist. This was the seven built-ins
  // only, so a custom role could be created in the Custom Roles tab and then
  // never assigned to anybody — the dropdown simply did not offer it, and
  // chk_user_role would have rejected the value even if it had.
  const roleOptions = [
    ...ASSIGNABLE_ROLES.filter((r) => !r.superAdminOnly || isSuperAdmin),
    ...(customRoles || []).map((r) => ({ value: r.role_name, label: `🎛️ ${r.role_name}` })),
  ]
  // FT-09: only non-admin targets can be previewed — previewing an admin/super_admin
  // would let the acting admin grant themselves elevated UI access, defeating the point.
  const canPreview = (u) =>
    u.user_email !== currentUserEmail && u.role !== ROLES.ADMIN && u.role !== ROLES.SUPER_ADMIN
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              {t('userManagement.colUser')}
            </th>
            <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              {t('userManagement.colStatus')}
            </th>
            <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              {t('userManagement.colRole')}
            </th>
            <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              {t('userManagement.colChangeRole')}
            </th>
            <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              {t('userManagement.colPermissions')}
            </th>
            <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              {t('userManagement.colActions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-gray-50">
              <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-semibold">
                    {user.user_email.charAt(0).toUpperCase()}
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-900">{user.user_email}</p>
                    {user.last_login && (
                      <p className="text-xs text-gray-500">
                        {t('userManagement.lastLoginDate', { date: new Date(user.last_login).toLocaleDateString() })}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                <StatusBadge status={user.status || 'active'} />
              </td>
              <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                <RoleBadge role={user.role} />
              </td>
              <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                {user.user_email === currentUserEmail ? (
                  <span className="text-sm text-gray-500 italic">{t('userManagement.currentUser')}</span>
                ) : (
                  <select
                    value={user.role}
                    onChange={(e) => onUpdateRole(user.user_email, e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent text-sm"
                  >
                    {roleOptions.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                {canManagePermissions ? (
                  <button
                    onClick={() => onEditPermissions(user)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors hover:bg-indigo-50 hover:border-indigo-300 hover:text-indigo-700 border-gray-200 text-gray-600"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                    {hasCustomPerms(user) ? t('userManagement.custom') : t('userManagement.roleDefault')}
                  </button>
                ) : (
                  <span className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-500">
                    {hasCustomPerms(user) ? t('userManagement.custom') : t('userManagement.roleDefault')}
                  </span>
                )}
              </td>
              <td className="px-3 sm:px-6 py-4 relative action-menu">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setOpenMenuId(openMenuId === user.id ? null : user.id)
                  }}
                  className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="5" r="1.5" />
                    <circle cx="12" cy="12" r="1.5" />
                    <circle cx="12" cy="19" r="1.5" />
                  </svg>
                </button>
                {openMenuId === user.id && (
                  <div className="absolute right-0 top-9 z-30 w-40 sm:w-48 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                    <button
                      onClick={() => {
                        onUserControl(user)
                        setOpenMenuId(null)
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                    >
                      <svg
                        className="w-4 h-4 text-gray-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                      {t('userManagement.controls')}
                    </button>
                    <button
                      onClick={() => {
                        onResetPassword(user)
                        setOpenMenuId(null)
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                    >
                      <svg
                        className="w-4 h-4 text-gray-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                        />
                      </svg>
                      {t('userManagement.resetPassword')}
                    </button>
                    <button
                      onClick={() => {
                        onViewActivity(user)
                        setOpenMenuId(null)
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                    >
                      <svg
                        className="w-4 h-4 text-gray-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                        />
                      </svg>
                      {t('accountSettings.recentActivity')}
                    </button>
                    {canPreview(user) && (
                      <button
                        onClick={() => {
                          onPreview(user)
                          setOpenMenuId(null)
                        }}
                        className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                      >
                        <svg
                          className="w-4 h-4 text-gray-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                          />
                        </svg>
                        {t('userManagement.previewAsUser')}
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AddUserModal({
  email,
  password,
  role,
  onEmailChange,
  onPasswordChange,
  onRoleChange,
  onSubmit,
  onClose,
}) {
  const { t } = useTranslation()
  const [showPassword, setShowPassword] = useState(false)

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*'
    let pass = ''
    for (let i = 0; i < 12; i++) {
      pass += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    onPasswordChange(pass)
    setShowPassword(true)
    toast.success(t('userManagement.passwordGeneratedCopy'))
  }

  return (
    <Modal open={true} onClose={onClose} title={t('userManagement.inviteUser')} className="max-w-md" hideHeader>
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">{t('userManagement.inviteUser')}</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('common.email')} *</label>
          <input
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            placeholder="user@example.com"
            required
          />
          {/* A suggestion only. Inviting a colleague is the wrong moment to
              refuse an unfamiliar domain, and an undeliverable address is a
              problem the invitation itself will surface. */}
          <EmailNote
            result={checkEmail(email)}
            onAccept={(domain) => onEmailChange(`${String(email).split('@')[0]}@${domain}`)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('accountSettings.newPassword')} *</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent pr-10"
              placeholder="Min 6 characters"
              required
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500"
            >
              {showPassword ? '🙈' : '👁️'}
            </button>
          </div>
          <button
            type="button"
            onClick={generatePassword}
            className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
          >
            {t('userManagement.generateStrongPassword')}
          </button>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.colRole')} *</label>
          <select
            value={role}
            onChange={(e) => onRoleChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
          >
            {ASSIGNABLE_ROLES.filter((r) => !r.superAdminOnly).map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            {t('common.create')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PasswordResetModal({ user, isSuperAdmin, password, onPasswordChange, onSubmit, onClose }) {
  const { t } = useTranslation()
  const [showPassword, setShowPassword] = useState(false)

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*'
    let pass = ''
    for (let i = 0; i < 12; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length))
    onPasswordChange(pass)
    setShowPassword(true)
    toast.success(t('userManagement.passwordGeneratedClose'))
  }

  return (
    <Modal open={true} onClose={onClose} title={t('userManagement.resetPasswordTitle')} className="max-w-md" hideHeader>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">{t('userManagement.resetPasswordTitle')}</h2>
      <p className="text-sm text-gray-500 mb-4">
        {t('userManagement.userForLabel')} <strong className="text-gray-800">{user.user_email}</strong>
      </p>

      {isSuperAdmin ? (
        /* Super-admin: set password directly via Edge Function */
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('userManagement.newPasswordLabel')}</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent pr-10 text-sm"
                placeholder={t('userManagement.minSixChars')}
                minLength={6}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
              >
                {showPassword ? '🙈' : '👁️'}
              </button>
            </div>
            <button
              type="button"
              onClick={generatePassword}
              className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
            >
              {t('userManagement.generateStrongPassword')}
            </button>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-sm text-yellow-800">
              {t('userManagement.immediateLoginWarning')}
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={onSubmit}
              disabled={password.length < 6}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {t('userManagement.setPasswordBtn')}
            </button>
          </div>
        </div>
      ) : (
        /* Admin: send a reset email link */
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              {t('userManagement.resetEmailInfo')}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={onSubmit}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
            >
              {t('userManagement.sendResetEmailBtn')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function UserControlModal({
  user,
  action,
  reason,
  notes,
  expiration,
  onActionChange,
  onReasonChange,
  onNotesChange,
  onExpirationChange,
  onSubmit,
  onClose,
}) {
  const { t } = useTranslation()
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('userManagement.userControlsTitle', { email: user.user_email })}
      className="max-w-2xl"
      hideHeader
    >
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        {t('userManagement.userControlsTitle', { email: user.user_email })}
      </h2>

      <div className="space-y-4">
        <div className="bg-gray-50 p-4 rounded-lg">
          <p className="text-sm text-gray-600 mb-2">{t('userManagement.currentStatusLabel')}</p>
          <StatusBadge status={user.status || 'active'} />
          {user.suspended_reason && (
            <div className="mt-2 text-sm text-gray-600">
              <p>
                <strong>{t('userManagement.suspendedReasonLabel')}</strong> {user.suspended_reason}
              </p>
              <p>
                <strong>{t('userManagement.suspendedByLabel')}</strong> {user.suspended_by}
              </p>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.actionLabel')}</label>
          <select aria-label={t('userManagement.actionLabel')}
            value={action}
            onChange={(e) => onActionChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
          >
            <option value="">{t('userManagement.selectAction')}</option>
            <option value="activate">{t('userManagement.actionActivate')}</option>
            <option value="suspend">{t('userManagement.actionSuspend')}</option>
            <option value="lock">{t('userManagement.actionLock')}</option>
            <option value="deactivate">{t('userManagement.actionDeactivate')}</option>
            <option value="update_notes">{t('userManagement.actionUpdateNotes')}</option>
            <option value="set_expiration">{t('userManagement.actionSetExpiration')}</option>
            <option value="delete">{t('userManagement.actionDeletePermanent')}</option>
          </select>
        </div>

        {(action === 'suspend' || action === 'lock' || action === 'deactivate') && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.reasonLabel')}</label>
            <textarea aria-label={t('userManagement.reasonLabel')}
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
              rows="3"
              placeholder={t('userManagement.reasonPlaceholder')}
              required
            />
          </div>
        )}

        {action === 'update_notes' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.notesLabel')}</label>
            <textarea aria-label={t('userManagement.notesLabel')}
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
              rows="4"
              placeholder={t('userManagement.notesPlaceholder')}
            />
          </div>
        )}

        {action === 'set_expiration' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">{t('userManagement.expirationLabel')}</label>
            <input aria-label={t('userManagement.expirationLabel')}
              type="datetime-local"
              value={expiration}
              onChange={(e) => onExpirationChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            />
            <p className="text-xs text-gray-500 mt-1">{t('userManagement.expirationHint')}</p>
          </div>
        )}

        {action === 'delete' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-medium">{t('userManagement.deleteWarningTitle')}</p>
            <p className="text-sm text-red-600 mt-1">
              {t('userManagement.deleteWarningBody')}
            </p>
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-6 border-t mt-6">
        <button
          onClick={onClose}
          className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={onSubmit}
          disabled={!action}
          className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t('userManagement.executeActionBtn')}
        </button>
      </div>
    </Modal>
  )
}

export function ActivityModal({ user, activity, onClose }) {
  const { t } = useTranslation()
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={t('userManagement.activityLogTitle', { email: user.user_email })}
      className="max-w-3xl"
      hideHeader
    >
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        {t('userManagement.activityLogTitle', { email: user.user_email })}
      </h2>

      {activity.length === 0 ? (
        <div className="text-center py-12 text-gray-500">{t('userManagement.noActivityRecorded')}</div>
      ) : (
        <div className="space-y-3">
          {activity.map((log) => (
            <div key={log.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-gray-900">{log.action_type}</p>
                  {log.action_details && (
                    <p className="text-sm text-gray-600 mt-1">
                      {JSON.stringify(log.action_details)}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-2">
                    {new Date(log.created_date).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end pt-6 border-t mt-6">
        <button
          onClick={onClose}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          {t('common.close')}
        </button>
      </div>
    </Modal>
  )
}
