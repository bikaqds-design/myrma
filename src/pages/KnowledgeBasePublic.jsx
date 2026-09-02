import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { db, branding as brandingAPI } from '../api/supabaseClient'

export default function KnowledgeBasePublic() {
  const { t } = useTranslation()
  const [branding, setBranding] = useState(null)
  const [articles, setArticles] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    brandingAPI
      .getBranding()
      .then(setBranding)
      .catch(() => {})
    db.kbArticles
      .listPublished()
      .then((result) => setArticles(result.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const primaryColor = branding?.primary_color || '#4F46E5'
  const companyName = branding?.company_name || 'myCRM'

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return articles
    return articles.filter(
      (a) => a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q)
    )
  }, [articles, query])

  const grouped = useMemo(() => {
    const buckets = new Map()
    for (const a of filtered) {
      if (!buckets.has(a.category)) buckets.set(a.category, [])
      buckets.get(a.category).push(a)
    }
    return [...buckets.entries()]
  }, [filtered])

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-3">
          {branding?.logo_url ? (
            <img src={branding.logo_url} alt={companyName} className="h-9 object-contain" />
          ) : (
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm"
              style={{ backgroundColor: primaryColor }}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s4.832.477 6 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                />
              </svg>
            </div>
          )}
          <div>
            <div className="font-bold text-gray-900 text-lg leading-tight">{companyName}</div>
            <div className="text-xs text-gray-500">{t('kb.headerSubtitle')}</div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-10 space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-900">{t('kb.title')}</h1>
          <p className="text-gray-500">{t('kb.subtitle')}</p>
        </div>

        <div className="max-w-xl mx-auto">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('kb.searchPlaceholder')}
            aria-label={t('kb.searchPlaceholder')}
            className="w-full px-4 py-3 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent shadow-sm"
          />
        </div>

        {loading && (
          <div className="flex justify-center py-10">
            <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-10 space-y-2">
            <div className="text-5xl">🔍</div>
            <p className="text-gray-700 font-medium">{t('kb.noResults')}</p>
          </div>
        )}

        {!loading &&
          grouped.map(([category, items]) => (
            <div key={category} className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                {category}
              </h2>
              <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 shadow-sm overflow-hidden">
                {items.map((a) => {
                  const isOpen = openId === a.id
                  return (
                    <div key={a.id}>
                      <button
                        onClick={() => setOpenId(isOpen ? null : a.id)}
                        aria-expanded={isOpen}
                        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-start hover:bg-gray-50 transition-colors"
                      >
                        <span className="font-medium text-gray-900 text-sm">{a.title}</span>
                        <svg
                          className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {isOpen && (
                        <div className="px-5 pb-4 text-sm text-gray-600 whitespace-pre-wrap">{a.body}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

        <div className="text-center pt-4">
          <a href="/tracker" className="text-sm text-indigo-600 hover:text-indigo-700 font-medium">
            {t('kb.backToTracker')}
          </a>
        </div>
      </main>
    </div>
  )
}
