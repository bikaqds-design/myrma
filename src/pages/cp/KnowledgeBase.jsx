import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import Pagination from '../../components/Pagination'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'
import { captureException } from '../../lib/sentry'
import { MigrationNotice } from './Announcements'

const EMPTY_FORM = {
  title: '',
  body: '',
  category: 'general',
  is_published: false,
}

const CATEGORIES = ['general', 'shipping', 'warranty', 'billing', 'account']

export default function KnowledgeBase({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [openMenuId, setOpenMenuId] = useState(null)

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.action-menu')) setOpenMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // One page of articles from the database. This loaded every article, which
  // the Data API caps at 1 000 rows. (BUG-066.)
  const { data: pageResult, isLoading: loading } = useQuery({
    queryKey: ['kb-articles', 'admin', page, pageSize],
    queryFn: () => db.kbArticles.listPage({}, page, pageSize),
    placeholderData: keepPreviousData,
  })
  const articles = pageResult?.data ?? EMPTY_ARRAY
  const missing = pageResult?.missing ?? false
  const total = pageResult?.count ?? 0
  useEffect(() => {
    const totalPages = Math.ceil(total / pageSize)
    if (pageResult && totalPages >= 1 && page > totalPages) setPage(totalPages)
  }, [pageResult, total, page, pageSize])
  const load = () => queryClient.invalidateQueries({ queryKey: ['kb-articles'] })

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }
  const openEdit = (a) => {
    setEditing(a)
    setForm({
      title: a.title,
      body: a.body,
      category: a.category,
      is_published: a.is_published,
    })
    setShowModal(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.body.trim()) {
      toast.error(t('cp.kb.titleBodyRequired'))
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await db.kbArticles.update(editing.id, form)
        toast.success(t('cp.kb.updated'))
        db.auditLog
          .log(currentUserEmail, 'kb_article_updated', `Updated KB article "${form.title}"`)
          .catch(() => {})
      } else {
        await db.kbArticles.create({ ...form, created_by: currentUserEmail })
        toast.success(t('cp.kb.created'))
        db.auditLog
          .log(currentUserEmail, 'kb_article_created', `Created KB article "${form.title}"`)
          .catch(() => {})
      }
      setShowModal(false)
      load()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (a) => {
    if (!confirm(t('cp.kb.deleteConfirm'))) return
    try {
      await db.kbArticles.delete(a.id)
      toast.success(t('cp.kb.deleted'))
      db.auditLog
        .log(currentUserEmail, 'kb_article_deleted', `Deleted KB article "${a.title}"`)
        .catch(() => {})
      load()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    }
  }

  const handleTogglePublished = async (a) => {
    try {
      await db.kbArticles.update(a.id, { is_published: !a.is_published })
      db.auditLog
        .log(
          currentUserEmail,
          'kb_article_status_changed',
          `${!a.is_published ? 'Published' : 'Unpublished'} KB article "${a.title}"`
        )
        .catch(() => {})
      load()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    }
  }

  const inp =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent'

  const HEADERS = [
    t('cp.kb.titleCol'),
    t('cp.kb.categoryCol'),
    t('cp.kb.publishedCol'),
    t('cp.kb.actionsCol'),
  ]

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )

  if (missing) return <MigrationNotice feature="Knowledge Base" sql={KB_ARTICLES_SQL} />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('cp.kb.header')}</h2>
          <p className="text-sm text-gray-500 mt-0.5">{t('cp.kb.subtitle')}</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          {t('cp.kb.newArticle')}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {HEADERS.map((h, i) => (
                <th key={i} className="px-4 py-3 text-start text-xs font-semibold text-gray-500 uppercase">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {articles.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-gray-500">
                  {t('cp.kb.noArticles')}
                </td>
              </tr>
            )}
            {articles.map((a) => (
              <tr key={a.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-sm text-gray-900">{a.title}</div>
                  <div className="text-xs text-gray-500 truncate max-w-xs">{a.body}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                    {a.category}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => handleTogglePublished(a)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${a.is_published ? 'bg-indigo-600' : 'bg-gray-300'}`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${a.is_published ? 'translate-x-4' : 'translate-x-1'}`}
                    />
                  </button>
                </td>
                <td className="px-4 py-3 relative action-menu">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuId(openMenuId === a.id ? null : a.id)
                    }}
                    aria-label={t('common.actions')}
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === a.id}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <circle cx="12" cy="5" r="1.5" />
                      <circle cx="12" cy="12" r="1.5" />
                      <circle cx="12" cy="19" r="1.5" />
                    </svg>
                  </button>
                  {openMenuId === a.id && (
                    <div role="menu" className="absolute end-0 top-9 z-30 w-40 bg-white rounded-xl shadow-lg border border-gray-200 py-1 overflow-hidden">
                      <button
                        onClick={() => {
                          openEdit(a)
                          setOpenMenuId(null)
                        }}
                        className="w-full px-4 py-2 text-start text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2.5"
                      >
                        <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                        {t('cp.edit')}
                      </button>
                      <button
                        onClick={() => {
                          handleDelete(a)
                          setOpenMenuId(null)
                        }}
                        className="w-full px-4 py-2 text-start text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                        {t('cp.delete')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <Pagination total={total} page={page} itemsPerPage={pageSize} setItemsPerPage={setPageSize} onPage={setPage} />
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="kb-modal-title" className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 id="kb-modal-title" className="text-lg font-bold text-gray-900">
                {editing ? t('cp.kb.editModal') : t('cp.kb.newModal')}
              </h3>
              <button onClick={() => setShowModal(false)} aria-label={t('common.close')} className="text-gray-500 hover:text-gray-600">
                <svg className="w-5 h-5" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleSave} className="px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('cp.kb.titleLabel')}</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className={inp}
                  placeholder="e.g. How long does a repair take?"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('cp.kb.bodyLabel')}</label>
                <textarea
                  value={form.body}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  className={inp}
                  rows={5}
                  placeholder="Answer shown to customers on the public FAQ page..."
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">{t('cp.kb.categoryLabel')}</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={inp}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.is_published}
                      onChange={(e) => setForm({ ...form, is_published: e.target.checked })}
                      className="w-4 h-4 text-indigo-600 rounded"
                    />
                    <span className="text-sm font-medium text-gray-700">{t('cp.kb.publishNow')}</span>
                  </label>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  {t('cp.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? t('cp.saving') : editing ? t('cp.kb.saveChanges') : t('cp.kb.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

const KB_ARTICLES_SQL = `-- Quick local test only — run the full migration
-- (supabase/migrations/20260617_kb_articles.sql) for RLS policies.
CREATE TABLE IF NOT EXISTS kb_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_date TIMESTAMPTZ DEFAULT NOW(),
  updated_date TIMESTAMPTZ DEFAULT NOW()
);`
