import React from 'react'
import { groupByProduct } from './_shared'

// ─── Overview ──────────────────────────────────────────────────────────────────
export function OverviewTab({ stats: _stats, units, brands: _brands, brandMap, onNavigate }) {
  const brandGroups = groupByProduct(units, brandMap)
  const perBrand = {}
  for (const g of brandGroups) {
    const b = g.brand || 'Unknown'
    if (!perBrand[b]) perBrand[b] = { active: 0, stock: 0, sent: 0, total: 0 }
    perBrand[b].active += g.active_rma
    perBrand[b].stock += g.company_stock
    perBrand[b].sent += g.sent_to_manufacturer
    perBrand[b].total += g.units.length
  }
  return (
    <div className="space-y-4">
      {Object.keys(perBrand).length === 0 ? (
        <div className="text-center py-20 bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38]">
          <p className="text-gray-500 dark:text-[#9aa4b2] text-sm">No inventory data yet</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#121823] rounded-lg border border-gray-200 dark:border-[#212a38]">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-[#212a38] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0]">Stock by Brand</h3>
            <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">{units.length} total units</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-[#0f1520] border-b border-gray-100 dark:border-[#212a38]">
                <tr>
                  {['Brand', 'Active RMA', 'Company Stock', 'Sent to Mfr', 'Total'].map((h) => (
                    <th
                      key={h}
                      className="px-5 py-3 text-left text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-[#212a38]">
                {Object.entries(perBrand)
                  .sort((a, b) => b[1].total - a[1].total)
                  .map(([brand, cnt]) => (
                    <tr
                      key={brand}
                      className="hover:bg-gray-50 dark:hover:bg-[#1a2230] cursor-pointer transition-colors"
                      onClick={() => onNavigate('by-product')}
                    >
                      <td className="px-5 py-3 font-medium text-gray-900 dark:text-[#e8ebf0]">{brand}</td>
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                          {cnt.active}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                          {cnt.stock}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
                          {cnt.sent}
                        </span>
                      </td>
                      <td className="px-5 py-3 font-bold text-gray-800 dark:text-[#e8ebf0]">{cnt.total}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
