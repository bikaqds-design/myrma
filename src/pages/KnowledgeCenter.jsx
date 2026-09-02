import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../api/supabaseClient'
import { PageHeader } from '../components/ui'
import EmptyState from '../components/EmptyState'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import { DocumentRow } from '../components/ProductDocuments'
import { DOC_TYPES } from '../lib/documentTypes'
import KnowledgeChat from './_KnowledgeChat'
import KnowledgeUpload from './_KnowledgeUpload'
import KnowledgeCoverage from './_KnowledgeCoverage'

/**
 * The Knowledge Center — every product document in one searchable place.
 *
 * ── The design decision behind the layout ────────────────────────────────────
 *
 * The obvious shape for this is a folder tree by product. It is also the wrong
 * one: nobody opens this page knowing which product they want. They open it
 * knowing a symptom, a part number, or a phrase from a spec. So search is the
 * page, and the filters narrow it rather than framing it.
 *
 * ── Why the filters are collapsed by default ─────────────────────────────────
 *
 * Most visits are a search and nothing else. A row of five dropdowns above the
 * box makes the common case look like work; behind a "Filters" toggle that
 * shows a count when any are active, it stays available without being in the
 * way.
 *
 * ── Why the extraction status is on screen ───────────────────────────────────
 *
 * A scanned datasheet is a picture of text and cannot be searched. If those
 * documents simply never appeared in results, the team would slowly learn not
 * to trust the search. Showing which are unsearchable — and letting you filter
 * to exactly those — turns the gap into a worklist.
 */
export default function KnowledgeCenter({ currentUserEmail }) {
  const { t } = useTranslation()
  // Search first, not chat. Search is instant, free and exact; the chat is
  // slower, costs a request and can be wrong. Someone who knows the part
  // number should not be made to converse about it.
  const [mode, setMode] = useState('search')
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState({
    brandId: '',
    categoryId: '',
    docType: '',
    searchableOnly: false,
  })

  // Sent to the server; empty strings are "no filter" and must not become
  // `.eq('brand_id', '')`, which matches nothing.
  const applied = useMemo(
    () => ({
      brandId: filters.brandId || null,
      categoryId: filters.categoryId || null,
      docType: filters.docType || null,
      searchableOnly: filters.searchableOnly,
    }),
    [filters]
  )
  const activeCount = useMemo(
    () => Object.values(applied).filter((v) => v !== null && v !== false).length,
    [applied]
  )

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

  // Categories belong to a brand, so once a brand is chosen the category list
  // narrows with it. Offering categories from other brands would produce
  // combinations that can only ever return nothing.
  const visibleCategories = useMemo(
    () =>
      applied.brandId
        ? categories.filter((c) => c.brand_id === applied.brandId)
        : categories,
    [categories, applied.brandId]
  )

  // With no brand chosen, the same category NAME exists once per brand —
  // "Monitors" under two brands is two different rows with two different ids.
  // A flat list shows them as inexplicable duplicates; collapsing them by name
  // would break the filter, because each option has to carry one id. So the
  // list is grouped under brand headings instead, which is also the honest
  // picture of the data.
  const groupedCategories = useMemo(() => {
    if (applied.brandId) return null
    const byBrand = new Map(brands.map((b) => [b.id, b.brand_name]))
    const groups = new Map()
    for (const c of visibleCategories) {
      const label = byBrand.get(c.brand_id) ?? ''
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push(c)
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [applied.brandId, brands, visibleCategories])

  const { data: res, isLoading, isFetching } = useQuery({
    queryKey: ['knowledge-center', submitted, applied],
    queryFn: () =>
      submitted
        ? db.productDocuments.search(submitted, applied)
        : db.productDocuments.listAll(applied),
  })

  // Unfiltered, so the "N cannot be searched inside" line describes the library
  // rather than the current view — a count that moved with the filters would
  // suggest filtering had fixed something.
  const { data: allRes } = useQuery({
    queryKey: ['knowledge-center', 'library'],
    queryFn: () => db.productDocuments.listAll(),
  })

  const shown = res?.data ?? EMPTY_ARRAY
  const missing = res?.missing
  const unsearchable = useMemo(
    () => (allRes?.data ?? EMPTY_ARRAY).filter((d) => d.extraction_status !== 'ok').length,
    [allRes]
  )

  const runSearch = (e) => {
    e?.preventDefault()
    setSubmitted(query.trim())
  }

  const clearAll = () => {
    setQuery('')
    setSubmitted('')
    setFilters({ brandId: '', categoryId: '', docType: '', searchableOnly: false })
  }

  const setFilter = (key, value) =>
    setFilters((f) => ({
      ...f,
      [key]: value,
      // Changing brand invalidates a category that belonged to the old one.
      ...(key === 'brandId' ? { categoryId: '' } : {}),
    }))

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-gray-500">{t('common.loading')}</div>
  }

  if (missing) {
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

  const selectCls =
    'px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm w-full'

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <PageHeader title={t('knowledgeCenter.title')} subtitle={t('knowledgeCenter.subtitle')} />

      <div className="flex gap-1 border-b border-gray-200 dark:border-[#212a38]">
        {[
          { id: 'search', label: t('knowledgeCenter.modeSearch') },
          { id: 'chat', label: t('knowledgeCenter.modeChat') },
          { id: 'upload', label: t('knowledgeCenter.modeUpload') },
          { id: 'coverage', label: t('knowledgeCenter.modeCoverage') },
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

      {mode === 'chat' && <KnowledgeChat />}
      {mode === 'upload' && <KnowledgeUpload currentUserEmail={currentUserEmail} />}
      {mode === 'coverage' && <KnowledgeCoverage />}

      {mode === 'search' && (
        <>
          <form onSubmit={runSearch} className="flex flex-wrap gap-2">
            <div className="flex-1 min-w-[240px] relative">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('knowledgeCenter.searchPlaceholder')}
                aria-label={t('knowledgeCenter.search')}
                className="w-full ps-10 pe-3 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
              />
              <svg className="w-4 h-4 absolute start-3.5 top-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
              </svg>
            </div>
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              className={`px-4 py-2.5 border rounded-lg text-sm font-medium ${
                activeCount > 0
                  ? 'border-indigo-400 text-indigo-600 dark:text-[#a5b4fc]'
                  : 'border-[#e6e9ef] dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2]'
              }`}
            >
              {t('knowledgeCenter.filters')}
              {activeCount > 0 && <span className="ms-1">({activeCount})</span>}
            </button>
            <button
              type="submit"
              className="px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              {t('knowledgeCenter.search')}
            </button>
            {(submitted || activeCount > 0) && (
              <button
                type="button"
                onClick={clearAll}
                className="px-4 py-2.5 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm text-gray-600 dark:text-[#9aa4b2]"
              >
                {t('knowledgeCenter.clear')}
              </button>
            )}
          </form>

          {showFilters && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 p-4 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]">
              <div>
                <label className="block text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">
                  {t('knowledgeCenter.filterBrand')}
                </label>
                <select
                  value={filters.brandId}
                  onChange={(e) => setFilter('brandId', e.target.value)}
                  aria-label={t('knowledgeCenter.filterBrand')}
                  className={selectCls}
                >
                  <option value="">{t('knowledgeCenter.allBrands')}</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.brand_name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">
                  {t('knowledgeCenter.filterCategory')}
                </label>
                <select
                  value={filters.categoryId}
                  onChange={(e) => setFilter('categoryId', e.target.value)}
                  aria-label={t('knowledgeCenter.filterCategory')}
                  className={selectCls}
                >
                  <option value="">{t('knowledgeCenter.allCategories')}</option>
                  {groupedCategories
                    ? groupedCategories.map(([brandName, cats]) => (
                        <optgroup key={brandName || '—'} label={brandName || '—'}>
                          {cats.map((c) => (
                            <option key={c.id} value={c.id}>{c.category_name}</option>
                          ))}
                        </optgroup>
                      ))
                    : visibleCategories.map((c) => (
                        <option key={c.id} value={c.id}>{c.category_name}</option>
                      ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] mb-1">
                  {t('documents.type')}
                </label>
                <select
                  value={filters.docType}
                  onChange={(e) => setFilter('docType', e.target.value)}
                  aria-label={t('documents.type')}
                  className={selectCls}
                >
                  <option value="">{t('knowledgeCenter.allTypes')}</option>
                  {DOC_TYPES.map((d) => (
                    <option key={d} value={d}>{t(`documents.type_${d}`)}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-[#e8ebf0] pb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={filters.searchableOnly}
                    onChange={(e) => setFilter('searchableOnly', e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  {t('knowledgeCenter.filterSearchableOnly')}
                </label>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-[#9aa4b2]">
            <span>
              {submitted
                ? t('knowledgeCenter.resultsFor', { count: shown.length, query: submitted })
                : t('knowledgeCenter.documentCount', { count: shown.length })}
            </span>
            {unsearchable > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {t('knowledgeCenter.unsearchableNote', { count: unsearchable })}
              </span>
            )}
          </div>

          {isFetching && (
            <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('common.loading')}</p>
          )}

          {!isFetching && shown.length === 0 ? (
            submitted || activeCount > 0 ? (
              <EmptyState
                title={
                  submitted
                    ? t('knowledgeCenter.noResults', { query: submitted })
                    : t('knowledgeCenter.noneMatchFilters')
                }
                description={t('knowledgeCenter.noResultsHint')}
              />
            ) : (
              <EmptyState
                title={t('knowledgeCenter.empty')}
                description={t('knowledgeCenter.emptyHint')}
              />
            )
          ) : (
            <div className="space-y-2">
              {shown.map((d) => (
                <DocumentRow key={d.id} doc={d} showProduct query={submitted} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
