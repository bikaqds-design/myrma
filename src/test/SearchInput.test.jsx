/**
 * SearchInput.test.jsx — the shared list search box (UI audit UX-SEARCH-002).
 *
 * Search boxes had no way to clear them and were `type="text"`, so neither a
 * clear control nor the mobile search keyboard existed. What is pinned:
 *  - the clear button appears only while there is text, clears it, calls
 *    onClear, and leaves focus in the field so typing can continue;
 *  - the field is `type="search"` and named;
 *  - every page search box goes through SearchInput, so the fix cannot be
 *    undone one screen at a time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SearchInput } from '../components/SearchInput'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k }),
}))

afterEach(cleanup)

function Harness({ onClear }) {
  const [q, setQ] = useState('')
  return <SearchInput value={q} onChange={setQ} onClear={onClear} placeholder="Search customers" />
}

describe('SearchInput', () => {
  it('is a named search field', () => {
    render(<Harness />)
    const input = screen.getByRole('searchbox', { name: 'Search customers' })
    expect(input.getAttribute('type')).toBe('search')
  })

  it('shows a clear button only while there is text', () => {
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'common.clear' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'computer' } })
    expect(screen.getByRole('button', { name: 'common.clear' })).toBeTruthy()
  })

  it('clears the text, calls onClear and keeps focus in the field', () => {
    const onClear = vi.fn()
    render(<Harness onClear={onClear} />)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'computer' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.clear' }))
    expect(input.value).toBe('')
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('button', { name: 'common.clear' })).toBeNull()
  })

  it('uses an explicit aria-label over the placeholder', () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Type…" aria-label="Search users" />)
    expect(screen.getByRole('searchbox', { name: 'Search users' })).toBeTruthy()
  })
})

describe('page search boxes use SearchInput', () => {
  // Fields that are pickers or lookups, not list filters, and files left alone
  // on purpose.
  const ALLOWED = new Set([
    'src/pages/RMATickets/TicketForm.jsx', // customer / product pickers
    'src/pages/Pipeline/DealDetail.jsx', // customer picker
    'src/pages/Pipeline/_modals.jsx', // customer picker
    'src/pages/RMATracker.jsx', // RMA-number lookup, not a filter
    'src/pages/cp/WALogs.jsx', // WhatsApp work is on hold
    'src/pages/Inventory/CompanyStockTab.jsx', // dead as a tab; only its modal exports are live
  ])

  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.jsx')) files.push(path.replace(/\\/g, '/'))
    }
  }
  walk('src/pages')
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

  it('no raw <input> with a search placeholder outside the allowlist', () => {
    const offenders = []
    for (const [file, src] of sources) {
      if (ALLOWED.has(file)) continue
      // Up to the closing `/>`, not the first `>`: `onChange={(e) => …}` contains one.
      for (const m of src.matchAll(/<input\b(?:(?!\/>).)*?placeholder=\{t\('[^']*[sS]earch[^']*'\)\}(?:(?!\/>).)*?\/>/gs)) {
        offenders.push(`${file}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
