import React, { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import toast from 'react-hot-toast'
import { safeStorage } from '../../lib/safeStorage'
import { useConfirm } from '../../hooks/useConfirm'

const SURFACE = 'bg-white dark:bg-[#121823]'
const BORDER = 'border-[#e6e9ef] dark:border-[#212a38]'

// The arrows are the only signal that a column is sortable, so they are treated
// as content rather than decoration. text-gray-400 measured 2.41:1 in light and
// the unsorted arrow was #2a3441 in dark, 1.45:1 — effectively invisible against
// the header it sits in. indigo-500 for the active arrow was 4.24, also short.
function SortIcon({ col, sortCol, sortDir }) {
  if (col !== sortCol)
    return <span className="text-gray-600 dark:text-[#7c8ba5] ml-1 text-[10px]">↕</span>
  return (
    <span className="text-indigo-600 dark:text-[#a5b4fc] ml-1 text-[10px]">
      {sortDir === 'asc' ? '↑' : '↓'}
    </span>
  )
}

const OPEN_STAGE_COLORS = [
  'bg-violet-100 dark:bg-violet-900/20 text-violet-700 dark:text-violet-400 hover:bg-violet-200 dark:hover:bg-violet-900/40',
  'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/40',
  'bg-cyan-100 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-400 hover:bg-cyan-200 dark:hover:bg-cyan-900/40',
  'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/40',
  'bg-orange-100 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-900/40',
  'bg-pink-100 dark:bg-pink-900/20 text-pink-700 dark:text-pink-300 hover:bg-pink-200 dark:hover:bg-pink-900/40',
  'bg-teal-100 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 hover:bg-teal-200 dark:hover:bg-teal-900/40',
  'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-900/40',
]

const OPEN_STAGE_DOTS = [
  'bg-violet-500', 'bg-blue-500', 'bg-cyan-500', 'bg-amber-500',
  'bg-orange-500', 'bg-pink-500', 'bg-teal-500', 'bg-indigo-500',
]

function StagePin({ deal, stages, stageMap, open, onToggle, onMove }) {
  const stage = stageMap[deal.stage]
  const openStages = stages.filter((s) => !s.is_won && !s.is_lost)
  const stageIndex = openStages.findIndex((s) => s.id === deal.stage)
  const colorClass =
    stage?.is_won
      ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
      : stage?.is_lost
        ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300'
        : OPEN_STAGE_COLORS[stageIndex >= 0 ? stageIndex % OPEN_STAGE_COLORS.length : 0]

  return (
    <div className="relative stage-pin-root">
      <button
        onClick={(e) => { e.stopPropagation(); onToggle(deal.id) }}
        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${colorClass}`}
      >
        {stage?.name || '—'}
        {!stage?.is_won && !stage?.is_lost && (
          <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
      {open && (
        <div className="absolute z-30 top-full left-0 mt-1 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-xl shadow-lg py-1 min-w-[160px]">
          {openStages.map((s, si) => (
            <button
              key={s.id}
              onClick={(e) => { e.stopPropagation(); onMove(deal.id, s.id) }}
              className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] transition-colors ${
                s.id === deal.stage ? 'font-semibold text-[#211f1b] dark:text-[#e8ebf0]' : 'text-[#211f1b] dark:text-[#e8ebf0]'
              }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${OPEN_STAGE_DOTS[si % OPEN_STAGE_DOTS.length]}`} />
              {s.name}
              {s.id === deal.stage && <span className="ml-auto text-[#4338ca] dark:text-[#a5b4fc]">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PipelineListView({
  deals,
  stages,
  customerMap,
  selectedDeals,
  onSelectedChange,
  onMoveStage,
  onBulkMoveStage,
  onBulkDelete,
  isAdmin,
}) {
  const { t } = useTranslation()
  const { confirm, confirmDialog } = useConfirm()
  const navigate = useNavigate()

  const [sortCol, setSortCol] = useState('created_at')
  const [sortDir, setSortDir] = useState('desc')
  const [openStagePinId, setOpenStagePinId] = useState(null)
  const [bulkStage, setBulkStage] = useState('')

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(() => safeStorage.get('pipelineListPerPage', 25))
  const [jumpToPage, setJumpToPage] = useState('')

  const stageMap = useMemo(() => Object.fromEntries(stages.map((s) => [s.id, s])), [stages])
  const openStages = useMemo(() => stages.filter((s) => !s.is_won && !s.is_lost), [stages])

  useEffect(() => {
    safeStorage.set('pipelineListPerPage', itemsPerPage)
  }, [itemsPerPage])

  // Reset to page 1 when the deals list changes (filter/search applied in parent)
  useEffect(() => {
    setCurrentPage(1)
  }, [deals])

  const sorted = useMemo(() => {
    return [...deals].sort((a, b) => {
      let av = a[sortCol]
      let bv = b[sortCol]
      if (sortCol === 'value') {
        av = Number(av) || 0
        bv = Number(bv) || 0
      } else {
        av = av ?? ''
        bv = bv ?? ''
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [deals, sortCol, sortDir])

  const handleSort = (col) => {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortCol(col); setSortDir('asc') }
  }

  const totalPages = Math.ceil(sorted.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = Math.min(startIndex + itemsPerPage, sorted.length)
  const paged = sorted.slice(startIndex, endIndex)

  const handlePageChange = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleJumpToPage = () => {
    const pageNum = parseInt(jumpToPage)
    if (pageNum >= 1 && pageNum <= totalPages) {
      handlePageChange(pageNum)
      setJumpToPage('')
    } else {
      toast.error(t('pipeline.pageMustBeBetween', { total: totalPages }))
    }
  }

  const renderPageNumbers = () => {
    const pages = []
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i)
    } else if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    } else if (currentPage >= totalPages - 3) {
      pages.push(1)
      pages.push('...')
      for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i)
    } else {
      pages.push(1)
      pages.push('...')
      for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i)
      pages.push('...')
      pages.push(totalPages)
    }
    return pages.map((p, i) =>
      p === '...' ? (
        <span key={`e${i}`} className="px-2 text-[#6c6760] dark:text-[#9aa4b2]">…</span>
      ) : (
        <button
          key={p}
          onClick={() => handlePageChange(p)}
          className={`w-8 h-8 rounded text-sm ${currentPage === p ? 'bg-[#4338ca] text-white' : 'text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230]'}`}
        >
          {p}
        </button>
      )
    )
  }

  // Close stage pin only when clicking outside any .stage-pin-root container
  React.useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.stage-pin-root')) setOpenStagePinId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const totalValue = sorted.reduce((s, d) => s + (Number(d.value) || 0), 0)
  const allSelected = paged.length > 0 && paged.every((d) => selectedDeals.has(d.id))

  const handleSelectAll = (checked) => {
    const next = new Set(selectedDeals)
    paged.forEach((d) => { if (checked) next.add(d.id); else next.delete(d.id) })
    onSelectedChange(next)
  }
  const handleSelectOne = (id, checked) => {
    const next = new Set(selectedDeals)
    if (checked) next.add(id)
    else next.delete(id)
    onSelectedChange(next)
  }

  const handleBulkStageChange = async (stageId) => {
    if (!stageId) return
    await onBulkMoveStage([...selectedDeals], stageId)
    onSelectedChange(new Set())
    setBulkStage('')
  }

  const handleBulkDelete = () => {
    const count = selectedDeals.size
    confirm({
      title: t('pipeline.bulkDeleteTitle', { count }),
      message: t('pipeline.bulkDeleteConfirm', { count }),
      onConfirm: async () => {
        await onBulkDelete([...selectedDeals])
        onSelectedChange(new Set())
      },
    })
  }

  const COLS = [
    { key: 'title', label: t('pipeline.dealTitle') },
    { key: 'customer_id', label: t('pipeline.customer') },
    { key: 'stage', label: t('pipeline.stage') },
    { key: 'value', label: t('pipeline.listValue'), right: true },
    { key: 'assigned_rep', label: t('pipeline.listRep') },
    { key: 'created_at', label: t('common.createdAt') },
  ]

  // checkbox + # + code + 6 COLS = 9 total
  const totalCols = COLS.length + 3

  return (
    <div className="space-y-3">
      {/* Bulk action bar */}
      {selectedDeals.size > 0 && (
        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-[#4338ca]/20 dark:border-[#a5b4fc]/20 rounded-[14px] px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc]">
            {selectedDeals.size} {t('common.selected')}
          </span>
          <div className="w-px h-5 bg-[#4338ca]/20 dark:bg-[#a5b4fc]/20" />
          {/* Change stage */}
          <select
            value={bulkStage}
            onChange={(e) => handleBulkStageChange(e.target.value)}
            className="text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg px-2 py-1.5 bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent"
          >
            <option value="">{t('pipeline.bulkChangeStage')}</option>
            {openStages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {/* Delete — admin only */}
          {isAdmin && (
            <button
              onClick={handleBulkDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors border border-red-200 dark:border-red-800"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {t('common.delete')}
            </button>
          )}
          <button
            onClick={() => onSelectedChange(new Set())}
            className="ml-auto text-xs text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0]"
          >
            {t('common.clear')}
          </button>
        </div>
      )}

      {/* Table */}
      <div className={`${SURFACE} border ${BORDER} rounded-[14px]`}>
        {/* Count + per-page row */}
        <div className={`px-5 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-b ${BORDER}`}>
          <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
            {t('pipeline.showingRange', { from: sorted.length === 0 ? 0 : startIndex + 1, to: endIndex, total: sorted.length })}
            {' · '}
            {totalValue.toLocaleString()} {t('pipeline.currency')}
            {selectedDeals.size > 0 && (
              <span className="ml-2 text-[#4338ca] dark:text-[#a5b4fc] font-medium">
                · {selectedDeals.size} {t('common.selected')}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <label className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.itemsPerPage')}:</label>
            <select
              aria-label={t('common.itemsPerPage')}
              value={itemsPerPage}
              onChange={(e) => setItemsPerPage(parseInt(e.target.value))}
              className={`px-3 py-1 border ${BORDER} rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent`}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={`border-b ${BORDER} bg-[#f8f9fb] dark:bg-[#0f1520]`}>
                <th className="pl-4 pr-2 py-3 w-8">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                    checked={allSelected}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    aria-label={t('common.selectAll')}
                  />
                </th>
                <th className="px-2 py-3 text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] text-left w-10 select-none">#</th>
                <th className="px-2 py-3 text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] text-left w-32 select-none whitespace-nowrap">
                  {t('common.code')}
                </th>
                {COLS.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`px-4 py-3 text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2] cursor-pointer hover:text-[#211f1b] dark:hover:text-[#e8ebf0] select-none whitespace-nowrap ${
                      col.right ? 'text-right' : 'text-left'
                    }`}
                  >
                    {col.label}
                    <SortIcon col={col.key} sortCol={sortCol} sortDir={sortDir} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.length === 0 ? (
                <tr>
                  <td colSpan={totalCols} className="px-4 py-10 text-center text-sm text-[#6c6760] dark:text-[#9aa4b2]">
                    {t('pipeline.listEmpty')}
                  </td>
                </tr>
              ) : (
                paged.map((deal, ri) => {
                  const cust = customerMap[deal.customer_id]
                  const isSelected = selectedDeals.has(deal.id)
                  return (
                    <tr
                      key={deal.id}
                      onClick={() => navigate(`/pipeline/${deal.id}`)}
                      className={`border-t ${BORDER} cursor-pointer hover:bg-[#f8f9fb] dark:hover:bg-[#0f1520] transition-colors ${
                        isSelected
                          ? 'bg-indigo-50/50 dark:bg-indigo-900/10'
                          : ri % 2 === 1
                          ? 'bg-[#fafbfc] dark:bg-[#0d1119]'
                          : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="pl-4 pr-2 py-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="rounded border-gray-300 dark:border-[#212a38] text-indigo-600 focus:ring-indigo-500"
                          checked={isSelected}
                          onChange={(e) => handleSelectOne(deal.id, e.target.checked)}
                          aria-label={t('common.selectRow', { name: deal.title })}
                        />
                      </td>
                      {/* Row number */}
                      <td className="px-2 py-3 text-xs text-[#746f65] dark:text-[#a4acb7] font-mono">{startIndex + ri + 1}</td>
                      {/* Deal code */}
                      <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => navigate(`/pipeline/${deal.id}`)}
                          className="text-xs font-mono font-semibold text-[#4338ca] dark:text-[#a5b4fc] hover:underline"
                        >
                          {deal.deal_code || '—'}
                        </button>
                      </td>
                      {/* Title */}
                      <td className="px-4 py-3 font-medium text-[#211f1b] dark:text-[#e8ebf0] max-w-[220px]">
                        <span className="line-clamp-1">{deal.title}</span>
                      </td>
                      {/* Customer */}
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2] max-w-[180px]">
                        <span className="line-clamp-1">
                          {cust?.company_name || cust?.contact_person || '—'}
                        </span>
                      </td>
                      {/* Stage — pin dropdown */}
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <StagePin
                          deal={deal}
                          stages={stages}
                          stageMap={stageMap}
                          open={openStagePinId === deal.id}
                          onToggle={(id) => setOpenStagePinId((prev) => (prev === id ? null : id))}
                          onMove={(dealId, stageId) => { onMoveStage(dealId, stageId); setOpenStagePinId(null) }}
                        />
                      </td>
                      {/* Value */}
                      <td className="px-4 py-3 font-medium text-[#211f1b] dark:text-[#e8ebf0] text-right whitespace-nowrap">
                        {deal.value != null
                          ? `${Number(deal.value).toLocaleString()} ${t('pipeline.currency')}`
                          : '—'}
                      </td>
                      {/* Rep */}
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2] text-xs">
                        {deal.assigned_rep || '—'}
                      </td>
                      {/* Created at */}
                      <td className="px-4 py-3 text-[#6c6760] dark:text-[#9aa4b2] text-xs whitespace-nowrap">
                        {deal.created_at ? new Date(deal.created_at).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
            {sorted.length > 0 && (
              <tfoot>
                <tr className={`border-t-2 ${BORDER} bg-[#f8f9fb] dark:bg-[#0f1520]`}>
                  {/* checkbox + # + code + title + customer + stage = 6 */}
                  <td colSpan={6} className="px-4 py-2.5 text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2]">
                    {t('pipeline.listTotal')} ({sorted.length})
                  </td>
                  {/* value — always shows grand total for all filtered deals */}
                  <td className="px-4 py-2.5 text-xs font-semibold text-[#211f1b] dark:text-[#e8ebf0] text-right whitespace-nowrap">
                    {totalValue.toLocaleString()} {t('pipeline.currency')}
                  </td>
                  {/* rep + created_at */}
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {/* Pagination footer */}
        {totalPages > 1 && (
          <div className={`flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-3 border-t ${BORDER}`}>
            <div className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">
              {t('pipeline.showingRange', { from: startIndex + 1, to: endIndex, total: sorted.length })}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
                className={`px-3 py-2 border ${BORDER} rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
              >
                {t('common.previous')}
              </button>
              <div className="flex items-center gap-1">{renderPageNumbers()}</div>
              <button
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === totalPages}
                className={`px-3 py-2 border ${BORDER} rounded-lg text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
              >
                {t('common.next')}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('common.jumpToPage')}:</span>
              <input
                type="number"
                min="1"
                max={totalPages}
                aria-label={t('common.jumpToPage')}
                value={jumpToPage}
                onChange={(e) => setJumpToPage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJumpToPage()}
                placeholder={currentPage.toString()}
                className={`w-20 px-3 py-1 border ${BORDER} rounded-lg text-sm bg-white dark:bg-[#121823] text-[#211f1b] dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent`}
              />
              <button
                onClick={handleJumpToPage}
                className="px-3 py-1 bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] rounded-lg hover:opacity-90 text-sm transition-opacity"
              >
                {t('common.go')}
              </button>
            </div>
          </div>
        )}
      </div>
      {confirmDialog}
    </div>
  )
}
