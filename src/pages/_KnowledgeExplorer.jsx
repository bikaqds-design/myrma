import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../api/supabaseClient'
import { Table, Pagination, Button, Label, Input, Select, Textarea } from '../components/ui'
import { DocumentRow } from '../components/ProductDocuments'
import DocumentTrashList, { EmptyStateBlock } from '../components/DocumentTrashList'
import CompanyDocs from './_CompanyDocs'
import ConfirmDialog from '../components/ConfirmDialog'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import { DOC_TYPES } from '../lib/documentTypes'
import { EXTRACTABLE_TYPES } from '../lib/pdfText'
import { uploadProductDocument, findUploadConflict } from '../lib/documentUpload'
import { purgeExpiredTrash } from '../lib/documentTrash'
import { toUserMessage } from '../lib/errorMessage'
import { captureException } from '../lib/sentry'
import { useUrlState, useResetOnFilterChange } from '../lib/useUrlState'
import {
  buildTree,
  pathTo,
  descendantDocuments,
  formatBytes,
  ROOT_ID,
} from '../lib/knowledgeTree'

/**
 * The Search tab, redesigned as a folder explorer (2026-09-03).
 *
 * The flat search box covered "I know a phrase from the document" well and
 * "what have we actually got for AOC?" not at all — the only way to see a
 * brand's coverage was the Coverage tab's flat product list. This adds real
 * browsing: Brand > Category > Subcategory > Product, mirroring the catalogue
 * those products already live in, with search narrowing whatever folder you
 * are standing in rather than replacing the idea of a folder.
 *
 * ── The tree mirrors the whole catalogue, not just the folders with files ───
 *
 * Decided deliberately: today that is 14 brands and 406 product folders around
 * 2 documents. A brand with nothing uploaded still appears and reads as a gap
 * — which is the point, the same reasoning that put the unsearchable count on
 * screen in the first place. `src/lib/knowledgeTree.js` carries the placement
 * rules and is unit-tested there; this file is the view over it.
 *
 * ── Why browsing and searching share one query, not two code paths ─────────
 *
 * Every folder maps onto exactly one of `DocumentFilters`' existing fields —
 * a brand folder is `{ brandId }`, a product folder is `{ productId }` — so
 * "search inside this folder" is just the existing search/listAll call with
 * the scope folder's filter added in. No new backend shape, and Coverage's
 * counts and this screen's counts can never disagree about what a brand
 * contains.
 *
 * ── Why plain browsing does not issue a second network request ─────────────
 *
 * The tree is already built from every document's metadata (needed for the
 * folder sizes), so a folder with no active search or filter renders straight
 * from that in-memory tree. The `search`/`listAll(applied)` query only runs
 * once something is actually narrowing the view — a query, a file type, or a
 * searchable/unsearchable toggle.
 */
export default function KnowledgeExplorer({ currentUserEmail, currentUserRole, currentUserPermissions }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isRtl = i18n.language === 'ar'

  // Same permission the Product Details Documents tab gates on — a document
  // is part of product management, not a separate permission of its own.
  const canEdit =
    currentUserRole === 'super_admin' ||
    currentUserRole === 'admin' ||
    currentUserPermissions?.products?.edit === true

  const [folder, setFolder] = useUrlState('folder', ROOT_ID)
  const [q, setQ] = useUrlState('q', '')
  const [queryDraft, setQueryDraft] = useState(q)
  const [docType, setDocType] = useUrlState('type', '')
  // '' | 'searchable' | 'unsearchable' — a third value rather than a second
  // boolean, because "show me only what's NOT searchable" is the whole reason
  // extraction status is on screen at all (UX-GLOBAL: the coverage worklist).
  const [status, setStatus] = useUrlState('status', '')
  // '' | 'trash'. A place, not a filter — Trash does not narrow the current
  // folder, it replaces the view entirely, the way it does in a real file
  // manager.
  const [view, setView] = useUrlState('view', '')
  const [page, setPage] = useUrlState('page', 1)
  const [itemsPerPage, setItemsPerPage] = useState(25)
  // All Documents starts expanded — nobody had to click anything to see the
  // brand list before this, and collapsing it by default would be a
  // regression dressed up as a feature.
  const [expanded, setExpanded] = useState(() => new Set([ROOT_ID]))
  const [uploadOpen, setUploadOpen] = useState(false)

  useEffect(() => setQueryDraft(q), [q])
  useResetOnFilterChange([folder, q, docType, status, view], () => setPage(1))

  // Purge runs once per visit, not on a schedule — see documentTrash.js for
  // why. Gated on canEdit: purging is a delete, RLS already refuses it from
  // anyone else, so there is no point spending the round trip for a viewer.
  useEffect(() => {
    if (!canEdit) return
    purgeExpiredTrash().then((purged) => {
      if (purged > 0) {
        queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit])

  const { data: brands = EMPTY_ARRAY } = useQuery({
    queryKey: ['brands'],
    queryFn: () => db.brands.list(),
    staleTime: 10 * 60_000,
  })
  const { data: categories = EMPTY_ARRAY } = useQuery({
    queryKey: ['categories'],
    queryFn: () => db.categories.list(),
    staleTime: 10 * 60_000,
  })
  const { data: subcategories = EMPTY_ARRAY } = useQuery({
    queryKey: ['subcategories'],
    queryFn: () => db.subcategories.list(),
    staleTime: 10 * 60_000,
  })
  const { data: products = EMPTY_ARRAY } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 5 * 60_000,
  })
  // Same key the parent page probes for provisioning, so this is cache, not a
  // second request.
  const { data: libraryRes } = useQuery({
    queryKey: ['knowledge-center', 'library'],
    queryFn: () => db.productDocuments.listAll(),
  })
  const allDocs = libraryRes?.data ?? EMPTY_ARRAY

  // Unconditional, not just while Trash is open — the sidebar badge needs an
  // accurate count at all times, and the list itself is never large.
  const { data: trashDocs = EMPTY_ARRAY, isFetching: trashLoading } = useQuery({
    queryKey: ['knowledge-center', 'trash'],
    queryFn: () => db.productDocuments.listTrash(),
  })

  const { root, byId } = useMemo(
    () => buildTree({ brands, categories, subcategories, products, documents: allDocs }),
    [brands, categories, subcategories, products, allDocs]
  )

  const currentNode = byId.get(folder) ?? root
  const crumbs = useMemo(() => pathTo(byId, currentNode.id), [byId, currentNode])

  // Auto-expand the path to wherever navigation lands (a breadcrumb click, a
  // Recent jump) so the highlighted folder is not hidden in a collapsed tree.
  // Never auto-collapses anything the user opened by hand.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const c of crumbs) {
        if (!next.has(c.id)) {
          next.add(c.id)
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNode.id])

  const goTo = (id) => {
    setView('')
    setFolder(id)
  }

  const scopeFilters = useMemo(() => {
    switch (currentNode.kind) {
      case 'brand':
        return { brandId: currentNode.id }
      case 'category':
        return { categoryId: currentNode.id }
      case 'subcategory':
        return { subcategoryId: currentNode.id }
      case 'product':
        return { productId: currentNode.id }
      default:
        return {}
    }
  }, [currentNode])

  const applied = useMemo(
    () => ({
      ...scopeFilters,
      docType: docType || null,
      searchableOnly: status === 'searchable',
      notSearchableOnly: status === 'unsearchable',
    }),
    [scopeFilters, docType, status]
  )

  // A document with no readable text can never match a text search, so
  // combining the two would always return nothing. Treat "not searchable" as
  // taking over from a stale query rather than producing an honest zero.
  const searchActive = Boolean(q) && status !== 'unsearchable'
  const filtered = Boolean(docType) || status !== ''
  const flatMode = searchActive || filtered

  const { data: flatRes, isFetching } = useQuery({
    queryKey: ['knowledge-center', 'view', folder, q, applied],
    queryFn: () => (searchActive ? db.productDocuments.search(q, applied) : db.productDocuments.listAll(applied)),
    enabled: flatMode,
  })

  const scopedDocs = useMemo(() => descendantDocuments(currentNode), [currentNode])
  const unsearchableHere = useMemo(
    () => scopedDocs.filter((d) => d.extraction_status !== 'ok').length,
    [scopedDocs]
  )
  const typeCounts = useMemo(() => {
    const counts = {}
    for (const d of scopedDocs) counts[d.doc_type] = (counts[d.doc_type] ?? 0) + 1
    return counts
  }, [scopedDocs])

  const recentDocs = useMemo(
    () =>
      [...allDocs]
        .sort((a, b) =>
          String(b.updated_at ?? b.created_at ?? '').localeCompare(String(a.updated_at ?? a.created_at ?? ''))
        )
        .slice(0, 6),
    [allDocs]
  )

  const runSearch = (e) => {
    e?.preventDefault()
    setQ(queryDraft.trim())
  }

  const clearAll = () => {
    setQueryDraft('')
    setQ('')
    setDocType('')
    setStatus('')
  }

  const browseRows = useMemo(
    () => [
      ...currentNode.folders.map((node) => ({ id: node.id, kind: 'folder', node })),
      ...currentNode.documents.map((doc) => ({ id: doc.id, kind: 'document', doc })),
    ],
    [currentNode]
  )
  const flatRows = useMemo(
    () => (flatRes?.data ?? EMPTY_ARRAY).map((doc) => ({ id: doc.id, kind: 'document', doc })),
    [flatRes]
  )
  const allRows = flatMode ? flatRows : browseRows
  const total = allRows.length
  const pageStart = (page - 1) * itemsPerPage
  const pageRows = allRows.slice(pageStart, pageStart + itemsPerPage)

  const brandCrumb = useMemo(() => crumbs.find((c) => c.kind === 'brand'), [crumbs])
  const categoryCrumb = useMemo(() => crumbs.find((c) => c.kind === 'category'), [crumbs])
  const subcategoryCrumb = useMemo(() => crumbs.find((c) => c.kind === 'subcategory'), [crumbs])

  const canCreateFolder = currentNode.kind !== 'product' && view === ''
  const isProductFolder = currentNode.kind === 'product' && view === ''

  const openNewFolder = () =>
    navigate('/products', {
      state: {
        createProduct: {
          brandId: brandCrumb?.id,
          categoryId: categoryCrumb?.id,
          subcategoryId: subcategoryCrumb?.id,
        },
      },
    })

  // Categories belong to one brand, so the dropdown narrows once a brand is
  // picked — the same reasoning the old flat filters used, before the tree
  // replaced them. Picking either just navigates there; there is only ever
  // one notion of "where you are", the folder, not a second filter layer
  // that could disagree with it.
  const categoryOptions = useMemo(
    () => (brandCrumb ? categories.filter((c) => c.brand_id === brandCrumb.id) : EMPTY_ARRAY),
    [categories, brandCrumb]
  )

  const toggleExpanded = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(isRtl ? 'ar' : 'en-US', {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [isRtl]
  )
  const formatDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '—')

  const timeAgo = (iso) => {
    if (!iso) return ''
    const diffMs = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diffMs / 60000)
    if (mins < 1) return t('notifications.justNow')
    if (mins < 60) return t('notifications.minsAgo', { count: mins })
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t('notifications.hoursAgo', { count: hours })
    return t('notifications.daysAgo', { count: Math.floor(hours / 24) })
  }

  const trashDoc = async (doc) => {
    try {
      await db.productDocuments.trash(doc.id, currentUserEmail)
      queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
      queryClient.invalidateQueries({ queryKey: ['product-documents', doc.product_id] })
      toast.success(t('documents.movedToTrash'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    }
  }

  const restore = async (doc) => {
    try {
      await db.productDocuments.restore(doc.id)
      queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
      toast.success(t('knowledgeCenter.explorer.restored'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    }
  }

  const trashCrumbPath = (doc) => {
    if (!doc.product) return doc.title
    const path = pathTo(byId, doc.product.id)
    // The product itself may not have resolved into the tree yet (a
    // just-loaded page, or a product deleted since); fall back to naming it
    // directly rather than showing an empty trail.
    return path.length > 1
      ? path
          .slice(1)
          .map((n) => n.name)
          .join(' / ')
      : `${doc.product.product_name} (${doc.product.sku})`
  }

  const columns = [
    {
      key: 'name',
      header: t('knowledgeCenter.explorer.colName'),
      cell: (row) =>
        row.kind === 'folder' ? (
          <span className="flex items-center gap-2 min-w-0">
            <FolderIcon />
            <span className="truncate">{row.node.name || t('common.untitled')}</span>
            {row.node.kind === 'product' && row.node.sku && (
              <span className="shrink-0 text-[11px] font-mono text-gray-400 dark:text-[#9aa4b2]">
                {row.node.sku}
              </span>
            )}
          </span>
        ) : (
          <span className="flex items-center gap-2 min-w-0">
            <DocIcon />
            {/* A real anchor, not a row-click delegate: it earns ctrl/middle
                click and a status-bar preview that a synthetic handler can't.
                stopPropagation keeps the row's own onRowClick (below) from
                opening a second tab on top of it. */}
            <a
              href={row.doc.file_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="truncate hover:text-indigo-600 dark:hover:text-[#a5b4fc] hover:underline"
            >
              {row.doc.title}
            </a>
            {row.doc.extraction_status !== 'ok' && (
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] uppercase font-semibold rounded-full bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                {t('documents.notSearchable')}
              </span>
            )}
          </span>
        ),
    },
    {
      key: 'type',
      header: t('knowledgeCenter.explorer.colType'),
      width: '110px',
      cell: (row) =>
        row.kind === 'folder' ? t('knowledgeCenter.explorer.kindFolder') : t(`documents.type_${row.doc.doc_type}`),
    },
    {
      key: 'size',
      header: t('knowledgeCenter.explorer.colSize'),
      width: '100px',
      align: 'end',
      numeric: true,
      cell: (row) =>
        row.kind === 'folder'
          ? t('knowledgeCenter.explorer.itemCount', { count: row.node.docCount })
          : formatBytes(row.doc.file_size),
    },
    {
      key: 'modified',
      header: t('knowledgeCenter.explorer.colModified'),
      width: '150px',
      align: 'end',
      numeric: true,
      cellClassName: 'whitespace-nowrap',
      cell: (row) => formatDate(row.kind === 'folder' ? row.node.modified : row.doc.updated_at ?? row.doc.created_at),
    },
    {
      key: 'uploadedBy',
      header: t('knowledgeCenter.explorer.colUploadedBy'),
      width: '160px',
      cell: (row) => (row.kind === 'document' ? row.doc.uploaded_by ?? '—' : '—'),
    },
    ...(canEdit
      ? [
          {
            key: 'actions',
            header: '',
            width: '40px',
            cell: (row) =>
              row.kind === 'document' ? (
                // stopPropagation for the same reason the name link needs it:
                // the row's own onRowClick would otherwise also fire and open
                // the file in a new tab on every delete click.
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    trashDoc(row.doc)
                  }}
                  aria-label={`${t('common.delete')} ${row.doc.title}`}
                  className="text-gray-400 hover:text-red-600"
                >
                  ×
                </button>
              ) : null,
          },
        ]
      : []),
  ]

  const emptyProps = flatMode
    ? q
      ? { title: t('knowledgeCenter.noResults', { query: q }), description: t('knowledgeCenter.noResultsHint') }
      : { title: t('knowledgeCenter.noneMatchFilters'), description: t('knowledgeCenter.noResultsHint') }
    : {
        title: t('knowledgeCenter.explorer.emptyFolderTitle'),
        description: t('knowledgeCenter.explorer.emptyFolderHint'),
      }

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <aside className="lg:w-64 shrink-0 space-y-4">
        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-2">
          <SidebarHeading>{t('knowledgeCenter.explorer.browse')}</SidebarHeading>

          {/* All Documents, Trash and Company Docs are three peers under
              Browse, not a folder plus two cards bolted on beside it. Only
              All Documents has anything nested under it — the catalogue
              tree — so it is the only one of the three with a chevron; the
              other two render at the same indentation, one level shallower
              than the brands, so the nesting reads correctly. */}
          <div className="flex items-center gap-1 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-[#0f1520]" style={{ paddingInlineStart: 8 }}>
            <button
              type="button"
              onClick={() => toggleExpanded(ROOT_ID)}
              aria-label={expanded.has(ROOT_ID) ? t('common.collapse') : t('common.expand')}
              className="shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 dark:text-[#6c7280]"
            >
              <span aria-hidden="true" className="text-[10px]">
                {expanded.has(ROOT_ID) ? '▾' : isRtl ? '◂' : '▸'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => goTo(ROOT_ID)}
              className={`flex-1 min-w-0 flex items-center gap-1.5 py-1.5 pe-2 text-start truncate ${
                currentNode.id === ROOT_ID && view === ''
                  ? 'text-indigo-700 dark:text-[#a5b4fc] font-medium'
                  : 'text-gray-700 dark:text-[#e8ebf0]'
              }`}
            >
              <LibraryIcon />
              <span className="truncate">{t('knowledgeCenter.explorer.allDocuments')}</span>
            </button>
          </div>

          {expanded.has(ROOT_ID) && (
            <div className="max-h-72 overflow-y-auto">
              {root.folders.map((node) => (
                <TreeRow
                  key={node.id}
                  node={node}
                  depth={1}
                  isRtl={isRtl}
                  currentId={currentNode.id}
                  expanded={expanded}
                  onToggle={toggleExpanded}
                  onSelect={goTo}
                  t={t}
                />
              ))}
            </div>
          )}

          <SidebarLeafRow
            icon={<TrashIcon />}
            label={t('knowledgeCenter.explorer.trash')}
            count={trashDocs.length}
            active={view === 'trash'}
            onClick={() => setView('trash')}
          />
          <SidebarLeafRow
            icon={<CompanyDocsIcon />}
            label={t('knowledgeCenter.modeCompanyDocs')}
            active={view === 'companyDocs'}
            onClick={() => setView('companyDocs')}
          />
        </div>

        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3">
          <SidebarHeading>{t('knowledgeCenter.explorer.recent')}</SidebarHeading>
          {recentDocs.length === 0 ? (
            <p className="px-2 py-1 text-xs text-gray-400 dark:text-[#9aa4b2]">
              {t('knowledgeCenter.explorer.recentEmpty')}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {recentDocs.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => goTo(doc.product_id)}
                    className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-start hover:bg-gray-50 dark:hover:bg-[#0f1520]"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <DocIcon small />
                      <span className="truncate text-xs text-gray-700 dark:text-[#e8ebf0]">{doc.title}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-gray-400 dark:text-[#9aa4b2]">
                      {timeAgo(doc.updated_at ?? doc.created_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3">
          <SidebarHeading>{t('knowledgeCenter.explorer.status')}</SidebarHeading>
          <div className="space-y-0.5">
            <SidebarChip active={status === ''} label={t('knowledgeCenter.explorer.statusAll')} count={scopedDocs.length} onClick={() => setStatus('')} />
            <SidebarChip
              active={status === 'searchable'}
              label={t('knowledgeCenter.explorer.statusSearchable')}
              count={scopedDocs.length - unsearchableHere}
              onClick={() => setStatus(status === 'searchable' ? '' : 'searchable')}
            />
            <SidebarChip
              active={status === 'unsearchable'}
              label={t('knowledgeCenter.explorer.statusUnsearchable')}
              count={unsearchableHere}
              warn
              onClick={() => setStatus(status === 'unsearchable' ? '' : 'unsearchable')}
            />
          </div>
        </div>

        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-3">
          <SidebarHeading>{t('knowledgeCenter.explorer.fileType')}</SidebarHeading>
          <div className="space-y-0.5">
            <SidebarChip active={docType === ''} label={t('knowledgeCenter.allTypes')} count={scopedDocs.length} onClick={() => setDocType('')} />
            {DOC_TYPES.filter((d) => typeCounts[d] > 0).map((d) => (
              <SidebarChip
                key={d}
                active={docType === d}
                label={t(`documents.type_${d}`)}
                count={typeCounts[d]}
                onClick={() => setDocType(docType === d ? '' : d)}
              />
            ))}
          </div>
        </div>
      </aside>

      <div className="flex-1 min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="breadcrumb" className="flex-1 min-w-[200px] flex items-center flex-wrap gap-1 text-sm">
            {view === 'trash' || view === 'companyDocs' ? (
              // Trash and Company Docs are peers of All Documents under
              // Browse, not folders beneath it, so the crumb does not claim
              // an "All Documents /" parentage that is not there — the
              // sidebar's own All Documents row is the way back.
              <span className="font-semibold text-gray-900 dark:text-[#e8ebf0]">
                {view === 'trash' ? t('knowledgeCenter.explorer.trash') : t('knowledgeCenter.modeCompanyDocs')}
              </span>
            ) : (
              crumbs.map((c, i) => (
                <React.Fragment key={c.id}>
                  {i > 0 && <span className="text-gray-300 dark:text-[#374151]" aria-hidden="true">/</span>}
                  <button
                    type="button"
                    onClick={() => goTo(c.id)}
                    className={
                      i === crumbs.length - 1
                        ? 'font-semibold text-gray-900 dark:text-[#e8ebf0]'
                        : 'text-gray-500 dark:text-[#9aa4b2] hover:text-indigo-600 dark:hover:text-[#a5b4fc] hover:underline'
                    }
                  >
                    {c.id === ROOT_ID ? t('knowledgeCenter.explorer.allDocuments') : c.name}
                  </button>
                </React.Fragment>
              ))
            )}
          </nav>

          {canCreateFolder && (
            <button
              type="button"
              onClick={openNewFolder}
              className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm font-medium text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#0f1520] flex items-center gap-1.5"
            >
              <NewFolderIcon />
              {t('knowledgeCenter.explorer.newFolder')}
            </button>
          )}
          {isProductFolder && canEdit && (
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

        {isProductFolder && uploadOpen && (
          <InlineUpload
            product={{ id: currentNode.id, sku: currentNode.sku, name: currentNode.name }}
            currentUserEmail={currentUserEmail}
            onDone={() => {
              setUploadOpen(false)
              queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
              queryClient.invalidateQueries({ queryKey: ['product-documents', currentNode.id] })
            }}
            onCancel={() => setUploadOpen(false)}
          />
        )}

        {view === '' && (
          <>
            <div className="flex flex-wrap gap-2">
              <select
                value={brandCrumb?.id ?? ''}
                onChange={(e) => goTo(e.target.value || ROOT_ID)}
                aria-label={t('knowledgeCenter.filterBrand')}
                className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm"
              >
                <option value="">{t('knowledgeCenter.allBrands')}</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>{b.brand_name}</option>
                ))}
              </select>
              <select
                value={categoryCrumb?.id ?? ''}
                onChange={(e) => e.target.value && goTo(e.target.value)}
                disabled={!brandCrumb}
                aria-label={t('knowledgeCenter.filterCategory')}
                className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm disabled:opacity-50"
              >
                <option value="">{t('knowledgeCenter.allCategories')}</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.category_name}</option>
                ))}
              </select>
            </div>

            <form onSubmit={runSearch} className="flex flex-wrap gap-2">
              <div className="flex-1 min-w-[240px] relative">
                <input
                  type="search"
                  value={queryDraft}
                  onChange={(e) => setQueryDraft(e.target.value)}
                  placeholder={t('knowledgeCenter.searchPlaceholder')}
                  aria-label={t('knowledgeCenter.search')}
                  className="w-full ps-10 pe-3 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                />
                <SearchIcon />
              </div>
              <button
                type="submit"
                className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"
              >
                {t('knowledgeCenter.search')}
              </button>
              {(q || docType || status) && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="px-4 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2]"
                >
                  {t('knowledgeCenter.clear')}
                </button>
              )}
            </form>
          </>
        )}

        {view === 'trash' ? (
          <DocumentTrashList
            docs={trashDocs}
            loading={trashLoading}
            canEdit={canEdit}
            onRestore={restore}
            pathFor={trashCrumbPath}
            t={t}
          />
        ) : view === 'companyDocs' ? (
          <CompanyDocs
            currentUserEmail={currentUserEmail}
            currentUserRole={currentUserRole}
            currentUserPermissions={currentUserPermissions}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-[#9aa4b2]">
              <span>
                {flatMode
                  ? q
                    ? t('knowledgeCenter.resultsFor', { count: total, query: q })
                    : t('knowledgeCenter.documentCount', { count: total })
                  : t('knowledgeCenter.explorer.itemCount', { count: total })}
              </span>
              {unsearchableHere > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {t('knowledgeCenter.unsearchableNote', { count: unsearchableHere })}
                </span>
              )}
              {isFetching && <span>{t('common.loading')}</span>}
            </div>

            {flatMode ? (
              pageRows.length === 0 && !isFetching ? (
                <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]">
                  <EmptyStateBlock {...emptyProps} />
                </div>
              ) : (
                <div className="space-y-2">
                  {pageRows.map((row) => (
                    <DocumentRow key={row.id} doc={row.doc} showProduct query={q} onRemove={canEdit ? trashDoc : null} />
                  ))}
                </div>
              )
            ) : (
              <Table
                columns={columns}
                rows={pageRows}
                rowKey={(row) => row.id}
                onRowClick={(row) =>
                  row.kind === 'folder' ? goTo(row.node.id) : window.open(row.doc.file_url, '_blank', 'noopener,noreferrer')
                }
                empty={emptyProps}
                className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]"
              />
            )}

            {total > 0 && (
              <Pagination total={total} page={page} itemsPerPage={itemsPerPage} setItemsPerPage={setItemsPerPage} onPage={setPage} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

function SidebarHeading({ children }) {
  return (
    <div className="px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-gray-400 dark:text-[#9aa4b2]">
      {children}
    </div>
  )
}

/**
 * A top-level Browse row with nothing nested under it — Trash, Company Docs.
 * Same indentation as All Documents (both sit at the same level under
 * Browse), an invisible chevron-width spacer to line up with it anyway, and
 * no expand affordance since there is nothing here to expand.
 */
function SidebarLeafRow({ icon, label, count, active, onClick }) {
  return (
    <div
      className={`flex items-center gap-1 rounded-lg text-sm ${
        active ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'hover:bg-gray-50 dark:hover:bg-[#0f1520]'
      }`}
      style={{ paddingInlineStart: 8 }}
    >
      <span className="shrink-0 w-4 h-4 invisible" aria-hidden="true" />
      <button
        type="button"
        onClick={onClick}
        className={`flex-1 min-w-0 flex items-center justify-between gap-1.5 py-1.5 pe-2 text-start truncate ${
          active ? 'text-indigo-700 dark:text-[#a5b4fc] font-medium' : 'text-gray-700 dark:text-[#e8ebf0]'
        }`}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {count > 0 && <span className="shrink-0 text-[11px] text-gray-400 dark:text-[#6c7280]">{count}</span>}
      </button>
    </div>
  )
}

function SidebarChip({ active, label, count, warn, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sm text-start ${
        active
          ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-[#a5b4fc] font-medium'
          : 'text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#0f1520]'
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`shrink-0 text-[11px] ${
          warn && count > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-[#6c7280]'
        }`}
      >
        {count}
      </span>
    </button>
  )
}

/**
 * One row of the browse tree, recursing into its own children when expanded.
 *
 * Rendered outside `KnowledgeExplorer` rather than nested inside it so React
 * does not redefine the component (and drop its state) on every parent
 * re-render — a `TreeRow` folded 20 levels deep re-mounting itself on each
 * keystroke in the search box would be exactly that bug.
 */
function TreeRow({ node, depth, isRtl, currentId, expanded, onToggle, onSelect, t }) {
  const hasChildren = node.folders.length > 0
  const isOpen = expanded.has(node.id)
  const isActive = node.id === currentId

  return (
    <div>
      <div
        className={`flex items-center gap-1 rounded-lg text-sm ${
          isActive ? 'bg-indigo-50 dark:bg-indigo-900/20' : 'hover:bg-gray-50 dark:hover:bg-[#0f1520]'
        }`}
        style={{ paddingInlineStart: 8 + depth * 16 }}
      >
        <button
          type="button"
          onClick={() => hasChildren && onToggle(node.id)}
          aria-label={hasChildren ? (isOpen ? t('common.collapse') : t('common.expand')) : undefined}
          className={`shrink-0 w-4 h-4 flex items-center justify-center text-gray-400 dark:text-[#6c7280] ${
            hasChildren ? '' : 'invisible'
          }`}
        >
          <span aria-hidden="true" className="text-[10px]">
            {isOpen ? '▾' : isRtl ? '◂' : '▸'}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className={`flex-1 min-w-0 flex items-center gap-1.5 py-1.5 pe-2 text-start truncate ${
            isActive ? 'text-indigo-700 dark:text-[#a5b4fc] font-medium' : 'text-gray-700 dark:text-[#e8ebf0]'
          }`}
        >
          {node.kind === 'product' ? <DocIcon small /> : <FolderIcon small />}
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {hasChildren && isOpen && (
        <div>
          {node.folders.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              isRtl={isRtl}
              currentId={currentId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FolderIcon({ small }) {
  const size = small ? 'w-3.5 h-3.5' : 'w-4 h-4'
  return (
    <svg className={`${size} shrink-0 text-amber-500 dark:text-amber-400`} fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2 6a2 2 0 012-2h4l2 2h6a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function DocIcon({ small }) {
  const size = small ? 'w-3.5 h-3.5' : 'w-4 h-4'
  return (
    <svg className={`${size} shrink-0 text-indigo-500 dark:text-[#a5b4fc]`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
    </svg>
  )
}

function LibraryIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-gray-400 dark:text-[#9aa4b2]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20a1 1 0 001-1V4a1 1 0 00-1-1H6.5A2.5 2.5 0 004 5.5v14z" />
    </svg>
  )
}

function NewFolderIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m3-3H9M2 6a2 2 0 012-2h4l2 2h10a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg className="w-4 h-4 absolute start-3.5 top-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-gray-400 dark:text-[#9aa4b2]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
    </svg>
  )
}

function CompanyDocsIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-gray-400 dark:text-[#9aa4b2]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0H5m14 0h2M5 21H3m9-14h1m-1 4h1m-5-4h1m-1 4h1" />
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

/**
 * Uploading straight from a product's folder in the Vault — the same
 * extract/upload/create sequence Product Details uses (`documentUpload.js`),
 * so a document attached here shows up there identically and vice versa.
 */
function InlineUpload({ product, currentUserEmail, onDone, onCancel }) {
  const { t } = useTranslation()
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [pending, setPending] = useState(null)
  const [form, setForm] = useState({ title: '', docType: 'datasheet', description: '' })
  const [conflict, setConflict] = useState(null)

  const onPick = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPending(file)
    setForm((f) => ({ ...f, title: f.title || file.name.replace(/\.[^.]+$/, '') }))
  }

  const runUpload = async (resolvedConflict) => {
    setConflict(null)
    setBusy(true)
    try {
      if (resolvedConflict && !resolvedConflict.isTrashed) {
        await db.productDocuments.trash(resolvedConflict.existing.id, currentUserEmail)
      }
      const created = await uploadProductDocument({
        product,
        file: pending,
        title: form.title,
        docType: form.docType,
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

  const upload = async () => {
    if (!pending || !form.title.trim()) return
    const found = await findUploadConflict(product.id, form.docType)
    if (found) {
      setConflict({ ...found, run: () => runUpload(found) })
      return
    }
    await runUpload(null)
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
          <div className="sm:col-span-2">
            <Label required>{t('documents.title')}</Label>
            <Input
              aria-label={t('documents.title')}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('documents.type')}</Label>
            <Select
              aria-label={t('documents.type')}
              value={form.docType}
              onChange={(e) => setForm({ ...form, docType: e.target.value })}
            >
              {DOC_TYPES.map((d) => (
                <option key={d} value={d}>{t(`documents.type_${d}`)}</option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-3">
            <Label>{t('documents.description')}</Label>
            <Textarea
              aria-label={t('documents.description')}
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {!EXTRACTABLE_TYPES.includes(pending.type) && (
            <p className="sm:col-span-3 text-xs text-amber-600 dark:text-amber-400">
              {t('documents.notExtractable')}
            </p>
          )}

          <div className="sm:col-span-3 flex items-center justify-end gap-3">
            {stage && (
              <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t(`documents.stage_${stage}`)}</span>
            )}
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={upload} disabled={busy || !form.title.trim()}>
              {busy ? t('common.saving') : t('documents.upload')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!conflict}
        title={t('documents.conflictTitle')}
        message={
          conflict?.isTrashed
            ? t('documents.conflictTrashedMessage', { title: conflict.existing.title })
            : t('documents.conflictActiveMessage', { title: conflict?.existing.title })
        }
        confirmLabel={conflict?.isTrashed ? t('documents.conflictContinue') : t('documents.conflictReplace')}
        confirmClass="bg-indigo-600 hover:bg-indigo-700 text-white"
        onConfirm={() => conflict?.run()}
        onCancel={() => setConflict(null)}
      />
    </div>
  )
}
