import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function NotFoundPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <div className="flex flex-col items-center justify-center h-full py-24 text-center">
      <div className="text-6xl mb-4">🔍</div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-[#e8ebf0] mb-2">{t('notFound.title')}</h1>
      <p className="text-gray-500 dark:text-[#9aa4b2] mb-1">
        {t('notFound.urlPrefix')}{' '}
        <code className="bg-gray-100 dark:bg-[#1a2230] px-1.5 py-0.5 rounded text-sm font-mono">
          {location.pathname}
        </code>{' '}
        {t('notFound.urlSuffix')}
      </p>
      <p className="text-sm text-gray-400 dark:text-[#9aa4b2] mb-6">
        {t('notFound.hint')}
      </p>
      <button
        onClick={() => navigate('/')}
        className="px-5 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
      >
        {t('notFound.goHome')}
      </button>
    </div>
  )
}
