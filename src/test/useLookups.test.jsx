/**
 * useLookups.test.jsx — BUG-066, phase 4.
 *
 * The hooks every picker and name column now uses. Pinned: a search waits for
 * enough typing and for its dropdown to be open, so a closed picker sends no
 * requests; and a by-id lookup returns a map the callers can index, empty until
 * there is something to look up.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const search = vi.fn()
const getMany = vi.fn()

vi.mock('../api/supabaseClient', () => ({
  db: {
    customers: { search: (...a) => search(...a), getMany: (...a) => getMany(...a), get: vi.fn() },
    products: { search: vi.fn(), getMany: vi.fn() },
  },
}))

const { useCustomerSearch, useCustomersById } = await import('../lib/useLookups')

function wrapper({ children }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  search.mockReset().mockResolvedValue([{ id: 'c1', contact_person: 'Mona' }])
  getMany.mockReset().mockResolvedValue([{ id: 'a' }, { id: 'b' }])
})

describe('useCustomerSearch', () => {
  it('sends nothing while the picker is closed', async () => {
    const { result } = renderHook(() => useCustomerSearch('mona', { enabled: false }), { wrapper })
    await new Promise((r) => setTimeout(r, 350))
    expect(search).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
  })

  it('sends nothing until enough is typed', async () => {
    renderHook(() => useCustomerSearch('', { minLength: 1 }), { wrapper })
    await new Promise((r) => setTimeout(r, 350))
    expect(search).not.toHaveBeenCalled()
  })

  it('searches the trimmed term once typing settles', async () => {
    const { result } = renderHook(() => useCustomerSearch('  mona ', { limit: 8 }), { wrapper })
    await waitFor(() => expect(result.current.results).toHaveLength(1))
    expect(search).toHaveBeenCalledWith('mona', 8)
  })

  it('lists without a term when minLength is 0', async () => {
    const { result } = renderHook(() => useCustomerSearch('', { minLength: 0, limit: 50 }), { wrapper })
    await waitFor(() => expect(result.current.results).toHaveLength(1))
    expect(search).toHaveBeenCalledWith('', 50)
  })
})

describe('useCustomersById', () => {
  it('returns a map keyed by id, asking once for the de-duplicated ids', async () => {
    const { result } = renderHook(() => useCustomersById(['b', 'a', 'b', null]), { wrapper })
    await waitFor(() => expect(Object.keys(result.current)).toEqual(['a', 'b']))
    expect(getMany).toHaveBeenCalledTimes(1)
    expect(getMany).toHaveBeenCalledWith(['a', 'b'])
  })

  it('is an empty map, with no request, when there are no ids', async () => {
    const { result } = renderHook(() => useCustomersById([]), { wrapper })
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current).toEqual({})
    expect(getMany).not.toHaveBeenCalled()
  })
})
