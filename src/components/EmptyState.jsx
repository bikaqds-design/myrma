import React from 'react'
import { Button } from './ui'

const PRESETS = {
  tickets: {
    icon: (
      <svg className="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
    title: 'No tickets found',
    description: 'Try adjusting your filters or create a new RMA ticket.',
  },
  customers: {
    icon: (
      <svg className="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
    title: 'No customers found',
    description: 'Try adjusting your search or add a new customer.',
  },
  products: {
    icon: (
      <svg className="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
      </svg>
    ),
    title: 'No products found',
    description: 'Try adjusting your search or add a new product.',
  },
  inventory: {
    icon: (
      <svg className="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
      </svg>
    ),
    title: 'No inventory records',
    description: 'No items match your current filters.',
  },
  search: {
    icon: (
      <svg className="w-10 h-10 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    title: 'No results found',
    description: 'Try a different search term or clear your filters.',
  },
}

export default function EmptyState({ preset, icon, title, description, action, actionLabel, className = '' }) {
  const p = PRESETS[preset] || {}
  const resolvedIcon = icon || p.icon
  const resolvedTitle = title || p.title || 'Nothing here yet'
  const resolvedDescription = description || p.description || ''

  return (
    <div className={`flex flex-col items-center justify-center py-16 px-6 text-center ${className}`}>
      {resolvedIcon && (
        <div className="w-16 h-16 rounded-2xl bg-gray-50 flex items-center justify-center mb-4">
          {resolvedIcon}
        </div>
      )}
      <p className="text-sm font-semibold text-gray-700 mb-1">{resolvedTitle}</p>
      {resolvedDescription && <p className="text-sm text-gray-400 max-w-xs">{resolvedDescription}</p>}
      {action && actionLabel && (
        <Button className="mt-5" onClick={action}>{actionLabel}</Button>
      )}
    </div>
  )
}
