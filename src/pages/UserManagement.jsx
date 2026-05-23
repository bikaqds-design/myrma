import React, { useState, useEffect } from 'react'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../components/ConfirmDialog'
import { Spinner, Button } from '../components/ui'
import { useURLTab } from '../hooks/useURLTab'

function validatePasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters'
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter'
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter'
  if (!/[0-9]/.test(pw)) return 'Password must contain a number'
  return null
}

export default function UserManagement({ currentUserRole, currentUserEmail }) {
  const [activeTab, setActiveTab] = useURLTab('umtab', 'users')
  const [users, setUsers] = useState([])
  const [customRoles, setCustomRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null })
  const openConfirm = (title, message, onConfirm) => setConfirmDialog({ open: true, title, message, onConfirm })
  const closeConfirm = () => setConfirmDialog(d => ({ ...d, open: false }))

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
    const handler = (e) => { if (!e.target.closest('.action-menu')) setOpenMenuId(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [usersData, rolesData] = await Promise.all([
        db.userRoles.listAllRoles(),
        db.userRoles.getCustomRoles()
      ])
      setUsers(usersData)
      setCustomRoles(rolesData)
    } catch (error) {
      console.error('Error loading data:', error)
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const handleAddUser = async (e) => {
    e.preventDefault()
    
    if (!newUserEmail || !newUserPassword || !newUserRole) {
      toast.error('Please fill all fields')
      return
    }

    const pwError = validatePasswordStrength(newUserPassword)
    if (pwError) { toast.error(pwError); return }

    try {
      await db.userRoles.createRole(newUserEmail, newUserRole, newUserPassword)
      db.userActivity.create(currentUserEmail, 'user_created', `Created user ${newUserEmail} with role ${newUserRole}`).catch(() => {})
      db.notifications.create({
        type: 'user_created', title: 'New User Added',
        message: `${newUserEmail} was added with role: ${newUserRole}`,
        entityType: 'user', createdBy: currentUserEmail,
        targetRoles: ['super_admin'], targetEmails: []
      }).catch(() => {})
      toast.success(`User created! Email: ${newUserEmail}`)
      db.auditLog.log(currentUserEmail, 'user_created', `Created user ${newUserEmail} with role ${newUserRole}`).catch(() => {})
      setNewUserEmail('')
      setNewUserRole('technician')
      setNewUserPassword('')
      setShowAddUserModal(false)
      loadData()
    } catch (error) {
      console.error('Error adding user:', error)
      toast.error(error.message || 'Failed to add user')
    }
  }

  const handleUpdateRole = async (email, newRole) => {
    try {
      await db.userRoles.updateRole(email, newRole)
      db.userActivity.create(currentUserEmail, 'user_role_changed', `Changed role of ${email} to ${newRole}`).catch(() => {})
      db.notifications.create({
        type: 'user_role_changed', title: 'Role Updated',
        message: `${email}'s role was changed to ${newRole}`,
        entityType: 'user', createdBy: currentUserEmail,
        targetRoles: ['super_admin'], targetEmails: [email]
      }).catch(() => {})
      toast.success('Role updated successfully!')
      db.auditLog.log(currentUserEmail, 'user_role_changed', `Changed role of ${email} to ${newRole}`).catch(() => {})
      loadData()
    } catch (error) {
      console.error('Error updating role:', error)
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
      db.auditLog.log(currentUserEmail, 'custom_role_created', `Created custom role ${newRoleName}`).catch(() => {})
      setNewRoleName('')
      setNewRoleDescription('')
      setNewRolePermissions(getDefaultPermissions())
      setShowCreateRoleModal(false)
      loadData()
    } catch (error) {
      console.error('Error creating role:', error)
      toast.error('Failed to create custom role')
    }
  }

  const handleEditPermissions = (user) => {
    setSelectedUser(user)
    setShowPermissionsModal(true)
  }

  const handleSavePermissions = async () => {
    try {
      await db.userRoles.updateUserPermissions(selectedUser.user_email, selectedUser.permissions)
      toast.success('Permissions updated successfully!')
      setShowPermissionsModal(false)
      setSelectedUser(null)
      loadData()
    } catch (error) {
      console.error('Error updating permissions:', error)
      toast.error('Failed to update permissions')
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
          db.auditLog.log(currentUserEmail, 'custom_role_deleted', `Deleted custom role ${roleId}`).catch(() => {})
          loadData()
        } catch (error) {
          console.error('Error deleting role:', error)
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
          await db.userRoles.updateUserStatus(selectedUser.user_email, 'suspended', controlReason, currentUserEmail)
          db.userActivity.create(currentUserEmail, 'user_suspended', `Suspended ${selectedUser.user_email}: ${controlReason}`).catch(() => {})
          db.notifications.create({
            type: 'user_suspended', title: 'Account Suspended',
            message: `Your account was suspended. Reason: ${controlReason}`,
            entityType: 'user', createdBy: currentUserEmail,
            targetRoles: ['super_admin'], targetEmails: [selectedUser.user_email]
          }).catch(() => {})
          toast.success('User suspended successfully')
          db.auditLog.log(currentUserEmail, 'user_suspended', `Suspended ${selectedUser.user_email}: ${controlReason}`).catch(() => {})
          break

        case 'activate':
          await db.userRoles.updateUserStatus(selectedUser.user_email, 'active', null, null)
          db.userActivity.create(currentUserEmail, 'user_activated', `Activated ${selectedUser.user_email}`).catch(() => {})
          db.notifications.create({
            type: 'user_activated', title: 'Account Activated',
            message: `Your account has been reactivated`,
            entityType: 'user', createdBy: currentUserEmail,
            targetRoles: ['super_admin'], targetEmails: [selectedUser.user_email]
          }).catch(() => {})
          toast.success('User activated successfully')
          db.auditLog.log(currentUserEmail, 'user_activated', `Activated ${selectedUser.user_email}`).catch(() => {})
          break

        case 'lock':
          await db.userRoles.updateUserStatus(selectedUser.user_email, 'locked', controlReason, currentUserEmail)
          db.userActivity.create(currentUserEmail, 'user_locked', `Locked ${selectedUser.user_email}${controlReason ? `: ${controlReason}` : ''}`).catch(() => {})
          toast.success('User locked successfully')
          break

        case 'deactivate':
          await db.userRoles.updateUserStatus(selectedUser.user_email, 'deactivated', controlReason, currentUserEmail)
          db.userActivity.create(currentUserEmail, 'user_deactivated', `Deactivated ${selectedUser.user_email}`).catch(() => {})
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
                db.userActivity.create(currentUserEmail, 'user_deleted', `Deleted user ${deletedEmail}`).catch(() => {})
                db.notifications.create({
                  type: 'user_deleted', title: 'User Deleted',
                  message: `${deletedEmail} was removed from the system`,
                  entityType: 'user', createdBy: currentUserEmail,
                  targetRoles: ['super_admin'], targetEmails: []
                }).catch(() => {})
                toast.success('User deleted successfully')
                db.auditLog.log(currentUserEmail, 'user_deleted', `Deleted user ${deletedEmail}`).catch(() => {})
                setShowUserControlModal(false)
                setSelectedUser(null)
                loadData()
              } catch (error) {
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
      loadData()
    } catch (error) {
      console.error('Error performing user action:', error)
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
      console.error('Error loading activity:', error)
      toast.error('Failed to load user activity')
    }
  }

  const handleOpenPasswordReset = (user) => {
    setSelectedUser(user)
    setResetPassword('')
    setShowPasswordModal(true)
  }

  const handleResetPassword = async () => {
    if (resetPassword.length < 6) {
      toast.error('Password must be at least 6 characters')
      return
    }

    try {
      await db.userRoles.updatePassword(selectedUser.user_email, resetPassword)
      toast.success('Password updated successfully!')
      db.auditLog.log(currentUserEmail, 'user_password_reset', `Reset password for ${selectedUser.user_email}`).catch(() => {})
      setShowPasswordModal(false)
      setSelectedUser(null)
      setResetPassword('')
    } catch (error) {
      console.error('Error resetting password:', error)
      toast.error('Failed to reset password')
    }
  }

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="text-center py-12">
        <svg className="w-16 h-16 text-red-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
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
              className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'users' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
            >
              Users
            </button>
            <button
              onClick={() => setActiveTab('roles')}
              className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'roles' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
            >
              Role Templates
            </button>
            <button
              onClick={() => setActiveTab('custom')}
              className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'custom' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}
            >
              Custom Roles
            </button>
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
          
          {activeTab === 'roles' && <RoleTemplatesTab currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} />}
          
          {activeTab === 'custom' && (
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
          onUserChange={setSelectedUser}
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

function UsersTab({ users, currentUserRole, currentUserEmail, onUpdateRole, onEditPermissions, onUserControl, onViewActivity, onResetPassword, openMenuId, setOpenMenuId }) {
  const isSuperAdmin = currentUserRole === 'super_admin'
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">User</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Change Role</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Permissions</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
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
                  <span className="text-sm text-gray-400 italic">current user</span>
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
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
                    {user.permissions ? 'Custom' : 'Role Default'}
                  </button>
                ) : (
                  <span className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-500">
                    {user.permissions ? 'Custom' : 'Role Default'}
                  </span>
                )}
              </td>
              <td className="px-6 py-4 relative action-menu">
                <button onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === user.id ? null : user.id) }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
                </button>
                {openMenuId === user.id && (
                  <div className="absolute right-0 top-9 z-30 w-48 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                    <button onClick={() => { onUserControl(user); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                      Controls
                    </button>
                    <button onClick={() => { onResetPassword(user); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/></svg>
                      Reset Password
                    </button>
                    <button onClick={() => { onViewActivity(user); setOpenMenuId(null) }} className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5">
                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
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

function AddUserModal({ email, password, role, onEmailChange, onPasswordChange, onRoleChange, onSubmit, onClose }) {
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Add New User</h2>
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
                type={showPassword ? "text" : "password"}
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
      </div>
    </div>
  )
}

function PasswordResetModal({ user, password, onPasswordChange, onSubmit, onClose }) {
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Reset Password</h2>
        <p className="text-gray-600 mb-4">User: <strong>{user.user_email}</strong></p>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">New Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent pr-10"
                placeholder="Min 6 characters"
                minLength={6}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
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

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <p className="text-sm text-yellow-800">
              ⚠️ The user will be able to log in immediately with this new password.
            </p>
          </div>

          <div className="flex gap-3 pt-4">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={onSubmit}
              disabled={password.length < 6}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Reset Password
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UserControlModal({ user, action, reason, notes, expiration, onActionChange, onReasonChange, onNotesChange, onExpirationChange, onSubmit, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 m-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">User Controls: {user.user_email}</h2>
        
        <div className="space-y-4">
          <div className="bg-gray-50 p-4 rounded-lg">
            <p className="text-sm text-gray-600 mb-2">Current Status:</p>
            <StatusBadge status={user.status || 'active'} />
            {user.suspended_reason && (
              <div className="mt-2 text-sm text-gray-600">
                <p><strong>Reason:</strong> {user.suspended_reason}</p>
                <p><strong>Suspended by:</strong> {user.suspended_by}</p>
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
              <p className="text-sm text-red-600 mt-1">All user data and permissions will be permanently deleted.</p>
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
      </div>
    </div>
  )
}

function ActivityModal({ user, activity, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl p-6 m-4 max-h-[80vh] overflow-y-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Activity Log: {user.user_email}</h2>
        
        {activity.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No activity recorded yet
          </div>
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
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const badges = {
    active: 'bg-green-100 text-green-800',
    suspended: 'bg-yellow-100 text-yellow-800',
    locked: 'bg-red-100 text-red-800',
    deactivated: 'bg-gray-100 text-gray-800',
    pending: 'bg-blue-100 text-blue-800'
  }

  const labels = {
    active: '🟢 Active',
    suspended: '⏸️ Suspended',
    locked: '🔒 Locked',
    deactivated: '❌ Deactivated',
    pending: '⏳ Pending'
  }

  return (
    <span className={'px-3 py-1 text-xs font-medium rounded-full ' + (badges[status] || badges.active)}>
      {labels[status] || status}
    </span>
  )
}

function RoleTemplatesTab({ currentUserRole, currentUserEmail }) {
  const [savedTemplates, setSavedTemplates] = useState({})
  const [editingRole, setEditingRole] = useState(null)
  const [editPerms, setEditPerms] = useState(null)
  const [saving, setSaving] = useState(false)
  const isSuperAdmin = currentUserRole === 'super_admin'

  useEffect(() => { loadTemplates() }, [])

  const loadTemplates = async () => {
    try {
      const result = await db.rmaConfig.getAll()
      if (!result.missing) {
        const row = result.data.find(r => r.config_key === 'role_templates')
        if (row?.config_value) {
          const val = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
          setSavedTemplates(val)
        }
      }
    } catch { /* fall back to hardcoded defaults */ }
  }

  const getEffectivePerms = (roleKey) => {
    if (savedTemplates[roleKey]) return savedTemplates[roleKey]
    return getRoleTemplates().find(r => r.key === roleKey)?.permissions || {}
  }

  const handleEdit = (role) => {
    setEditingRole(role)
    setEditPerms(JSON.parse(JSON.stringify(getEffectivePerms(role.key))))
  }

  const handleResetToDefault = () => {
    const defaults = getRoleTemplates().find(r => r.key === editingRole.key)
    setEditPerms(JSON.parse(JSON.stringify(defaults.permissions)))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = { ...savedTemplates, [editingRole.key]: editPerms }
      await db.rmaConfig.set('role_templates', updated, currentUserEmail)
      setSavedTemplates(updated)
      setEditingRole(null)
      toast.success(`${editingRole.name} template saved`)
    } catch { toast.error('Failed to save template') }
    finally { setSaving(false) }
  }

  const roles = getRoleTemplates()

  return (
    <div className="space-y-6">
      {roles.map((role) => {
        const perms = getEffectivePerms(role.key)
        const hasCustom = !!savedTemplates[role.key]
        return (
          <div key={role.key} className="border border-gray-200 rounded-xl p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-base font-semibold text-gray-900">{role.icon} {role.name}</h3>
                  {hasCustom && <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded-full">Modified</span>}
                </div>
                <p className="text-sm text-gray-500">{role.description}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <RoleBadge role={role.key} />
                {isSuperAdmin && (
                  <button onClick={() => handleEdit(role)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    Edit
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {Object.entries(perms).map(([module, modulePerms]) => {
                const enabled = Object.entries(modulePerms).filter(([, v]) => v).map(([k]) => k)
                return (
                  <div key={module} className="bg-gray-50 rounded-lg p-3">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{module.replace(/_/g, ' ')}</h4>
                    <div className="flex flex-wrap gap-1.5">
                      {enabled.length === 0
                        ? <span className="text-xs text-gray-400 italic">No access</span>
                        : enabled.map(p => (
                          <span key={p} className="px-1.5 py-0.5 bg-green-100 text-green-800 text-xs rounded font-medium">
                            {p.replace(/_/g, ' ')}
                          </span>
                        ))
                      }
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {editingRole && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-bold text-gray-900">{editingRole.icon} Edit {editingRole.name} Template</h3>
                <p className="text-sm text-gray-500 mt-0.5">These defaults apply when a user has no custom permissions set</p>
              </div>
              <button onClick={() => setEditingRole(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {editPerms && <PermissionMatrix permissions={editPerms} onToggle={(module, perm) => {
                setEditPerms(p => ({ ...p, [module]: { ...p[module], [perm]: !p[module][perm] } }))
              }} />}
            </div>
            <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-2xl">
              <button onClick={handleResetToDefault}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-white transition-colors">
                Reset to Default
              </button>
              <div className="flex gap-3">
                <button onClick={() => setEditingRole(null)} className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-white">Cancel</button>
                <button onClick={handleSave} disabled={saving}
                  className="px-5 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving…' : 'Save Template'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CustomRolesTab({ customRoles, onCreateRole, onDeleteRole }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-4">
        <p className="text-gray-600">{customRoles.length} custom roles created</p>
        <button
          onClick={onCreateRole}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
        >
          Create Custom Role
        </button>
      </div>

      {customRoles.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No custom roles created yet. Create your first custom role!
        </div>
      ) : (
        <div className="space-y-4">
          {customRoles.map((role) => (
            <div key={role.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900">{role.role_name}</h3>
                  <p className="text-sm text-gray-600 mt-1">{role.role_description}</p>
                  <p className="text-xs text-gray-500 mt-2">Created by {role.created_by}</p>
                </div>
                <button
                  onClick={() => onDeleteRole(role.id)}
                  className="text-red-600 hover:text-red-800"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateRoleModal({ roleName, roleDescription, permissions, onRoleNameChange, onRoleDescriptionChange, onPermissionsChange, onSubmit, onClose }) {
  const togglePermission = (module, perm) => {
    const updated = { ...permissions }
    updated[module][perm] = !updated[module][perm]
    onPermissionsChange(updated)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl p-6 m-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Create Custom Role</h2>
        <form onSubmit={onSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Role Name</label>
            <input
              type="text"
              value={roleName}
              onChange={(e) => onRoleNameChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
              placeholder="e.g., Support Agent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Description</label>
            <textarea
              value={roleDescription}
              onChange={(e) => onRoleDescriptionChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600"
              rows="2"
              placeholder="Brief description of this role"
            />
          </div>

          <div>
            <h3 className="font-semibold text-gray-900 mb-3">Permissions</h3>
            <PermissionMatrix permissions={permissions} onToggle={togglePermission} />
          </div>

          <div className="flex gap-3 pt-4 border-t">
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
              Create Role
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function PermissionsModal({ user, onUserChange, onSave, onClose }) {
  const togglePermission = (module, perm) => {
    const updated = { ...user }
    if (!updated.permissions) updated.permissions = getDefaultPermissions()
    if (!updated.permissions[module]) updated.permissions[module] = {}
    updated.permissions[module][perm] = !updated.permissions[module][perm]
    onUserChange(updated)
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl p-6 m-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Edit Permissions: {user.user_email}</h2>
        
        <PermissionMatrix 
          permissions={user.permissions || getDefaultPermissions()} 
          onToggle={togglePermission} 
        />

        <div className="flex gap-3 pt-6 border-t mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            Save Permissions
          </button>
        </div>
      </div>
    </div>
  )
}

function PermissionMatrix({ permissions, onToggle }) {
  const modules = [
    { key: 'products', label: 'Products' },
    { key: 'customers', label: 'Customers' },
    { key: 'rma_tickets', label: 'RMA Tickets' },
    { key: 'inventory', label: 'Inventory' },
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'user_management', label: 'User Management' },
    { key: 'settings', label: 'Settings' }
  ]

  return (
    <div className="space-y-4">
      {modules.map((module) => (
        <div key={module.key} className="border border-gray-200 rounded-lg p-4">
          <h4 className="font-medium text-gray-900 mb-3">{module.label}</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {permissions[module.key] && Object.entries(permissions[module.key]).map(([perm, enabled]) => (
              <label key={perm} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => onToggle(module.key, perm)}
                  className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-600"
                />
                <span className="text-sm text-gray-700">{perm.replace('_', ' ')}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function RoleBadge({ role }) {
  const badges = {
    super_admin: 'bg-purple-100 text-purple-800',
    admin: 'bg-indigo-100 text-indigo-800',
    manager: 'bg-blue-100 text-blue-800',
    technician: 'bg-green-100 text-green-800',
    viewer: 'bg-gray-100 text-gray-800'
  }

  const labels = {
    super_admin: '👑 Super Admin',
    admin: '👑 Admin',
    manager: '👔 Manager',
    technician: '🔧 Technician',
    viewer: '👁️ Viewer'
  }

  return (
    <span className={'px-3 py-1 text-xs font-medium rounded-full ' + badges[role]}>
      {labels[role] || role}
    </span>
  )
}

function getDefaultPermissions() {
  return {
    products: { view: false, create: false, edit: false, delete: false, export: false, import: false },
    customers: { view: false, create: false, edit: false, delete: false, export: false, import: false, view_history: false },
    rma_tickets: { view_all: false, view_assigned: false, create: false, edit_all: false, edit_assigned: false, delete: false, assign: false, change_status: false, change_priority: false, add_comments: false, delete_comments: false, view_activity: false, attach_files: false, delete_files: false, print_labels: false, export: false },
    inventory: { view: false, resolve_units: false, manage_batches: false, delete: false, export: false, manage_warehouses: false, transfer: false },
    dashboard: { view_dashboard: false, view_analytics: false, view_reports: false, export_reports: false, customize_dashboard: false },
    user_management: { view_users: false, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
    settings: { view_settings: false, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: false, manage_priorities: false, manage_categories: false, view_audit_logs: false }
  }
}

function getRoleTemplates() {
  return [
    {
      key: 'super_admin',
      name: 'Super Admin',
      icon: '👑',
      description: 'Full system access including user management and system settings',
      permissions: {
        products: { view: true, create: true, edit: true, delete: true, export: true, import: true },
        customers: { view: true, create: true, edit: true, delete: true, export: true, import: true, view_history: true },
        rma_tickets: { view_all: true, view_assigned: true, create: true, edit_all: true, edit_assigned: true, delete: true, assign: true, change_status: true, change_priority: true, add_comments: true, delete_comments: true, view_activity: true, attach_files: true, delete_files: true, print_labels: true, export: true },
        inventory: { view: true, resolve_units: true, manage_batches: true, delete: true, export: true, manage_warehouses: true, transfer: true },
        dashboard: { view_dashboard: true, view_analytics: true, view_reports: true, export_reports: true, customize_dashboard: true },
        user_management: { view_users: true, create_users: true, edit_users: true, delete_users: true, assign_roles: true, manage_permissions: true, create_roles: true, delete_roles: true },
        settings: { view_settings: true, edit_company_info: true, edit_branding: true, manage_email_templates: true, manage_statuses: true, manage_priorities: true, manage_categories: true, view_audit_logs: true }
      }
    },
    {
      key: 'admin',
      name: 'Admin',
      icon: '👑',
      description: 'Management access without user permission controls',
      permissions: {
        products: { view: true, create: true, edit: true, delete: true, export: true, import: true },
        customers: { view: true, create: true, edit: true, delete: true, export: true, import: true, view_history: true },
        rma_tickets: { view_all: true, view_assigned: true, create: true, edit_all: true, edit_assigned: true, delete: false, assign: true, change_status: true, change_priority: true, add_comments: true, delete_comments: false, view_activity: true, attach_files: true, delete_files: false, print_labels: true, export: true },
        inventory: { view: true, resolve_units: true, manage_batches: true, delete: false, export: true, manage_warehouses: true, transfer: true },
        dashboard: { view_dashboard: true, view_analytics: true, view_reports: true, export_reports: true, customize_dashboard: true },
        user_management: { view_users: true, create_users: true, edit_users: true, delete_users: false, assign_roles: true, manage_permissions: false, create_roles: false, delete_roles: false },
        settings: { view_settings: true, edit_company_info: true, edit_branding: true, manage_email_templates: true, manage_statuses: true, manage_priorities: true, manage_categories: true, view_audit_logs: true }
      }
    },
    {
      key: 'manager',
      name: 'Manager',
      icon: '👔',
      description: 'Team lead with full operational access but limited system settings',
      permissions: {
        products: { view: true, create: true, edit: true, delete: false, export: true, import: true },
        customers: { view: true, create: true, edit: true, delete: false, export: true, import: true, view_history: true },
        rma_tickets: { view_all: true, view_assigned: true, create: true, edit_all: true, edit_assigned: true, delete: false, assign: true, change_status: true, change_priority: true, add_comments: true, delete_comments: false, view_activity: true, attach_files: true, delete_files: false, print_labels: true, export: true },
        inventory: { view: true, resolve_units: true, manage_batches: true, delete: false, export: true, manage_warehouses: false, transfer: true },
        dashboard: { view_dashboard: true, view_analytics: true, view_reports: true, export_reports: true, customize_dashboard: true },
        user_management: { view_users: true, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
        settings: { view_settings: true, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: true, manage_priorities: true, manage_categories: true, view_audit_logs: true }
      }
    },
    {
      key: 'technician',
      name: 'Technician',
      icon: '🔧',
      description: 'Field worker with limited editing rights',
      permissions: {
        products: { view: true, create: false, edit: false, delete: false, export: false, import: false },
        customers: { view: true, create: false, edit: false, delete: false, export: false, import: false, view_history: true },
        rma_tickets: { view_all: true, view_assigned: true, create: false, edit_all: false, edit_assigned: true, delete: false, assign: false, change_status: true, change_priority: false, add_comments: true, delete_comments: false, view_activity: true, attach_files: true, delete_files: false, print_labels: true, export: false },
        inventory: { view: true, resolve_units: true, manage_batches: false, delete: false, export: false, manage_warehouses: false, transfer: false },
        dashboard: { view_dashboard: true, view_analytics: false, view_reports: false, export_reports: false, customize_dashboard: false },
        user_management: { view_users: false, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
        settings: { view_settings: false, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: false, manage_priorities: false, manage_categories: false, view_audit_logs: false }
      }
    },
    {
      key: 'viewer',
      name: 'Viewer',
      icon: '👁️',
      description: 'Read-only access to all data',
      permissions: {
        products: { view: true, create: false, edit: false, delete: false, export: false, import: false },
        customers: { view: true, create: false, edit: false, delete: false, export: false, import: false, view_history: true },
        rma_tickets: { view_all: true, view_assigned: false, create: false, edit_all: false, edit_assigned: false, delete: false, assign: false, change_status: false, change_priority: false, add_comments: false, delete_comments: false, view_activity: true, attach_files: false, delete_files: false, print_labels: false, export: false },
        inventory: { view: true, resolve_units: false, manage_batches: false, delete: false, export: true, manage_warehouses: false, transfer: false },
        dashboard: { view_dashboard: true, view_analytics: false, view_reports: false, export_reports: false, customize_dashboard: false },
        user_management: { view_users: false, create_users: false, edit_users: false, delete_users: false, assign_roles: false, manage_permissions: false, create_roles: false, delete_roles: false },
        settings: { view_settings: false, edit_company_info: false, edit_branding: false, manage_email_templates: false, manage_statuses: false, manage_priorities: false, manage_categories: false, view_audit_logs: false }
      }
    }
  ]
}