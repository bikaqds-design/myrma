import React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The shared pagination control.
 *
 * Lived in `pages/Inventory/_shared.jsx` despite being imported by sixteen
 * files across nine modules — so a page outside Inventory that needed paging
 * had to reach into another module's private file, or roll its own. Moved here
 * and re-exported from the old path so existing callers are unaffected.
 *
 * Dark mode was missing entirely: `text-gray-600`, `border-gray-300`,
 * `hover:bg-gray-50` with no dark variants, on every paged screen in the app.
 * Added here rather than sixteen times.
 *
 * The page-number window shows the first page, the last, and the two either
 * side of the current one, with an ellipsis across the gaps — so the control
 * stays the same width whether there are three pages or three hundred.
 *
 * Arrow direction is carried by the translated labels (`← Prev` / `Next →` in
 * English, `→ السابق` / `التالي ←` in Arabic), which is why they mirror
 * correctly without any logic here.
 */
export default function Pagination({ total, page, itemsPerPage, setItemsPerPage, onPage }) {
  const { t } = useTranslation()
  const pages = Math.ceil(total / itemsPerPage)
  const startIndex = (page - 1) * itemsPerPage

  const btn =
    'px-2.5 py-1.5 text-xs border border-gray-200 dark:border-[#212a38] rounded-lg ' +
    'text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#0f1520] ' +
    'disabled:opacity-40 disabled:cursor-not-allowed transition-colors'

  return (
    <div className="flex items-center justify-between text-sm text-gray-600 dark:text-[#9aa4b2] pt-2">
      <div>
        {t('inventory.showingRange', {
          from: total === 0 ? 0 : startIndex + 1,
          to: Math.min(startIndex + itemsPerPage, total),
          total,
        })}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm text-gray-600 dark:text-[#9aa4b2]">{t('inventory.perPage')}</label>
        <select
          aria-label={t('common.itemsPerPage')}
          value={itemsPerPage}
          onChange={(e) => {
            setItemsPerPage(parseInt(e.target.value))
            // Page 4 of 40 does not exist once the page size grows; go back to
            // the start rather than showing an empty table.
            onPage(1)
          }}
          className="px-3 py-1 border border-gray-300 dark:border-[#212a38] dark:bg-[#121823] dark:text-[#e8ebf0] rounded-lg focus:ring-2 focus:ring-indigo-600 text-sm"
        >
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>

        {pages > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page === 1} className={btn}>
              {t('inventory.prevPage')}
            </button>

            {Array.from({ length: pages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === pages || Math.abs(p - page) <= 1)
              .reduce((acc, p, i, arr) => {
                if (i > 0 && p - arr[i - 1] > 1) acc.push('…')
                acc.push(p)
                return acc
              }, [])
              .map((p, i) =>
                p === '…' ? (
                  <span key={`e${i}`} className="px-1 text-gray-500 dark:text-[#9aa4b2] text-xs">
                    …
                  </span>
                ) : (
                  <button
                    key={p}
                    onClick={() => onPage(p)}
                    aria-current={p === page ? 'page' : undefined}
                    className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                      p === page
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:bg-gray-50 dark:hover:bg-[#0f1520]'
                    }`}
                  >
                    {p}
                  </button>
                )
              )}

            <button
              onClick={() => onPage(Math.min(pages, page + 1))}
              disabled={page === pages}
              className={btn}
            >
              {t('inventory.nextPage')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
