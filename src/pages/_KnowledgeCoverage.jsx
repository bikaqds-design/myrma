import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { db } from '../api/supabaseClient'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import EmptyState from '../components/EmptyState'

/**
 * Which products have no document, and which have one nobody can search.
 *
 * ── Why this is a page and not a number ─────────────────────────────────────
 *
 * The Knowledge Center is only as good as what has been put into it, and the
 * gaps are invisible from the search: a product with no datasheet simply never
 * appears, which is indistinguishable from a product whose datasheet does not
 * mention what you searched for. Left alone, the team slowly learns not to
 * trust the search — the worst outcome for the whole module.
 *
 * A list of exactly what is missing turns that into an afternoon's work.
 *
 * ── Why "not searchable" is counted separately ──────────────────────────────
 *
 * A scanned datasheet is a picture of text. The product looks covered on any
 * count of documents, and answers nothing. Those need a different fix — a
 * text-based file from the vendor — so they are their own list rather than
 * being folded in with the products that have nothing at all.
 */
export default function KnowledgeCoverage() {
  const { t } = useTranslation()
  const [brandId, setBrandId] = useState('')
  const [view, setView] = useState('missing')

  const { data: products = EMPTY_ARRAY, isLoading: loadingProducts } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 5 * 60_000,
  })
  const { data: brands = EMPTY_ARRAY } = useQuery({
    queryKey: ['brands'],
    queryFn: () => db.brands.list(),
    staleTime: 10 * 60_000,
  })
  const { data: docsRes, isLoading: loadingDocs } = useQuery({
    queryKey: ['document-coverage'],
    queryFn: () => db.productDocuments.listAll(),
  })

  const docs = docsRes?.data ?? EMPTY_ARRAY

  const { missing, unsearchable, covered } = useMemo(() => {
    const withAny = new Set()
    const withSearchable = new Set()
    for (const d of docs) {
      withAny.add(d.product_id)
      if (d.extraction_status === 'ok') withSearchable.add(d.product_id)
    }
    const scoped = brandId ? products.filter((p) => p.brand_id === brandId) : products
    return {
      missing: scoped.filter((p) => !withAny.has(p.id)),
      // Has documents, but not one of them can be read. Distinct from missing.
      unsearchable: scoped.filter((p) => withAny.has(p.id) && !withSearchable.has(p.id)),
      covered: scoped.filter((p) => withSearchable.has(p.id)),
    }
  }, [products, docs, brandId])

  const total = missing.length + unsearchable.length + covered.length
  const pct = total === 0 ? 0 : Math.round((covered.length / total) * 100)

  if (loadingProducts || loadingDocs) {
    return <div className="py-16 text-center text-sm text-gray-500">{t('common.loading')}</div>
  }

  if (docsRes?.missing) {
    return (
      <EmptyState
        title={t('knowledgeCenter.notProvisioned')}
        description={t('knowledgeCenter.notProvisionedHint')}
      />
    )
  }

  const listed = view === 'missing' ? missing : unsearchable

  const cards = [
    { id: 'covered', n: covered.length, label: t('coverage.covered'), tone: 'text-green-600 dark:text-green-400' },
    { id: 'missing', n: missing.length, label: t('coverage.missing'), tone: 'text-amber-600 dark:text-amber-400' },
    { id: 'unsearchable', n: unsearchable.length, label: t('coverage.unsearchable'), tone: 'text-red-600 dark:text-red-400' },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {t('coverage.headline', { pct })}
          </p>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
            {t('coverage.headlineHint', { covered: covered.length, total })}
          </p>
        </div>
        <select
          value={brandId}
          onChange={(e) => setBrandId(e.target.value)}
          aria-label={t('knowledgeCenter.filterBrand')}
          className="px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg text-sm"
        >
          <option value="">{t('knowledgeCenter.allBrands')}</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>{b.brand_name}</option>
          ))}
        </select>
      </div>

      {/* A bar rather than three numbers: the point is the proportion, and how
          much of it is the wrong colour. */}
      <div className="flex h-2 rounded-full overflow-hidden bg-gray-100 dark:bg-[#1a2230]">
        {total > 0 && (
          <>
            <div className="bg-green-500" style={{ width: `${(covered.length / total) * 100}%` }} />
            <div className="bg-amber-400" style={{ width: `${(missing.length / total) * 100}%` }} />
            <div className="bg-red-500" style={{ width: `${(unsearchable.length / total) * 100}%` }} />
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {cards.map((c) => {
          const selectable = c.id !== 'covered'
          return (
            <button
              key={c.id}
              type="button"
              disabled={!selectable}
              onClick={() => selectable && setView(c.id)}
              className={`text-start bg-white dark:bg-[#121823] border rounded-[14px] p-4 ${
                selectable && view === c.id
                  ? 'border-indigo-400'
                  : 'border-[#e6e9ef] dark:border-[#212a38]'
              } ${selectable ? 'cursor-pointer hover:border-indigo-300' : 'cursor-default'}`}
            >
              <p className={`text-2xl font-semibold ${c.tone}`}>{c.n}</p>
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">{c.label}</p>
            </button>
          )
        })}
      </div>

      <div>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-2">
          {view === 'missing' ? t('coverage.missingHint') : t('coverage.unsearchableHint')}
        </p>

        {listed.length === 0 ? (
          <EmptyState
            title={t('coverage.nothingToDo')}
            description={t('coverage.nothingToDoHint')}
          />
        ) : (
          <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] divide-y divide-[#e6e9ef] dark:divide-[#212a38]">
            {listed.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 dark:text-[#e8ebf0] truncate">
                    {p.product_name}
                  </p>
                  <p className="text-[11px] text-gray-400 dark:text-[#9aa4b2]">{p.sku}</p>
                </div>
                {/* Straight to the tab that fixes it, rather than leaving
                    someone to navigate there themselves. */}
                <Link
                  to={`/products/${p.id}?tab=documents`}
                  className="shrink-0 text-xs text-indigo-600 dark:text-[#a5b4fc] hover:underline"
                >
                  {t('coverage.addDocument')}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
