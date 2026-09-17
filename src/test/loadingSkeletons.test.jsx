/**
 * loadingSkeletons.test.jsx — list and detail content loads as a skeleton
 * (UI audit UX-GLOBAL-009).
 *
 * A centred spinner says nothing about what is coming and the layout jumps
 * when it arrives. What is pinned:
 *  - each skeleton announces itself as a loading status, as `Spinner` did, so
 *    the swap does not make loading silent to a screen reader;
 *  - the screens converted here do not go back to a content-area spinner.
 *    A small spinner inside a button (`size="sm"`) is still the right thing
 *    for an action in progress and is not flagged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import {
  TableCardSkeleton,
  DetailSkeleton,
  StatsAndTableSkeleton,
  CardListSkeleton,
  CalendarSkeleton,
  PageSkeleton,
  RouteSkeleton,
} from '../components/Skeleton'

vi.mock('i18next', () => ({ default: { t: (k) => k } }))

afterEach(cleanup)

describe('skeletons announce loading', () => {
  it.each([
    ['TableCardSkeleton', <TableCardSkeleton key="t" />],
    ['DetailSkeleton', <DetailSkeleton key="d" />],
    ['StatsAndTableSkeleton', <StatsAndTableSkeleton key="s" />],
    ['CardListSkeleton', <CardListSkeleton key="c" />],
    ['CalendarSkeleton', <CalendarSkeleton key="k" />],
    ['PageSkeleton', <PageSkeleton key="p" />],
    ['RouteSkeleton', <RouteSkeleton key="r" />],
  ])('%s is a busy status region', (_, element) => {
    render(element)
    const region = screen.getByRole('status', { name: 'common.loading' })
    expect(region.getAttribute('aria-busy')).toBe('true')
  })
})

describe('converted screens load with a skeleton', () => {
  const FILES = [
    'src/pages/Dashboard.jsx',
    'src/pages/Reports.jsx',
    'src/pages/TechCalendar.jsx',
    'src/pages/KnowledgeBasePublic.jsx',
    'src/pages/UserManagement/index.jsx',
    'src/pages/cp/AuditLog.jsx',
    'src/pages/Inventory/OverviewTab.jsx',
    'src/pages/Inventory/StockMovementsTab.jsx',
    'src/pages/Inventory/ByProductTab.jsx',
    'src/pages/Inventory/WarehousesTab.jsx',
    'src/pages/SalesDocuments/SalesDocumentDetail.jsx',
    'src/pages/Purchasing/PurchaseDocumentDetail.jsx',
  ]
  const sources = FILES.map((f) => [f, readFileSync(f, 'utf8')])

  it.each(sources)('%s has no content-area spinner', (_, src) => {
    // <Spinner />, <Spinner size="md|lg" …/>, or a hand-rolled large spinner.
    const offenders = [
      ...src.matchAll(/<Spinner(?![^>]*size="sm")[^>]*\/>/g),
      ...src.matchAll(/animate-spin w-(?:[6-9]|1\d) /g),
    ].map((m) => m[0])
    expect(offenders).toEqual([])
  })
})
