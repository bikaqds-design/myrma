import React from 'react'
import i18next from 'i18next'

/**
 * Announces a loading region the way `Spinner` does (`role="status"`), so
 * swapping a spinner for a skeleton does not make loading silent to a screen
 * reader. The pulses themselves are decorative.
 */
function LoadingRegion({ className = '', children }) {
  return (
    <div role="status" aria-busy="true" aria-label={i18next.t('common.loading')} className={className}>
      {children}
    </div>
  )
}

function Pulse({ className }) {
  return (
    <div
      className={`animate-pulse bg-[#e6e9ef] dark:bg-[#212a38] rounded-lg ${className}`}
    />
  )
}

export function TableSkeleton({ rows = 8, cols = 5 }) {
  const widths = ['w-6', 'w-28', 'w-20', 'w-16', 'w-14', 'w-10']
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-[#e6e9ef] dark:border-[#212a38]">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <Pulse className={`h-4 ${widths[j % widths.length]}`} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

export function StatCardSkeleton({ count = 4 }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-${count} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-[18px]"
        >
          <div className="flex items-center justify-between">
            <div className="space-y-2.5">
              <Pulse className="h-3.5 w-24" />
              <Pulse className="h-8 w-14" />
            </div>
            <Pulse className="w-12 h-12 rounded-xl flex-shrink-0" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function CardSkeleton({ lines = 3 }) {
  return (
    <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-[18px] space-y-3">
      <Pulse className="h-5 w-36" />
      {Array.from({ length: lines }).map((_, i) => (
        <Pulse key={i} className={`h-4 ${['w-full', 'w-4/5', 'w-3/5'][i % 3]}`} />
      ))}
    </div>
  )
}

export function PageSkeleton({ cols = 6 }) {
  return (
    <LoadingRegion className="space-y-6">
      <div className="space-y-2">
        <Pulse className="h-8 w-44" />
        <Pulse className="h-4 w-64" />
      </div>
      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38] flex items-center gap-3">
          <Pulse className="h-9 w-64" />
          <Pulse className="h-9 w-28 ms-auto" />
          <Pulse className="h-9 w-28" />
        </div>
        <table className="w-full">
          <TableSkeleton rows={10} cols={cols} />
        </table>
        <div className="px-4 py-3 border-t border-[#e6e9ef] dark:border-[#212a38] flex items-center justify-between">
          <Pulse className="h-4 w-40" />
          <Pulse className="h-8 w-48" />
        </div>
      </div>
    </LoadingRegion>
  )
}

/** A table inside its card, for a tab or panel whose rows are loading. */
export function TableCardSkeleton({ rows = 8, cols = 6, bare = false }) {
  return (
    <LoadingRegion
      className={
        bare
          ? 'overflow-hidden'
          : 'bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden'
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-[#e6e9ef] dark:border-[#212a38] bg-[#f8f9fb] dark:bg-[#0f1520]">
            {Array.from({ length: cols }).map((_, j) => (
              <th key={j} className="px-4 py-3">
                <Pulse className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <TableSkeleton rows={rows} cols={cols} />
      </table>
    </LoadingRegion>
  )
}

/** A document or record page: title bar, a summary card and a lines card. */
export function DetailSkeleton() {
  return (
    <LoadingRegion className="w-full px-4 py-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Pulse className="h-8 w-48" />
          <Pulse className="h-4 w-28" />
        </div>
        <Pulse className="h-9 w-32" />
      </div>
      <CardSkeleton lines={4} />
      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
        <table className="w-full">
          <TableSkeleton rows={4} cols={5} />
        </table>
      </div>
    </LoadingRegion>
  )
}

/** Stat tiles over a table: the Dashboard and the Reports tabs. */
export function StatsAndTableSkeleton({ stats = 4, rows = 6, cols = 5 }) {
  return (
    <LoadingRegion className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: stats }).map((_, i) => (
          <div
            key={i}
            className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-[18px] space-y-3"
          >
            <Pulse className="h-3.5 w-24" />
            <Pulse className="h-8 w-16" />
          </div>
        ))}
      </div>
      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
        <table className="w-full">
          <TableSkeleton rows={rows} cols={cols} />
        </table>
      </div>
    </LoadingRegion>
  )
}

/** A stack of cards: article lists and card feeds. */
export function CardListSkeleton({ count = 3, lines = 3 }) {
  return (
    <LoadingRegion className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} lines={lines} />
      ))}
    </LoadingRegion>
  )
}

/** The week grid of the Tech Calendar. */
export function CalendarSkeleton() {
  return (
    <LoadingRegion className="p-3 sm:p-6 space-y-6">
      <div className="space-y-2">
        <Pulse className="h-8 w-44" />
        <Pulse className="h-4 w-64" />
      </div>
      <div className="flex items-center gap-3">
        <Pulse className="h-9 w-24" />
        <Pulse className="h-9 w-48" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-7 gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-3 space-y-3 min-h-[180px]"
          >
            <Pulse className="h-4 w-16" />
            <Pulse className="h-12 w-full" />
            <Pulse className="h-12 w-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  )
}

export function RouteSkeleton() {
  return (
    <LoadingRegion className="space-y-6 p-4 md:p-8">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Pulse className="h-8 w-48" />
          <Pulse className="h-4 w-72" />
        </div>
        <Pulse className="h-9 w-32 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] p-[18px]"
          >
            <div className="flex items-center justify-between">
              <div className="space-y-2.5">
                <Pulse className="h-3.5 w-20" />
                <Pulse className="h-7 w-12" />
              </div>
              <Pulse className="w-10 h-10 rounded-xl flex-shrink-0" />
            </div>
          </div>
        ))}
      </div>
      <div className="bg-white dark:bg-[#121823] rounded-[14px] border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#e6e9ef] dark:border-[#212a38] flex items-center gap-3">
          <Pulse className="h-9 w-56" />
          <Pulse className="h-9 w-24 ms-auto" />
          <Pulse className="h-9 w-24" />
        </div>
        <table className="w-full">
          <TableSkeleton rows={8} cols={5} />
        </table>
      </div>
    </LoadingRegion>
  )
}
