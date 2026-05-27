import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'

export default function NotFoundPage() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <div className="flex flex-col items-center justify-center h-full py-24 text-center">
      <div className="text-6xl mb-4">🔍</div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-slate-100 mb-2">Page not found</h1>
      <p className="text-gray-500 dark:text-slate-400 mb-1">
        The URL{' '}
        <code className="bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-sm font-mono">
          {location.pathname}
        </code>{' '}
        doesn&apos;t match any page.
      </p>
      <p className="text-sm text-gray-400 dark:text-slate-500 mb-6">
        Check the URL or use the sidebar to navigate.
      </p>
      <button
        onClick={() => navigate('/')}
        className="px-5 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
      >
        Go to Dashboard
      </button>
    </div>
  )
}
