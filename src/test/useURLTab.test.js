/**
 * useURLTab.test.js — Unit tests for src/hooks/useURLTab.js
 *
 * Covers: default value fallback, delete-on-empty/null/undefined,
 * and the pushHistory replace-vs-push contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const setSearchParamsMock = vi.fn()
let currentParams = new URLSearchParams()

vi.mock('react-router-dom', () => ({
  useSearchParams: () => [currentParams, setSearchParamsMock],
}))

const { useURLTab } = await import('../hooks/useURLTab')

beforeEach(() => {
  currentParams = new URLSearchParams()
  setSearchParamsMock.mockReset()
})

describe('useURLTab — read', () => {
  it('returns the default value when the param is absent', () => {
    const { result } = renderHook(() => useURLTab('tab', 'products'))
    expect(result.current[0]).toBe('products')
  })

  it('returns the URL param value when present', () => {
    currentParams = new URLSearchParams('tab=customers')
    const { result } = renderHook(() => useURLTab('tab', 'products'))
    expect(result.current[0]).toBe('customers')
  })
})

describe('useURLTab — write', () => {
  it('sets the param when called with a non-empty value', () => {
    const { result } = renderHook(() => useURLTab('tab', 'products'))
    act(() => {
      result.current[1]('customers')
    })
    const [paramsArg] = setSearchParamsMock.mock.calls[0]
    expect(paramsArg.get('tab')).toBe('customers')
  })

  it.each(['', null, undefined])('deletes the param when called with %s', (value) => {
    currentParams = new URLSearchParams('tab=customers')
    const { result } = renderHook(() => useURLTab('tab', 'products'))
    act(() => {
      result.current[1](value)
    })
    const [paramsArg] = setSearchParamsMock.mock.calls[0]
    expect(paramsArg.has('tab')).toBe(false)
  })
})

describe('useURLTab — pushHistory replace-vs-push', () => {
  it('defaults to replace:true (pushHistory=false)', () => {
    const { result } = renderHook(() => useURLTab('tab', 'products'))
    act(() => {
      result.current[1]('customers')
    })
    const [, options] = setSearchParamsMock.mock.calls[0]
    expect(options).toEqual({ replace: true })
  })

  it('uses replace:false when pushHistory is true', () => {
    const { result } = renderHook(() => useURLTab('tab', 'products', true))
    act(() => {
      result.current[1]('customers')
    })
    const [, options] = setSearchParamsMock.mock.calls[0]
    expect(options).toEqual({ replace: false })
  })
})
