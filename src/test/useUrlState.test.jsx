/**
 * useUrlState.test.jsx — filter state that lives in the URL.
 *
 * The properties worth pinning are the ones where being wrong is either
 * invisible or actively destructive:
 *
 *  - two hooks updating in the same tick must not overwrite each other. A page
 *    with a search box and three filters has four of these, and a stale-closure
 *    read would silently drop whichever wrote first;
 *  - defaults must not appear in the URL, or every shareable link starts as
 *    `?status=&type=&page=1` and the feature is worse than not having it;
 *  - a hand-edited `?page=abc` must not put the page into NaN.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import React from 'react'
import { useUrlState, useResetOnFilterChange } from '../lib/useUrlState'

afterEach(cleanup)

function Harness({ children, initial = '/' }) {
  return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
}

function Search() {
  const [q, setQ] = useUrlState('q', '')
  const loc = useLocation()
  return (
    <>
      <input aria-label="q" value={q} onChange={(e) => setQ(e.target.value)} />
      <span data-testid="search">{loc.search}</span>
      <span data-testid="value">{String(q)}</span>
    </>
  )
}

describe('reading from the URL', () => {
  it('takes its initial value from the query string', () => {
    render(
      <Harness initial="/customers?q=computer">
        <Search />
      </Harness>
    )
    expect(screen.getByLabelText('q')).toHaveValue('computer')
  })

  it('falls back to the default when the key is absent', () => {
    render(
      <Harness initial="/customers">
        <Search />
      </Harness>
    )
    expect(screen.getByLabelText('q')).toHaveValue('')
  })
})

describe('writing to the URL', () => {
  it('puts the value in the query string', async () => {
    render(
      <Harness initial="/customers">
        <Search />
      </Harness>
    )
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'acme' } })
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?q=acme'))
  })

  /**
   * Without this every list page would carry `?status=&type=&page=1` before
   * anyone touched anything, and the shareable link would be noise.
   */
  it('omits the key entirely when the value returns to its default', async () => {
    render(
      <Harness initial="/customers?q=acme">
        <Search />
      </Harness>
    )
    fireEvent.change(screen.getByLabelText('q'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe(''))
  })
})

function TwoFilters() {
  const [q, setQ] = useUrlState('q', '')
  const [status, setStatus] = useUrlState('status', '')
  const loc = useLocation()
  return (
    <>
      <button onClick={() => setQ('acme')}>setQ</button>
      <button onClick={() => setStatus('active')}>setStatus</button>
      <span data-testid="search">{loc.search}</span>
    </>
  )
}

describe('several filters on one page', () => {
  /**
   * The defect this hook is shaped to avoid. Reading the current value from the
   * closure rather than from `prev` means the second write is based on a
   * snapshot taken before the first, and silently discards it.
   */
  it('keeps both values when two hooks are set in turn', async () => {
    render(
      <Harness initial="/customers">
        <TwoFilters />
      </Harness>
    )
    fireEvent.click(screen.getByText('setQ'))
    fireEvent.click(screen.getByText('setStatus'))
    await waitFor(() => {
      const search = screen.getByTestId('search').textContent
      expect(search).toContain('q=acme')
      expect(search).toContain('status=active')
    })
  })

  it('clearing one filter leaves the other alone', async () => {
    render(
      <Harness initial="/customers?q=acme&status=active">
        <TwoFilters />
      </Harness>
    )
    fireEvent.click(screen.getByText('setQ')) // same value, no-op
    await waitFor(() => expect(screen.getByTestId('search').textContent).toContain('status=active'))
  })
})

function SameTick() {
  const [q, setQ] = useUrlState('q', '')
  const [page, setPage] = useUrlState('page', 1)
  const loc = useLocation()
  return (
    <>
      {/* The real pattern: changing a filter also resets the page, so both
          setters run in one handler before any re-render. */}
      <button
        onClick={() => {
          setQ('acme')
          setPage(1)
        }}
      >
        filterAndReset
      </button>
      <button
        onClick={() => {
          setQ('acme')
          setPage(5)
        }}
      >
        bothAtOnce
      </button>
      <span data-testid="search">{loc.search}</span>
    </>
  )
}

describe('two setters in the same tick', () => {
  /**
   * The hazard the hook is shaped to avoid, and the one a click-then-click test
   * cannot reach: React re-renders between separate events, so the closure is
   * fresh and a stale read looks correct. Both setters must run before any
   * re-render for the bug to show.
   */
  it('keeps both values when set in one handler', async () => {
    render(
      <Harness initial="/customers">
        <SameTick />
      </Harness>
    )
    fireEvent.click(screen.getByText('bothAtOnce'))
    await waitFor(() => {
      const search = screen.getByTestId('search').textContent
      expect(search).toContain('q=acme')
      expect(search).toContain('page=5')
    })
  })

  it('a filter change that also resets the page keeps the filter', async () => {
    render(
      <Harness initial="/customers?page=7">
        <SameTick />
      </Harness>
    )
    fireEvent.click(screen.getByText('filterAndReset'))
    await waitFor(() => {
      const search = screen.getByTestId('search').textContent
      expect(search).toContain('q=acme')
      // page returned to its default, so it drops out of the URL entirely
      expect(search).not.toContain('page=')
    })
  })
})

function Paged() {
  const [page, setPage] = useUrlState('page', 1)
  return (
    <>
      <span data-testid="page">{String(page)}</span>
      <span data-testid="type">{typeof page}</span>
      <button onClick={() => setPage((p) => p + 1)}>next</button>
    </>
  )
}

describe('typed values', () => {
  it('returns a number when the default is a number', () => {
    render(
      <Harness initial="/customers?page=3">
        <Paged />
      </Harness>
    )
    expect(screen.getByTestId('page').textContent).toBe('3')
    expect(screen.getByTestId('type').textContent).toBe('number')
  })

  it('supports a functional update', async () => {
    render(
      <Harness initial="/customers?page=3">
        <Paged />
      </Harness>
    )
    fireEvent.click(screen.getByText('next'))
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('4'))
  })

  /**
   * A URL is user-editable and survives in bookmarks. `?page=abc` must degrade
   * to the default rather than propagating NaN into a slice().
   */
  it('falls back to the default for an unparseable number', () => {
    render(
      <Harness initial="/customers?page=abc">
        <Paged />
      </Harness>
    )
    expect(screen.getByTestId('page').textContent).toBe('1')
  })
})

function Resetting({ filter, onReset }) {
  useResetOnFilterChange([filter], onReset)
  return <span>{String(filter)}</span>
}

function ResettingSet({ chosen, onReset }) {
  useResetOnFilterChange([chosen], onReset)
  return <span>set</span>
}

describe('resetting only on a real change', () => {
  /**
   * The whole point: a shared link carries its page, so the reset must not fire
   * just because the component mounted with filters already applied.
   */
  it('does not fire on mount', () => {
    const reset = vi.fn()
    render(<Harness><Resetting filter="acme" onReset={reset} /></Harness>)
    expect(reset).not.toHaveBeenCalled()
  })

  it('fires when the value changes', () => {
    const reset = vi.fn()
    const { rerender } = render(<Harness><Resetting filter="acme" onReset={reset} /></Harness>)
    rerender(<Harness><Resetting filter="widget" onReset={reset} /></Harness>)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a re-render carries the same value', () => {
    const reset = vi.fn()
    const { rerender } = render(<Harness><Resetting filter="acme" onReset={reset} /></Harness>)
    rerender(<Harness><Resetting filter="acme" onReset={reset} /></Harness>)
    expect(reset).not.toHaveBeenCalled()
  })

  /**
   * Several pages hold multi-select filters as a Set. Plain JSON.stringify turns
   * every Set into `{}`, so two different selections would look identical and
   * the page would never reset — a silent regression on those pages.
   */
  it('notices a Set changing', () => {
    const reset = vi.fn()
    const { rerender } = render(<Harness><ResettingSet chosen={new Set(['a'])} onReset={reset} /></Harness>)
    rerender(<Harness><ResettingSet chosen={new Set(['a', 'b'])} onReset={reset} /></Harness>)
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('treats the same Set contents in a new object as unchanged', () => {
    const reset = vi.fn()
    const { rerender } = render(<Harness><ResettingSet chosen={new Set(['a', 'b'])} onReset={reset} /></Harness>)
    rerender(<Harness><ResettingSet chosen={new Set(['b', 'a'])} onReset={reset} /></Harness>)
    expect(reset).not.toHaveBeenCalled()
  })
})
