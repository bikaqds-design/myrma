import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { PageHeader } from '../components/ui'
import EmptyState from '../components/EmptyState'
import KnowledgeExplorer from './_KnowledgeExplorer'
import KnowledgeChat from './_KnowledgeChat'
import KnowledgeUpload from './_KnowledgeUpload'

/**
 * The Knowledge Center — every product document in one searchable place.
 *
 * This file is now just the provisioning gate and the tab shell. The Vault
 * tab's own layout — a folder tree over the product catalogue, with Trash
 * and Company Docs as its sibling top-level places — lives in
 * `_KnowledgeExplorer.jsx` (redesigned 2026-09-03; see that file for why).
 * Company Docs is NOT a tab of its own here: it is reference material
 * reached the same way the catalogue is, through Browse, not a fourth
 * unrelated destination competing with Vault/Bika GPT/Bulk upload for a
 * spot in this bar.
 *
 * ── Why the gate lives here, checked once for every tab ─────────────────────
 *
 * Whether `product_documents` exists at all is a deployment question, not a
 * per-tab one — Chat and Upload would fail the same way Vault does if the
 * migration were missing. Checking it once here, before any tab renders,
 * means none of the three have to repeat the check or the not-provisioned
 * copy.
 */
export default function KnowledgeCenter({ currentUserEmail, currentUserRole, currentUserPermissions }) {
  const { t } = useTranslation()
  // The Vault first, not Bika GPT. Search is instant, free and exact; the
  // chat is slower, costs a request and can be wrong. Someone who knows the
  // part number should not be made to converse about it.
  const [mode, setMode] = useState('search')

  // Whether the table is provisioned at all — a count with no rows, not a read
  // of the whole library (which the Data API caps anyway). (BUG-066.)
  const { data: provisioned, isLoading } = useQuery({
    queryKey: ['knowledge-center', 'provisioned'],
    queryFn: () => db.knowledgeLists.isProvisioned(),
    staleTime: 10 * 60_000,
  })

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-gray-500">{t('common.loading')}</div>
  }

  if (provisioned === false) {
    return (
      <div className="p-6">
        <PageHeader title={t('knowledgeCenter.title')} subtitle={t('knowledgeCenter.subtitle')} />
        <EmptyState
          title={t('knowledgeCenter.notProvisioned')}
          description={t('knowledgeCenter.notProvisionedHint')}
        />
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader title={t('knowledgeCenter.title')} subtitle={t('knowledgeCenter.subtitle')} />

      <div className="flex gap-1 border-b border-gray-200 dark:border-[#212a38]">
        {[
          { id: 'search', label: t('knowledgeCenter.modeSearch') },
          { id: 'chat', label: t('knowledgeCenter.modeChat') },
          { id: 'upload', label: t('knowledgeCenter.modeUpload') },
        ].map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              mode === m.id
                ? 'border-indigo-600 text-indigo-600 dark:text-[#a5b4fc] dark:border-[#a5b4fc]'
                : 'border-transparent text-gray-500 dark:text-[#9aa4b2] hover:text-gray-700'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'search' && (
        <KnowledgeExplorer
          currentUserEmail={currentUserEmail}
          currentUserRole={currentUserRole}
          currentUserPermissions={currentUserPermissions}
        />
      )}
      {mode === 'chat' && <KnowledgeChat />}
      {mode === 'upload' && <KnowledgeUpload currentUserEmail={currentUserEmail} />}
    </div>
  )
}
