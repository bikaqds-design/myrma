import React, { useState } from 'react'
import toast from 'react-hot-toast'
import Modal from '../../components/Modal'
import { ROLES } from '../../lib/constants'
import { StatusBadge, RoleBadge } from './_shared'

export function UsersTab({
  users,
  currentUserRole,
  currentUserEmail,
  onUpdateRole,
  onEditPermissions,
  onUserControl,
  onViewActivity,
  onResetPassword,
  openMenuId,
  setOpenMenuId,
}) {
  const isSuperAdmin = currentUserRole === ROLES.SUPER_ADMIN
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              User
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Role
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Change Role
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Permissions
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-gray-50">
              <td className="px-6 py-4 whitespace-nowrap">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-semibold">
                    {user.user_email.charAt(0).toUpperCase()}
                  </div>
                  <div className="ml-3">
                    <p className="text-sm font-medium text-gray-900">{user.user_email}</p>
                    {user.last_login && (
                      <p className="text-xs text-gray-500">
                        Last login: {new Date(user.last_login).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <StatusBadge status={user.status || 'active'} />
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <RoleBadge role={user.role} />
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                {user.user_email === currentUserEmail ? (
                  <span className="text-sm text-gray-500 italic">current user</span>
                ) : (
                  <select
                    value={user.role}
                    onChange={(e) => onUpdateRole(user.user_email, e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent text-sm"
                  >
                    {isSuperAdmin && <option value="super_admin">Super Admin</option>}
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="technician">Technician</option>
                    <option value="viewer">Viewer</option>
                  </select>
                )}
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                {isSuperAdmin ? (
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
                    {user.permissions ? 'Custom' : 'Role Default'}
                  </button>
                ) : (
                  <span className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-500">
                    {user.permissions ? 'Custom' : 'Role Default'}
                  </span>
                )}
              </td>
              <td className="px-6 py-4 relative action-menu">
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
                  <div className="absolute right-0 top-9 z-30 w-48 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
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
                      Controls
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
                      Reset Password
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
                      Activity
                    </button>
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
  const [showPassword, setShowPassword] = useState(false)

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*'
    let pass = ''
    for (let i = 0; i < 12; i++) {
      pass += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    onPasswordChange(pass)
    setShowPassword(true)
    toast.success('Password generated! Make sure to copy it!')
  }

  return (
    <Modal open={true} onClose={onClose} title="Add New User" className="max-w-md" hideHeader>
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Add New User</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Email *</label>
          <input
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            placeholder="user@example.com"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Password *</label>
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
            🎲 Generate Strong Password
          </button>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Role *</label>
          <select
            value={role}
            onChange={(e) => onRoleChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
          >
            <option value="technician">🔧 Technician</option>
            <option value="manager">👔 Manager</option>
            <option value="admin">👑 Admin</option>
            <option value="viewer">👁️ Viewer</option>
          </select>
        </div>

        <div className="flex gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            Create User
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PasswordResetModal({ user, isSuperAdmin, password, onPasswordChange, onSubmit, onClose }) {
  const [showPassword, setShowPassword] = useState(false)

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*'
    let pass = ''
    for (let i = 0; i < 12; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length))
    onPasswordChange(pass)
    setShowPassword(true)
    toast.success('Password generated! Copy it before closing.')
  }

  return (
    <Modal open={true} onClose={onClose} title="Reset Password" className="max-w-md" hideHeader>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Reset Password</h2>
      <p className="text-sm text-gray-500 mb-4">
        User: <strong className="text-gray-800">{user.user_email}</strong>
      </p>

      {isSuperAdmin ? (
        /* Super-admin: set password directly via Edge Function */
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent pr-10 text-sm"
                placeholder="Min 6 characters"
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
              🎲 Generate Strong Password
            </button>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-sm text-yellow-800">
              ⚠️ The user will be able to log in immediately with this new password.
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={password.length < 6}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              Set Password
            </button>
          </div>
        </div>
      ) : (
        /* Admin: send a reset email link */
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
            <p className="text-sm text-blue-800">
              A password reset link will be emailed to the user. The link expires after 1 hour.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
            >
              Send Reset Email
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
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`User Controls: ${user.user_email}`}
      className="max-w-2xl"
      hideHeader
    >
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        User Controls: {user.user_email}
      </h2>

      <div className="space-y-4">
        <div className="bg-gray-50 p-4 rounded-lg">
          <p className="text-sm text-gray-600 mb-2">Current Status:</p>
          <StatusBadge status={user.status || 'active'} />
          {user.suspended_reason && (
            <div className="mt-2 text-sm text-gray-600">
              <p>
                <strong>Reason:</strong> {user.suspended_reason}
              </p>
              <p>
                <strong>Suspended by:</strong> {user.suspended_by}
              </p>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Action</label>
          <select
            value={action}
            onChange={(e) => onActionChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
          >
            <option value="">Select action...</option>
            <option value="activate">✅ Activate User</option>
            <option value="suspend">⏸️ Suspend User</option>
            <option value="lock">🔒 Lock Account</option>
            <option value="deactivate">❌ Deactivate User</option>
            <option value="update_notes">📝 Update Notes</option>
            <option value="set_expiration">⏳ Set Expiration Date</option>
            <option value="delete">🗑️ Delete User (Permanent)</option>
          </select>
        </div>

        {(action === 'suspend' || action === 'lock' || action === 'deactivate') && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Reason *</label>
            <textarea
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
              rows="3"
              placeholder="Provide a reason for this action..."
              required
            />
          </div>
        )}

        {action === 'update_notes' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
              rows="4"
              placeholder="Add notes about this user..."
            />
          </div>
        )}

        {action === 'set_expiration' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Expiration Date</label>
            <input
              type="datetime-local"
              value={expiration}
              onChange={(e) => onExpirationChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
            />
            <p className="text-xs text-gray-500 mt-1">User access will expire on this date</p>
          </div>
        )}

        {action === 'delete' && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800 font-medium">⚠️ Warning: This action cannot be undone!</p>
            <p className="text-sm text-red-600 mt-1">
              All user data and permissions will be permanently deleted.
            </p>
          </div>
        )}
      </div>

      <div className="flex gap-3 pt-6 border-t mt-6">
        <button
          onClick={onClose}
          className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!action}
          className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Execute Action
        </button>
      </div>
    </Modal>
  )
}

export function ActivityModal({ user, activity, onClose }) {
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Activity Log: ${user.user_email}`}
      className="max-w-3xl"
      hideHeader
    >
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        Activity Log: {user.user_email}
      </h2>

      {activity.length === 0 ? (
        <div className="text-center py-12 text-gray-500">No activity recorded yet</div>
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
          Close
        </button>
      </div>
    </Modal>
  )
}
