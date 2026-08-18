import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, auth } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Spinner } from '../../components/ui'
import { useURLTab } from '../../hooks/useURLTab'
import { ROLES } from '../../lib/constants'
import { canDo } from '../../lib/permissions'
import { captureException } from '../../lib/sentry'
import { addUserSchema, getFirstError } from '../../lib/schemas'
import { validatePasswordStrength, getDefaultPermissions } from './_utils'
import { UsersTab, AddUserModal, PasswordResetModal, UserControlModal, ActivityModal } from './UsersTab'
import { RoleTemplatesTab, CustomRolesTab, CreateRoleModal, PermissionsModal } from './RolesTab'

// Custom Roles were hidden because they were not wired end-to-end: "not
// assignable in the role dropdown, not loaded by getUserRole, not enforced by
// canDo" (UM-3). All three now hold:
//
//   assignable   UsersTab merges custom_roles into the role dropdown, and
//                user_roles.role accepts them (trigger, migration 20260782)
//   loaded       roleDefaults() supplies the role's permission map at session
//                load, in preview-as-user, and in the permission editor
//   enforced     canDo reads that map; RLS resolves the role to its base_role
//                via rma_user_role(), so the server ceiling is the base role's
//
// The flag stays as a named constant rather than being deleted, so turning the
// feature off again is one line if the base-role model turns out to be wrong.
const ENABLE_CUSTOM_ROLES = true

export default function UserManagement({ currentUserRole, currentUserEmail, currentUserPermissions, onPreviewUser }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useURLTab('umtab', 'users')
  const queryClient = useQueryClient()
  const { data: umData, isLoading: loading } = useQuery({
    queryKey: ['user-management'],
    queryFn: async () => {
      const [usersData, rolesData] = await Promise.all([
        db.userRoles.listAllRoles(),
        db.userRoles.getCustomRoles(),
      ])
      return { usersData, rolesData }
    },
  })
  const users = umData?.usersData ?? []
  const customRoles = umData?.rolesData ?? []
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    message: '',
    onConfirm: null,
  })
  const openConfirm = (title, message, onConfirm) =>
    setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog((d) => ({ ...d, open: false }))

  const [showAddUserModal, setShowAddUserModal] = useState(false)
  const [showCreateRoleModal, setShowCreateRoleModal] = useState(false)
  const [showPermissionsModal, setShowPermissionsModal] = useState(false)
  const [showUserControlModal, setShowUserControlModal] = useState(false)
  const [showActivityModal, setShowActivityModal] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)
  const [selectedUser, setSelectedUser] = useState(null)
  const [userActivity, setUserActivity] = useState([])

  const [newUserEmail, setNewUserEmail] = useState('')
  const [newUserRole, setNewUserRole] = useState('technician')
  const [newUserPassword, setNewUserPassword] = useState('')

  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleDescription, setNewRoleDescription] = useState('')
  const [newRoleBase, setNewRoleBase] = useState('viewer')
  const [newRolePermissions, setNewRolePermissions] = useState(getDefaultPermissions())

  const [controlAction, setControlAction] = useState('')
  const [controlReason, setControlReason] = useState('')
  const [controlNotes, setControlNotes] = useState('')
  const [controlExpiration, setControlExpiration] = useState('')

  const [resetPassword, setResetPassword] = useState('')

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['user-management'] })

  const handleAddUser = async (e) => {
    e.preventDefault()

    if (!newUserPassword) {
      toast.error(t('userManagement.passwordRequired'))
      return
    }

    const emailRoleValidation = addUserSchema.safeParse({ email: newUserEmail, role: newUserRole })
    if (!emailRoleValidation.success) {
      toast.error(getFirstError(emailRoleValidation))
      return
    }

    const pwError = validatePasswordStrength(newUserPassword)
    if (pwError) {
      toast.error(pwError)
      return
    }

    try {
      // Create the Supabase Auth account first (requires service-role key)
      await auth.adminCreateUser(newUserEmail, newUserPassword)
      // Then record the role in user_roles
      await db.userRoles.createRole(newUserEmail, newUserRole)
      db.userActivity
        .create(
          currentUserEmail,
          'user_created',
          `Created user ${newUserEmail} with role ${newUserRole}`
        )
        .catch(() => {})
      db.notifications
        .create({
          type: 'user_created',
          title: 'New User Added',
          message: `${newUserEmail} was added with role: ${newUserRole}`,
          entityType: 'user',
          createdBy: currentUserEmail,
          targetRoles: ['super_admin'],
          targetEmails: [],
        })
        .catch(() => {})
      toast.success(t('userManagement.userCreatedToast', { email: newUserEmail }))
      db.auditLog
        .log(
          currentUserEmail,
          'user_created',
          `Created user ${newUserEmail} with role ${newUserRole}`
        )
        .catch(() => {})
      setNewUserEmail('')
      setNewUserRole('technician')
      setNewUserPassword('')
      setShowAddUserModal(false)
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error(error.message || t('userManagement.addUserFailed'))
    }
  }

  const handleUpdateRole = (email, newRole) => {
    // Demotion is the other way to reach zero admins. The dropdown is already
    // hidden on your own row, so this covers demoting somebody else who happens
    // to be the last one active.
    const target = (users || []).find((u) => u.user_email === email)
    if (
      target?.role === ROLES.SUPER_ADMIN &&
      newRole !== ROLES.SUPER_ADMIN &&
      activeSuperAdmins.length <= 1 &&
      activeSuperAdmins.some((u) => u.user_email === email)
    ) {
      toast.error(t('userManagement.cannotRemoveLastSuperAdmin'))
      return
    }
    openConfirm(
      t('userManagement.changeRoleTitle'),
      t('userManagement.changeRoleMsg', { email, role: newRole }),
      async () => {
        closeConfirm()
        try {
          await db.userRoles.updateRole(email, newRole)
          db.userActivity
            .create(currentUserEmail, 'user_role_changed', `Changed role of ${email} to ${newRole}`)
            .catch(() => {})
          db.notifications
            .create({
              type: 'user_role_changed',
              title: 'Role Updated',
              message: `${email}'s role was changed to ${newRole}`,
              entityType: 'user',
              createdBy: currentUserEmail,
              targetRoles: ['super_admin'],
              targetEmails: [email],
            })
            .catch(() => {})
          toast.success(t('userManagement.roleUpdatedToast', { role: newRole }))
          db.auditLog
            .log(currentUserEmail, 'user_role_changed', `Changed role of ${email} to ${newRole} (custom permissions reset)`)
            .catch(() => {})
          invalidate()
        } catch (error) {
          captureException(error)
          toast.error(t('userManagement.roleUpdateFailed'))
        }
      }
    )
  }

  const handleCreateCustomRole = async (e) => {
    e.preventDefault()
    try {
      await db.userRoles.createCustomRole(
        newRoleName,
        newRoleDescription,
        newRolePermissions,
        currentUserEmail,
        newRoleBase
      )
      toast.success(t('userManagement.customRoleCreatedToast'))
      db.auditLog
        .log(currentUserEmail, 'custom_role_created', `Created custom role ${newRoleName}`)
        .catch(() => {})
      setNewRoleName('')
      setNewRoleDescription('')
      setNewRolePermissions(getDefaultPermissions())
      setShowCreateRoleModal(false)
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error(t('userManagement.customRoleCreateFailed'))
    }
  }

  const handleEditPermissions = (user) => {
    setSelectedUser(user)
    setShowPermissionsModal(true)
  }

  const handleSavePermissions = async (permissions) => {
    try {
      await db.userRoles.updateUserPermissions(selectedUser.user_email, permissions)
      toast.success(t('userManagement.permissionsUpdatedToast'))
      db.auditLog
        .log(currentUserEmail, 'user_permissions_changed', `Updated permissions for ${selectedUser.user_email}`)
        .catch(() => {})
      setShowPermissionsModal(false)
      setSelectedUser(null)
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error(t('userManagement.permissionsUpdateFailed'))
      throw error
    }
  }

  const handleDeleteCustomRole = (roleId) => {
    openConfirm(
      t('userManagement.deleteCustomRoleTitle'),
      t('userManagement.deleteCustomRoleMsg'),
      async () => {
        closeConfirm()
        try {
          await db.userRoles.deleteCustomRole(roleId)
          toast.success(t('userManagement.customRoleDeletedToast'))
          db.auditLog
            .log(currentUserEmail, 'custom_role_deleted', `Deleted custom role ${roleId}`)
            .catch(() => {})
          invalidate()
        } catch (error) {
          captureException(error)
          toast.error(t('userManagement.customRoleDeleteFailed'))
        }
      }
    )
  }

  const handleOpenUserControl = (user) => {
    setSelectedUser(user)
    setControlAction('')
    setControlReason('')
    setControlNotes(user.notes || '')
    setControlExpiration(user.expiration_date || '')
    setShowUserControlModal(true)
  }

  /**
   * Actions that can end someone's access. Applied to yourself, any of them
   * locks you out of the app; applied to the last active super_admin, they lock
   * everyone out, because rma_user_role() then resolves to NULL and every
   * policy closes. Neither had a guard: the role dropdown is hidden on your own
   * row, but Controls was not, so Suspend, Lock, Deactivate, Set Expiration and
   * Delete were all reachable against yourself.
   *
   * 'activate' and 'update_notes' are absent on purpose — neither removes
   * access, and locking an admin out of their own notes would be silly.
   */
  const LOCKOUT_ACTIONS = ['suspend', 'lock', 'deactivate', 'set_expiration', 'delete']

  const activeSuperAdmins = (users || []).filter(
    (u) => u.role === ROLES.SUPER_ADMIN && u.status === 'active'
  )

  const handleUserControlAction = async () => {
    if (!controlAction) {
      toast.error(t('userManagement.pleaseSelectAction'))
      return
    }

    if (LOCKOUT_ACTIONS.includes(controlAction)) {
      if (selectedUser?.user_email === currentUserEmail) {
        toast.error(t('userManagement.cannotLockOutSelf'))
        return
      }
      // The last one standing. Checked against active super admins rather than
      // all of them, because a suspended admin cannot sign in to undo this.
      const isLastSuperAdmin =
        selectedUser?.role === ROLES.SUPER_ADMIN &&
        activeSuperAdmins.length <= 1 &&
        activeSuperAdmins.some((u) => u.user_email === selectedUser.user_email)
      if (isLastSuperAdmin) {
        toast.error(t('userManagement.cannotRemoveLastSuperAdmin'))
        return
      }
    }

    try {
      switch (controlAction) {
        case 'suspend':
          if (!controlReason) {
            toast.error(t('userManagement.pleaseProvideReason'))
            return
          }
          await db.userRoles.updateUserStatus(
            selectedUser.user_email,
            'suspended',
            controlReason,
            currentUserEmail
          )
          db.userActivity
            .create(
              currentUserEmail,
              'user_suspended',
              `Suspended ${selectedUser.user_email}: ${controlReason}`
            )
            .catch(() => {})
          db.notifications
            .create({
              type: 'user_suspended',
              title: 'Account Suspended',
              message: `Your account was suspended. Reason: ${controlReason}`,
              entityType: 'user',
              createdBy: currentUserEmail,
              targetRoles: ['super_admin'],
              targetEmails: [selectedUser.user_email],
            })
            .catch(() => {})
          toast.success(t('userManagement.userSuspendedToast'))
          db.auditLog
            .log(
              currentUserEmail,
              'user_suspended',
              `Suspended ${selectedUser.user_email}: ${controlReason}`
            )
            .catch(() => {})
          break

        case 'activate':
          await db.userRoles.updateUserStatus(selectedUser.user_email, 'active', null, null)
          db.userActivity
            .create(currentUserEmail, 'user_activated', `Activated ${selectedUser.user_email}`)
            .catch(() => {})
          db.notifications
            .create({
              type: 'user_activated',
              title: 'Account Activated',
              message: `Your account has been reactivated`,
              entityType: 'user',
              createdBy: currentUserEmail,
              targetRoles: ['super_admin'],
              targetEmails: [selectedUser.user_email],
            })
            .catch(() => {})
          toast.success(t('userManagement.userActivatedToast'))
          db.auditLog
            .log(currentUserEmail, 'user_activated', `Activated ${selectedUser.user_email}`)
            .catch(() => {})
          break

        case 'lock':
          await db.userRoles.updateUserStatus(
            selectedUser.user_email,
            'locked',
            controlReason,
            currentUserEmail
          )
          db.userActivity
            .create(
              currentUserEmail,
              'user_locked',
              `Locked ${selectedUser.user_email}${controlReason ? `: ${controlReason}` : ''}`
            )
            .catch(() => {})
          toast.success(t('userManagement.userLockedToast'))
          break

        case 'deactivate':
          await db.userRoles.updateUserStatus(
            selectedUser.user_email,
            'deactivated',
            controlReason,
            currentUserEmail
          )
          db.userActivity
            .create(currentUserEmail, 'user_deactivated', `Deactivated ${selectedUser.user_email}`)
            .catch(() => {})
          toast.success(t('userManagement.userDeactivatedToast'))
          break

        case 'update_notes':
          await db.userRoles.updateUserNotes(selectedUser.user_email, controlNotes)
          toast.success(t('userManagement.notesUpdatedToast'))
          break

        case 'set_expiration':
          if (!controlExpiration) {
            toast.error(t('userManagement.pleaseSetExpiration'))
            return
          }
          await db.userRoles.setUserExpiration(selectedUser.user_email, controlExpiration)
          toast.success(t('userManagement.expirationSetToast'))
          break

        case 'delete':
          openConfirm(
            t('userManagement.deleteUserTitle'),
            t('userManagement.deleteUserMsg', { email: selectedUser.user_email }),
            async () => {
              closeConfirm()
              try {
                const deletedEmail = selectedUser.user_email
                await db.userRoles.deleteUser(deletedEmail)
                db.userActivity
                  .create(currentUserEmail, 'user_deleted', `Deleted user ${deletedEmail}`)
                  .catch(() => {})
                db.notifications
                  .create({
                    type: 'user_deleted',
                    title: 'User Deleted',
                    message: `${deletedEmail} was removed from the system`,
                    entityType: 'user',
                    createdBy: currentUserEmail,
                    targetRoles: ['super_admin'],
                    targetEmails: [],
                  })
                  .catch(() => {})
                toast.success(t('userManagement.userDeletedToast'))
                db.auditLog
                  .log(currentUserEmail, 'user_deleted', `Deleted user ${deletedEmail}`)
                  .catch(() => {})
                setShowUserControlModal(false)
                setSelectedUser(null)
                invalidate()
              } catch {
                toast.error(t('userManagement.userDeleteFailed'))
              }
            }
          )
          return

        default:
          break
      }

      setShowUserControlModal(false)
      setSelectedUser(null)
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error(t('userManagement.actionFailed'))
    }
  }

  const handleViewActivity = async (user) => {
    setSelectedUser(user)
    try {
      const activity = await db.userActivity.list(user.user_email)
      setUserActivity(activity)
      setShowActivityModal(true)
    } catch (error) {
      captureException(error)
      toast.error(t('userManagement.activityLoadFailed'))
    }
  }

  const handleOpenPasswordReset = (user) => {
    setSelectedUser(user)
    setResetPassword('')
    setShowPasswordModal(true)
  }

  const handleResetPassword = async () => {
    try {
      if (currentUserRole === ROLES.SUPER_ADMIN) {
        // Direct password set via Edge Function (super_admin only)
        if (resetPassword.length < 6) {
          toast.error(t('userManagement.passwordMinLength'))
          return
        }
        await auth.adminSetPassword(selectedUser.user_email, resetPassword)
        toast.success(t('userManagement.passwordUpdatedToast', { email: selectedUser.user_email }))
        db.auditLog
          .log(
            currentUserEmail,
            'user_password_reset',
            `Directly reset password for ${selectedUser.user_email}`
          )
          .catch(() => {})
      } else {
        // Admin: send a reset email link instead
        await auth.resetPassword(selectedUser.user_email)
        toast.success(t('userManagement.resetEmailSentToast', { email: selectedUser.user_email }))
        db.auditLog
          .log(
            currentUserEmail,
            'user_password_reset',
            `Sent password reset email to ${selectedUser.user_email}`
          )
          .catch(() => {})
      }
      setShowPasswordModal(false)
      setSelectedUser(null)
      setResetPassword('')
    } catch (error) {
      captureException(error)
      toast.error(t('userManagement.passwordResetFailed') + (error?.message ? ': ' + error.message : ''))
    }
  }

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="text-center py-12">
        <svg
          className="w-16 h-16 text-red-600 mx-auto mb-4"
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
        <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('userManagement.accessDeniedTitle')}</h2>
        <p className="text-gray-600">{t('userManagement.accessDeniedMessage')}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('userManagement.title')}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t('userManagement.subtitle')}</p>
        </div>
        {canDo(currentUserRole, currentUserPermissions, 'user_management', 'create_users') && (
          <button
            onClick={() => setShowAddUserModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {t('userManagement.inviteUser')}
          </button>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex gap-8 px-6">
            <button
              onClick={() => setActiveTab('users')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'users'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700')
              }
            >
              {t('userManagement.tabUsers')}
            </button>
            <button
              onClick={() => setActiveTab('roles')}
              className={
                'py-4 border-b-2 font-medium transition-colors ' +
                (activeTab === 'roles'
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700')
              }
            >
              {t('userManagement.tabRoles')}
            </button>
            {ENABLE_CUSTOM_ROLES && (
              <button
                onClick={() => setActiveTab('custom')}
                className={
                  'py-4 border-b-2 font-medium transition-colors ' +
                  (activeTab === 'custom'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700')
                }
              >
                {t('userManagement.customRolesCount')}
              </button>
            )}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'users' && (
            <UsersTab
              users={users}
              customRoles={customRoles}
              currentUserRole={currentUserRole}
              currentUserEmail={currentUserEmail}
              onUpdateRole={handleUpdateRole}
              onEditPermissions={handleEditPermissions}
              onUserControl={handleOpenUserControl}
              onViewActivity={handleViewActivity}
              onResetPassword={handleOpenPasswordReset}
              onPreview={onPreviewUser}
              openMenuId={openMenuId}
              setOpenMenuId={setOpenMenuId}
            />
          )}

          {activeTab === 'roles' && <RoleTemplatesTab />}

          {ENABLE_CUSTOM_ROLES && activeTab === 'custom' && (
            <CustomRolesTab
              customRoles={customRoles}
              onCreateRole={() => setShowCreateRoleModal(true)}
              onDeleteRole={handleDeleteCustomRole}
            />
          )}
        </div>
      </div>

      {showAddUserModal && (
        <AddUserModal
          email={newUserEmail}
          password={newUserPassword}
          role={newUserRole}
          onEmailChange={setNewUserEmail}
          onPasswordChange={setNewUserPassword}
          onRoleChange={setNewUserRole}
          onSubmit={handleAddUser}
          onClose={() => {
            setShowAddUserModal(false)
            setNewUserEmail('')
            setNewUserPassword('')
            setNewUserRole('technician')
          }}
        />
      )}

      {showCreateRoleModal && (
        <CreateRoleModal
          baseRole={newRoleBase}
          onBaseRoleChange={setNewRoleBase}
          roleName={newRoleName}
          roleDescription={newRoleDescription}
          permissions={newRolePermissions}
          onRoleNameChange={setNewRoleName}
          onRoleDescriptionChange={setNewRoleDescription}
          onPermissionsChange={setNewRolePermissions}
          onSubmit={handleCreateCustomRole}
          onClose={() => setShowCreateRoleModal(false)}
        />
      )}

      {showPermissionsModal && selectedUser && (
        <PermissionsModal
          customRoles={customRoles}
          user={selectedUser}
          onSave={handleSavePermissions}
          onClose={() => {
            setShowPermissionsModal(false)
            setSelectedUser(null)
          }}
        />
      )}

      {showUserControlModal && selectedUser && (
        <UserControlModal
          user={selectedUser}
          action={controlAction}
          reason={controlReason}
          notes={controlNotes}
          expiration={controlExpiration}
          onActionChange={setControlAction}
          onReasonChange={setControlReason}
          onNotesChange={setControlNotes}
          onExpirationChange={setControlExpiration}
          onSubmit={handleUserControlAction}
          onClose={() => {
            setShowUserControlModal(false)
            setSelectedUser(null)
          }}
        />
      )}

      {showActivityModal && selectedUser && (
        <ActivityModal
          user={selectedUser}
          activity={userActivity}
          onClose={() => {
            setShowActivityModal(false)
            setSelectedUser(null)
            setUserActivity([])
          }}
        />
      )}

      {showPasswordModal && selectedUser && (
        <PasswordResetModal
          user={selectedUser}
          isSuperAdmin={currentUserRole === ROLES.SUPER_ADMIN}
          password={resetPassword}
          onPasswordChange={setResetPassword}
          onSubmit={handleResetPassword}
          onClose={() => {
            setShowPasswordModal(false)
            setSelectedUser(null)
            setResetPassword('')
          }}
        />
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        onConfirm={confirmDialog.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  )
}
