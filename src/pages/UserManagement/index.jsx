import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db, auth } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useURLTab } from '../../hooks/useURLTab'
import { ROLES } from '../../lib/constants'
import { canDo, accessDenialReason } from '../../lib/permissions'
import { captureException } from '../../lib/sentry'
import { addUserSchema, getFirstError } from '../../lib/schemas'
import { validatePasswordStrength, getDefaultPermissions } from './_utils'
import { UsersTab, AddUserModal, InviteUserModal, PasswordResetModal, UserControlModal, ActivityModal } from './UsersTab'
import { filterUsers, paginate, pruneSelection, deletableSelection } from './_directory'
import { RoleTemplatesTab, CustomRolesTab, CreateRoleModal, PermissionsModal } from './RolesTab'
import { PageSkeleton } from '../../components/Skeleton'

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
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const users = useMemo(() => umData?.usersData ?? [], [umData])

  // Search and filters narrow the list; paging then cuts one page from what is
  // left. Order matters — paging first would page the unfiltered directory.
  const filteredUsers = useMemo(
    () => filterUsers(users, { search, role: roleFilter, status: statusFilter }),
    [users, search, roleFilter, statusFilter]
  )
  const pageInfo = useMemo(
    () => paginate(filteredUsers, page, pageSize),
    [filteredUsers, page, pageSize]
  )

  // A selection must never outlive the rows it was made on: selecting twelve
  // people, filtering to one and pressing Delete must not take the other eleven
  // with it. Pruned against what the filters currently show, not the page —
  // paging away from a row is not the same as deciding not to act on it.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneSelection(prev, filteredUsers)
      return next.size === prev.size ? prev : next
    })
  }, [filteredUsers])

  // Narrowing the list can leave the page number past the end. paginate()
  // clamps what it returns, so this only realigns the state behind it.
  useEffect(() => {
    if (pageInfo.page !== page) setPage(pageInfo.page)
  }, [pageInfo.page, page])

  const toggleOne = (email) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })

  const toggleAllOnPage = (checked) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const u of pageInfo.rows) {
        if (checked) next.add(u.user_email)
        else next.delete(u.user_email)
      }
      return next
    })

  /**
   * Delete the selected users for good — role row AND auth account.
   *
   * Your own address is stripped before asking, so the count in the
   * confirmation is the number that will actually go.
   */
  const handleBulkDelete = () => handleDeleteUsers([...selected])

  const handleDeleteUsers = (emails) => {
    const targets = deletableSelection(new Set(emails), currentUserEmail)
    if (targets.length === 0) {
      toast.error(t('userManagement.cannotDeleteSelf'))
      return
    }
    confirm(
      t('userManagement.deleteSelectedTitle', { count: targets.length }),
      t('userManagement.deleteSelectedMsg', { count: targets.length, emails: targets.join(', ') }),
      {
        variant: 'danger',
        confirmText: t('userManagement.deleteConfirmBtn'),
        onConfirm: async () => {
          try {
            const result = await auth.adminDeleteUsers(targets)
            if (result.failed?.length) {
              toast.error(
                t('userManagement.deleteSomeFailed', {
                  deleted: result.deleted,
                  failed: result.failed.map((f) => `${f.email}: ${f.error}`).join('; '),
                })
              )
            } else {
              toast.success(t('userManagement.deletedCount', { count: result.deleted }))
            }
            db.auditLog
              .log(currentUserEmail, 'users_deleted', `Deleted ${result.deleted} user(s): ${targets.join(', ')}`)
              .catch(() => {})
            setSelected(new Set())
            invalidate()
          } catch (error) {
            captureException(error)
            toast.error(error.message || t('userManagement.deleteFailed'))
          }
        },
      }
    )
  }
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
  const [showInviteModal, setShowInviteModal] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('technician')
  const [inviting, setInviting] = useState(false)
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
  const [editingRoleId, setEditingRoleId] = useState(null)
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

  const handleInvite = async (e) => {
    e.preventDefault()

    // Same email+role validation the manual path uses, so the two cannot
    // disagree about what a valid address or role is.
    const validation = addUserSchema.safeParse({ email: inviteEmail, role: inviteRole })
    if (!validation.success) {
      toast.error(getFirstError(validation))
      return
    }

    setInviting(true)
    try {
      await auth.adminInviteUser(inviteEmail, inviteRole)
      db.userActivity
        .create(currentUserEmail, 'user_invited', `Invited ${inviteEmail} as ${inviteRole}`)
        .catch(() => {})
      db.auditLog
        .log(currentUserEmail, 'user_invited', `Invited ${inviteEmail} with role ${inviteRole}`)
        .catch(() => {})
      db.notifications
        .create({
          type: 'user_invited',
          title: 'User Invited',
          message: `${inviteEmail} was invited as ${inviteRole}`,
          entityType: 'user',
          createdBy: currentUserEmail,
          targetRoles: ['super_admin'],
          targetEmails: [],
        })
        .catch(() => {})
      toast.success(t('userManagement.inviteSentToast', { email: inviteEmail }))
      setInviteEmail('')
      setInviteRole('technician')
      setShowInviteModal(false)
      invalidate()
    } catch (error) {
      captureException(error)
      toast.error(error.message || t('userManagement.inviteFailed'))
    } finally {
      setInviting(false)
    }
  }

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
      // The account and its role are created together, server-side. Passing the
      // role lets admin-reset-password write user_roles in the same operation
      // and undo the auth account if that write fails — BUG-018, where the two
      // steps were separate requests and a failure between them left an account
      // that could sign in but had no role and so could do nothing.
      const createResult = await auth.adminCreateUser(
        newUserEmail,
        newUserPassword,
        newUserRole
      )
      // Older deployments of the function ignore `role` and report roleCreated
      // false; the role still has to be written from here in that case.
      if (!createResult?.roleCreated) {
        await db.userRoles.createRole(newUserEmail, newUserRole)
      }
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

  const handleEditCustomRole = (role) => {
    setEditingRoleId(role.id)
    setNewRoleName(role.role_name)
    setNewRoleDescription(role.role_description || '')
    setNewRoleBase(role.base_role || 'viewer')
    setNewRolePermissions(role.permissions || getDefaultPermissions())
    setShowCreateRoleModal(true)
  }

  const handleCreateCustomRole = async (e) => {
    e.preventDefault()
    try {
      if (editingRoleId) {
        // role_name is intentionally not editable: it is the value stored in
        // user_roles.role, so renaming it would strand every holder on a role
        // that no longer exists.
        await db.userRoles.updateCustomRole(editingRoleId, {
          role_description: newRoleDescription,
          permissions: newRolePermissions,
          base_role: newRoleBase,
        })
      } else {
        await db.userRoles.createCustomRole(
          newRoleName,
          newRoleDescription,
          newRolePermissions,
          currentUserEmail,
          newRoleBase
        )
      }
      toast.success(t('userManagement.customRoleCreatedToast'))
      db.auditLog
        .log(currentUserEmail, 'custom_role_created', `Created custom role ${newRoleName}`)
        .catch(() => {})
      setNewRoleName('')
      setNewRoleDescription('')
      setNewRolePermissions(getDefaultPermissions())
      setShowCreateRoleModal(false)
      setEditingRoleId(null)
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

  // 'Active' has to mean the same thing here as it does in the database.
  // accessDenialReason mirrors rma_access_is_current(), so an expired super
  // admin is not counted — before 20260786 this compared status alone, and an
  // expiry set on the last super admin would have slipped past the guard.
  const activeSuperAdmins = (users || []).filter(
    (u) => u.role === ROLES.SUPER_ADMIN && !accessDenialReason(u)
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
      <PageSkeleton cols={6} />
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
          <div className="flex items-center gap-2">
            {/* Manual creation is unchanged and still available — but it no
                longer calls itself an invitation, now that one exists. */}
            <button
              onClick={() => setShowAddUserModal(true)}
              className="flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-[#212a38] text-gray-700 dark:text-[#e8ebf0] rounded-lg hover:bg-gray-50 dark:hover:bg-[#1a2230] text-sm font-medium transition-colors"
            >
              {t('userManagement.createManually')}
            </button>
            <button
              onClick={() => setShowInviteModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {t('userManagement.inviteSend')}
            </button>
          </div>
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
              users={pageInfo.rows}
              totalUsers={pageInfo.total}
              search={search}
              onSearchChange={setSearch}
              roleFilter={roleFilter}
              onRoleFilterChange={setRoleFilter}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              selected={selected}
              onToggleOne={toggleOne}
              onToggleAll={toggleAllOnPage}
              onBulkDelete={handleBulkDelete}
              onDeleteUser={(user) => {
                setSelected(new Set([user.user_email]))
                handleDeleteUsers([user.user_email])
              }}
              page={pageInfo.page}
              pageCount={pageInfo.pageCount}
              pageFrom={pageInfo.from}
              pageTo={pageInfo.to}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(n) => { setPageSize(n); setPage(1) }}
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
              onCreateRole={() => {
                // clear any leftover edit target, or "Create" would silently
                // overwrite the role that was last edited
                setEditingRoleId(null)
                setNewRoleName('')
                setNewRoleDescription('')
                setNewRoleBase('viewer')
                setNewRolePermissions(getDefaultPermissions())
                setShowCreateRoleModal(true)
              }}
              onEditRole={handleEditCustomRole}
              onDeleteRole={handleDeleteCustomRole}
            />
          )}
        </div>
      </div>

      {showInviteModal && (
        <InviteUserModal
          email={inviteEmail}
          role={inviteRole}
          busy={inviting}
          onEmailChange={setInviteEmail}
          onRoleChange={setInviteRole}
          onSubmit={handleInvite}
          onClose={() => setShowInviteModal(false)}
        />
      )}

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
          editing={!!editingRoleId}
          baseRole={newRoleBase}
          onBaseRoleChange={setNewRoleBase}
          roleName={newRoleName}
          roleDescription={newRoleDescription}
          permissions={newRolePermissions}
          onRoleNameChange={setNewRoleName}
          onRoleDescriptionChange={setNewRoleDescription}
          onPermissionsChange={setNewRolePermissions}
          onSubmit={handleCreateCustomRole}
          onClose={() => {
            setShowCreateRoleModal(false)
            setEditingRoleId(null)
          }}
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
