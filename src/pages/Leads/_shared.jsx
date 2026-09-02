// React component(s) shared across the Leads module.
// Mirrors RMATickets/_shared.jsx's SortableHeader — page-scoped duplicate
// rather than a cross-folder import, matching this codebase's established
// per-page-folder pattern (see also STATUS_BADGE duplicated between
// Leads/index.jsx and Leads/LeadDetails.jsx).

import React from 'react'

export function SortableHeader({ label, sortKey, sortConfig, onSort }) {
  const isActive = sortConfig.key === sortKey
  const ariaSort = isActive ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending') : 'none'
  return (
    <button
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label}`}
      aria-sort={ariaSort}
      className="flex items-center gap-1 hover:text-gray-900 dark:hover:text-[#e8ebf0] transition-colors"
    >
      <span>{label}</span>
      {isActive ? (
        sortConfig.direction === 'asc' ? (
          <svg className="w-3.5 h-3.5 text-indigo-600 dark:text-[#a5b4fc] ms-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5 text-indigo-600 dark:text-[#a5b4fc] ms-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )
      ) : (
        <svg className="w-3.5 h-3.5 text-gray-300 dark:text-[#a4acb7] ms-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
      )}
    </button>
  )
}
