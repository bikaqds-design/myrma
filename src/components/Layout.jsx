import React from 'react'
import { NavLink } from 'react-router-dom'

export default function Layout({ children, userRole, userEmail, onLogout }) {
  const getRoleBadge = (role) => {
    const badges = {
      super_admin: { icon: '👑', label: 'Super Admin', color: 'bg-purple-100 text-purple-800' },
      admin: { icon: '👑', label: 'Admin', color: 'bg-indigo-100 text-indigo-800' },
      manager: { icon: '👔', label: 'Manager', color: 'bg-blue-100 text-blue-800' },
      technician: { icon: '🔧', label: 'Technician', color: 'bg-green-100 text-green-800' },
      viewer: { icon: '👁️', label: 'Viewer', color: 'bg-gray-100 text-gray-800' }
    }
    return badges[role] || badges.viewer
  }

  const badge = getRoleBadge(userRole)

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-gray-900 text-white flex flex-col">
        {/* Logo */}
        <div className="p-6 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold">myRMA</h1>
              <p className="text-xs text-gray-400">RMA Management</p>
            </div>
          </div>
        </div>

        {/* User Info */}
        <div className="px-4 py-4 border-b border-gray-800">
          <p className="text-sm text-gray-400">Logged in as</p>
          <p className="font-medium text-white truncate">{userEmail}</p>
          <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full mt-2 ${badge.color}`}>
            <span>{badge.icon}</span>
            <span>{badge.label}</span>
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto">
          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ' +
              (isActive
                ? 'bg-indigo-600 text-white'
                : 'text-gray-300 hover:bg-gray-700')
            }
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            <span className="font-medium">Dashboard</span>
          </NavLink>

          <NavLink
            to="/products"
            className={({ isActive }) =>
              'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ' +
              (isActive
                ? 'bg-indigo-600 text-white'
                : 'text-gray-300 hover:bg-gray-700')
            }
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <span className="font-medium">Products</span>
          </NavLink>

          <NavLink
            to="/customers"
            className={({ isActive }) =>
              'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ' +
              (isActive
                ? 'bg-indigo-600 text-white'
                : 'text-gray-300 hover:bg-gray-700')
            }
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span className="font-medium">Customers</span>
          </NavLink>

          <NavLink
            to="/rma-tickets"
            className={({ isActive }) =>
              'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ' +
              (isActive
                ? 'bg-indigo-600 text-white'
                : 'text-gray-300 hover:bg-gray-700')
            }
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
            </svg>
            <span className="font-medium">RMA Tickets</span>
          </NavLink>

          {(userRole === 'admin' || userRole === 'super_admin') && (
            <NavLink
              to="/user-management"
              className={({ isActive }) =>
                'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ' +
                (isActive
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-300 hover:bg-gray-700')
              }
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <span className="font-medium">User Management</span>
            </NavLink>
          )}

          {(userRole === 'admin' || userRole === 'super_admin') && (
            <NavLink
              to="/branding"
              className={({ isActive }) =>
                'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ' +
                (isActive
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-300 hover:bg-gray-700')
              }
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
              <span className="font-medium">Branding</span>
            </NavLink>
          )}
        </nav>

        {/* Logout */}
        <div className="p-4 border-t border-gray-800">
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-gray-300 hover:bg-gray-700 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span className="font-medium">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-8">
          {children}
        </div>
      </main>
    </div>
  )
}