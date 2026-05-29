import React, { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, auth } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Spinner } from '../../components/ui'
import { useURLTab } from '../../hooks/useURLTab'
import { ROLES } from '../../lib/constants'
import { captureException } from '../../lib/sentry'
import { validatePasswordStrength, getDefaultPermissions } from './_utils'
import { UsersTab, AddUserModal, PasswordResetModal, UserControlModal, ActivityModal } from './UsersTab'
import { RoleTemplatesTab, CustomRolesTab, CreateRoleModal, PermissionsModal } from './RolesTab'

// Custom Roles are not yet wired end-to-end (not assignable in the role dropdown,
// not loaded by getUserRole, not enforced by canDo). Hidden until fully supported (UM-3).
const ENABLE_CUSTOM_ROLES = false

export default function UserManagement({ currentUserRole, currentUserEmail }) {
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

    if (!newUserEmail || !newUserPassword || !newUserRole) {
      toast.error('Please fill all fields')
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
      toast.success(`User created! ${newUserEmail} can now log in.`)
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
      toast.error(error.message || 'Failed to add user')
    }
  }

  const handleUpdateRole = async (email, newRole) => {
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
      toast.success(`Role updated to ${newRole}. Custom permissions reset to role defaults.`)
      db.auditLog
        .log(currentUserEmail, 'user_role_changed', `Changed role of ${email} to ${newRole} (custom permissions reset)`)
        .catch(() => {})
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error('Failed to update role')
    }
  }

  const handleCreateCustomRole = async (e) => {
    e.preventDefault()
    try {
      await db.userRoles.createCustomRole(
        newRoleName,
        newRoleDescription,
        newRolePermissions,
        currentUserEmail
      )
      toast.success('Custom role created successfully!')
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
      toast.error('Failed to create custom role')
    }
  }

  const handleEditPermissions = (user) => {
    setSelectedUser(user)
    setShowPermissionsModal(true)
  }

  const handleSavePermissions = async (permissions) => {
    try {
      await db.userRoles.updateUserPermissions(selectedUser.user_email, permissions)
      toast.success('Permissions updated successfully!')
      db.auditLog
        .log(currentUserEmail, 'user_permissions_changed', `Updated permissions for ${selectedUser.user_email}`)
        .catch(() => {})
      setShowPermissionsModal(false)
      setSelectedUser(null)
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error('Failed to update permissions')
      throw error
    }
  }

  const handleDeleteCustomRole = (roleId) => {
    openConfirm(
      'Delete Custom Role',
      'Delete this custom role? Users assigned to it will lose their custom permissions.',
      async () => {
        closeConfirm()
        try {
          await db.userRoles.deleteCustomRole(roleId)
          toast.success('Custom role deleted successfully!')
          db.auditLog
            .log(currentUserEmail, 'custom_role_deleted', `Deleted custom role ${roleId}`)
            .catch(() => {})
          invalidate()
        } catch (error) {
          captureException(error)
          toast.error('Failed to delete custom role')
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

  const handleUserControlAction = async () => {
    if (!controlAction) {
      toast.error('Please select an action')
      return
    }

    try {
      switch (controlAction) {
        case 'suspend':
          if (!controlReason) {
            toast.error('Please provide a reason for suspension')
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
          toast.success('User suspended successfully')
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
          toast.success('User activated successfully')
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
          toast.success('User locked successfully')
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
          toast.success('User deactivated successfully')
          break

        case 'update_notes':
          await db.userRoles.updateUserNotes(selectedUser.user_email, controlNotes)
          toast.success('Notes updated successfully')
          break

        case 'set_expiration':
          if (!controlExpiration) {
            toast.error('Please set an expiration date')
            return
          }
          await db.userRoles.setUserExpiration(selectedUser.user_email, controlExpiration)
          toast.success('Expiration date set successfully')
          break

        case 'delete':
          openConfirm(
            'Delete User',
            `Permanently delete ${selectedUser.user_email}? This action cannot be undone.`,
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
                toast.success('User deleted successfully')
                db.auditLog
                  .log(currentUserEmail, 'user_deleted', `Deleted user ${deletedEmail}`)
                  .catch(() => {})
                setShowUserControlModal(false)
                setSelectedUser(null)
                invalidate()
              } catch {
                toast.error('Failed to delete user')
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
      toast.error('Failed to perform action')
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
      toast.error('Failed to load user activity')
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
          toast.error('Password must be at least 6 characters')
          return
        }
        await auth.adminSetPassword(selectedUser.user_email, resetPassword)
        toast.success(`Password updated for ${selectedUser.user_email}`)
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
        toast.success(`Password reset email sent to ${selectedUser.user_email}`)
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
      toast.error('Failed to reset password: ' + (error?.message || 'unknown error'))
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
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
        <p className="text-gray-600">Only administrators can access user management.</p>
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
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage users, roles, and permissions</p>
        </div>
        <button
          onClick={() => setShowAddUserModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add User
        </button>
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
              Users
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
              Role Reference
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
                Custom Roles
              </button>
            )}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'users' && (
            <UsersTab
              users={users}
              currentUserRole={currentUserRole}
              currentUserEmail={currentUserEmail}
              onUpdateRole={handleUpdateRole}
              onEditPermissions={handleEditPermissions}
              onUserControl={handleOpenUserControl}
              onViewActivity={handleViewActivity}
              onResetPassword={handleOpenPasswordReset}
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
