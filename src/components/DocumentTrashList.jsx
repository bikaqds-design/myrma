import React from 'react'
import { Button } from './ui'
import { daysUntilPurge } from '../lib/documentTrash'

/**
 * The Trash list, shared by the Vault and Company Docs (2026-09-03).
 *
 * Both are "documents recoverable for 5 days" over a different table with a
 * different notion of where a restored document reappears — a product
 * folder for one, nowhere in particular for the other. `pathFor` carries
 * that difference; everything else (the countdown, the empty states, the
 * restore button) is identical and was worth sharing rather than forking.
 *
 * No pagination — Trash is meant to be small and dealt with, not browsed.
 */
export default function DocumentTrashList({ docs, loading, canEdit, onRestore, pathFor, t }) {
  if (loading && docs.length === 0) {
    return (
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]">
        <EmptyStateBlock title={t('common.loading')} />
      </div>
    )
  }

  if (docs.length === 0) {
    return (
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]">
        <EmptyStateBlock
          title={t('knowledgeCenter.explorer.trashEmptyTitle')}
          description={t('knowledgeCenter.explorer.trashEmptyHint')}
        />
      </div>
    )
  }

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] divide-y divide-[#f0f2f6] dark:divide-[#1a2230]">
      {docs.map((doc) => {
        const daysLeft = daysUntilPurge(doc.deleted_at)
        const path = pathFor ? pathFor(doc) : null
        return (
          <div key={doc.id} className="flex items-center gap-3 p-4">
            <DocIcon />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] truncate">{doc.title}</p>
              {path && <p className="text-xs text-gray-500 dark:text-[#9aa4b2] truncate">{path}</p>}
            </div>
            <span
              className={`shrink-0 text-xs ${
                daysLeft <= 1 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-[#6c7280]'
              }`}
            >
              {t('knowledgeCenter.explorer.daysLeft', { count: daysLeft })}
            </span>
            {canEdit && (
              <Button variant="secondary" onClick={() => onRestore(doc)} className="shrink-0">
                {t('knowledgeCenter.explorer.restore')}
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function EmptyStateBlock({ title, description }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <p className="text-sm font-semibold text-[#211f1b] dark:text-[#e8ebf0] mb-1">{title}</p>
      {description && <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-xs">{description}</p>}
    </div>
  )
}

function DocIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-indigo-500 dark:text-[#a5b4fc]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  )
}
