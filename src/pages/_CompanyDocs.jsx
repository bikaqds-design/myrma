import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../api/supabaseClient'
import { Table, Pagination, Button, Label, Input, Textarea } from '../components/ui'
import EmptyState from '../components/EmptyState'
import DocumentTrashList from '../components/DocumentTrashList'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import { EXTRACTABLE_TYPES } from '../lib/pdfText'
import { uploadCompanyDocument } from '../lib/documentUpload'
import { purgeExpiredCompanyTrash } from '../lib/documentTrash'
import { formatBytes } from '../lib/knowledgeTree'
import { toUserMessage } from '../lib/errorMessage'
import { captureException } from '../lib/sentry'
import { SearchInput } from '../components/SearchInput'

/**
 * Company Docs (2026-09-03) — reference material that belongs to the
 * business as a whole, not to any one product: price lists, policies,
 * certificates, forms.
 *
 * A separate tab and a separate table (`company_documents`, its own
 * migration) rather than a nullable product_id bolted onto product
 * documents — the Vault's whole tree is built from every document having a
 * real product to hang off of, and these deliberately do not have one. See
 * the migration for the full reasoning.
 *
 * Deliberately flat: no folder tree, no doc_type, no per-slot upload
 * conflict. None of the three has an obvious shape for company-wide
 * material — there is no catalogue to browse and no natural "one datasheet
 * per product" slot for a second upload to collide with — so this stays a
 * single searchable list plus Trash, and grows a taxonomy only if someone
 * actually needs one.
 */
export default function CompanyDocs({ currentUserEmail, currentUserRole, currentUserPermissions }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const canEdit =
    currentUserRole === 'super_admin' ||
    currentUserRole === 'admin' ||
    currentUserPermissions?.products?.edit === true

  const [view, setView] = useState('')
  const [q, setQ] = useState('')
  const [queryDraft, setQueryDraft] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(25)

  useEffect(() => setPage(1), [q, view])

  useEffect(() => {
    if (!canEdit) return
    purgeExpiredCompanyTrash().then((purged) => {
      if (purged > 0) queryClient.invalidateQueries({ queryKey: ['company-documents'] })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit])

  // Provisioning without reading the library. (BUG-066.)
  const { data: provisioned, isLoading } = useQuery({
    queryKey: ['company-documents', 'provisioned'],
    queryFn: () => db.companyDocuments.isProvisioned(),
    staleTime: 10 * 60_000,
  })

  const { data: trashDocs = EMPTY_ARRAY, isFetching: trashLoading } = useQuery({
    queryKey: ['company-documents', 'trash'],
    queryFn: () => db.companyDocuments.listTrash(),
  })

  // One page of the list, or of the search, from the database. The list used
  // to load every document and the search to stop at 100, both then paged
  // here — past the Data API's row cap, silently incomplete. (BUG-066.)
  const { data: pageResult, isFetching } = useQuery({
    queryKey: ['company-documents', 'page', q, page, itemsPerPage],
    queryFn: () => db.companyDocuments.listPage(q, page, itemsPerPage),
    enabled: provisioned === true && view !== 'trash',
    placeholderData: keepPreviousData,
  })
  const pageRows = pageResult?.data ?? EMPTY_ARRAY
  const total = pageResult?.count ?? 0
  useEffect(() => {
    const totalPages = Math.ceil(total / itemsPerPage)
    if (pageResult && totalPages >= 1 && page > totalPages) setPage(totalPages)
  }, [pageResult, total, page, itemsPerPage])

  const runSearch = (e) => {
    e?.preventDefault()
    setQ(queryDraft.trim())
  }
  const clearSearch = () => {
    setQueryDraft('')
    setQ('')
  }

  const trashDoc = async (doc) => {
    try {
      await db.companyDocuments.trash(doc.id, currentUserEmail)
      queryClient.invalidateQueries({ queryKey: ['company-documents'] })
      toast.success(t('documents.movedToTrash'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    }
  }

  const restore = async (doc) => {
    try {
      await db.companyDocuments.restore(doc.id)
      queryClient.invalidateQueries({ queryKey: ['company-documents'] })
      toast.success(t('knowledgeCenter.explorer.restored'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    }
  }

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    []
  )
  const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—')

  const columns = [
    {
      key: 'name',
      header: t('knowledgeCenter.explorer.colName'),
      cell: (row) => (
        <span className="flex items-center gap-2 min-w-0">
          <DocIcon />
          <a
            href={row.file_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="truncate hover:text-indigo-600 dark:hover:text-[#a5b4fc] hover:underline"
          >
            {row.title}
          </a>
          {row.extraction_status !== 'ok' && (
            <span className="shrink-0 px-1.5 py-0.5 text-[10px] uppercase font-semibold rounded-full bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
              {t('documents.notSearchable')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'size',
      header: t('knowledgeCenter.explorer.colSize'),
      width: '100px',
      align: 'end',
      numeric: true,
      cell: (row) => formatBytes(row.file_size),
    },
    {
      key: 'modified',
      header: t('knowledgeCenter.explorer.colModified'),
      width: '150px',
      align: 'end',
      numeric: true,
      cellClassName: 'whitespace-nowrap',
      cell: (row) => formatDate(row.updated_at ?? row.created_at),
    },
    {
      key: 'uploadedBy',
      header: t('knowledgeCenter.explorer.colUploadedBy'),
      width: '160px',
      cell: (row) => row.uploaded_by ?? '—',
    },
    ...(canEdit
      ? [
          {
            key: 'actions',
            header: '',
            width: '40px',
            cell: (row) => (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  trashDoc(row)
                }}
                aria-label={`${t('common.delete')} ${row.title}`}
                className="text-gray-400 hover:text-red-600"
              >
                ×
              </button>
            ),
          },
        ]
      : []),
  ]

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-gray-500">{t('common.loading')}</div>
  }

  if (provisioned === false) {
    return (
      <EmptyState
        title={t('knowledgeCenter.companyDocs.notProvisioned')}
        description={t('knowledgeCenter.companyDocs.notProvisionedHint')}
      />
    )
  }

  return (
    <div className="space-y-3">
      {/* No heading here — the Vault's own breadcrumb already says "Company
          Docs" or "Trash"; repeating it as a second title right below would
          just be noise. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setView(view === 'trash' ? '' : 'trash')}
          className={`px-3 py-2 border rounded-lg text-sm font-medium flex items-center gap-1.5 ${
            view === 'trash'
              ? 'border-indigo-400 text-indigo-600 dark:text-[#a5b4fc]'
              : 'border-[#e6e9ef] dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#0f1520]'
          }`}
        >
          <TrashIcon />
          {t('knowledgeCenter.explorer.trash')}
          {trashDocs.length > 0 && <span className="ms-1">({trashDocs.length})</span>}
        </button>
        {view !== 'trash' && canEdit && (
          <button
            type="button"
            onClick={() => setUploadOpen((v) => !v)}
            className={`px-3 py-2 border rounded-lg text-sm font-medium flex items-center gap-1.5 ${
              uploadOpen
                ? 'border-indigo-400 text-indigo-600 dark:text-[#a5b4fc]'
                : 'border-[#e6e9ef] dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#0f1520]'
            }`}
          >
            <UploadIcon />
            {t('documents.upload')}
          </button>
        )}
      </div>

      {view !== 'trash' && uploadOpen && (
        <InlineCompanyUpload
          currentUserEmail={currentUserEmail}
          onDone={() => {
            setUploadOpen(false)
            queryClient.invalidateQueries({ queryKey: ['company-documents'] })
          }}
          onCancel={() => setUploadOpen(false)}
        />
      )}

      {view === 'trash' ? (
        <DocumentTrashList docs={trashDocs} loading={trashLoading} canEdit={canEdit} onRestore={restore} t={t} />
      ) : (
        <>
          <form onSubmit={runSearch} className="flex flex-wrap gap-2">
            <SearchInput
              value={queryDraft}
              onChange={setQueryDraft}
              // Clearing the box also clears the applied search, not just the draft.
              onClear={clearSearch}
              placeholder={t('knowledgeCenter.companyDocs.searchPlaceholder')}
              aria-label={t('knowledgeCenter.search')}
              className="flex-1 min-w-[240px]"
              inputClassName="w-full py-2.5 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
            />
            <button type="submit" className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">
              {t('knowledgeCenter.search')}
            </button>
            {q && (
              <button type="button" onClick={clearSearch} className="px-4 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2]">
                {t('knowledgeCenter.clear')}
              </button>
            )}
          </form>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-[#9aa4b2]">
            <span>
              {q ? t('knowledgeCenter.resultsFor', { count: total, query: q }) : t('knowledgeCenter.documentCount', { count: total })}
            </span>
            {isFetching && <span>{t('common.loading')}</span>}
          </div>

          <Table
            columns={columns}
            rows={pageRows}
            rowKey={(row) => row.id}
            onRowClick={(row) => window.open(row.file_url, '_blank', 'noopener,noreferrer')}
            empty={
              q
                ? { title: t('knowledgeCenter.noResults', { query: q }), description: t('knowledgeCenter.noResultsHint') }
                : { title: t('knowledgeCenter.companyDocs.empty'), description: t('knowledgeCenter.companyDocs.emptyHint') }
            }
            className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]"
          />

          {total > 0 && (
            <Pagination total={total} page={page} itemsPerPage={itemsPerPage} setItemsPerPage={setItemsPerPage} onPage={setPage} />
          )}
        </>
      )}
    </div>
  )
}

function InlineCompanyUpload({ currentUserEmail, onDone, onCancel }) {
  const { t } = useTranslation()
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [pending, setPending] = useState(null)
  const [form, setForm] = useState({ title: '', description: '' })

  const onPick = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPending(file)
    setForm((f) => ({ ...f, title: f.title || file.name.replace(/\.[^.]+$/, '') }))
  }

  const upload = async () => {
    if (!pending || !form.title.trim()) return
    setBusy(true)
    try {
      const created = await uploadCompanyDocument({
        file: pending,
        title: form.title,
        description: form.description,
        currentUserEmail,
        onStage: setStage,
      })
      toast.success(
        created.extraction_status === 'ok' ? t('documents.uploadedSearchable') : t('documents.uploadedNotSearchable')
      )
      onDone()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px] space-y-3">
      <input
        ref={fileRef}
        type="file"
        onChange={onPick}
        accept=".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,image/*"
        aria-label={t('documents.chooseFile')}
        className="block w-full text-sm text-gray-600 dark:text-[#9aa4b2] file:me-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
      />

      {pending && (
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-3">
            <Label required>{t('documents.title')}</Label>
            <Input aria-label={t('documents.title')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="sm:col-span-3">
            <Label>{t('documents.description')}</Label>
            <Textarea aria-label={t('documents.description')} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>

          {!EXTRACTABLE_TYPES.includes(pending.type) && (
            <p className="sm:col-span-3 text-xs text-amber-600 dark:text-amber-400">{t('documents.notExtractable')}</p>
          )}

          <div className="sm:col-span-3 flex items-center justify-end gap-3">
            {stage && <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t(`documents.stage_${stage}`)}</span>}
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={upload} disabled={busy || !form.title.trim()}>
              {busy ? t('common.saving') : t('documents.upload')}
            </Button>
          </div>
        </div>
      )}
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

function TrashIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5-5m0 0l5 5m-5-5v12" />
    </svg>
  )
}

