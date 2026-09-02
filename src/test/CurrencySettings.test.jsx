/**
 * CurrencySettings.test.jsx — the Control Panel screen for the currency engine.
 *
 * The engine shipped with every knob reachable only by pasting SQL, which is
 * how the user came to ask where the currency setting was. This screen is the
 * answer, and the properties worth testing are the ones where showing the wrong
 * thing would be actively misleading rather than merely ugly:
 *
 *  - the base currency must be presented as FIXED once documents exist, because
 *    the database refuses to change it and an editable control would be an
 *    offer the server rejects;
 *  - the base currency must never offer a deactivate toggle, since every amount
 *    in the system is denominated in it;
 *  - a currency code must be exactly three characters, because the column is
 *    char(3) and a shorter one fails at the database with a type error rather
 *    than a form message.
 *
 * i18n is stubbed to echo the key so assertions name the exact message, and a
 * reason that falls through to the wrong branch cannot hide behind plausible
 * English.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo the key, but keep interpolation visible so a count that never
    // reaches the message is caught rather than silently dropped.
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  }),
}))

const CURRENCIES = [
  { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', decimals: 2, is_active: true },
  { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2, is_active: true },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0, is_active: false },
]

/** Rows returned by the currencies select, and what writes were attempted. */
const state = { updates: [], inserts: [], configWrites: [], docCount: 109 }

vi.mock('../api/client', () => ({
  supabase: {
    from: (table) => ({
      select: (_cols, opts) => {
        if (opts?.head) {
          // The document-count probe that decides whether the base is locked.
          return Promise.resolve({ count: state.docCount, error: null })
        }
        return {
          order: () => Promise.resolve({ data: CURRENCIES, error: null }),
        }
      },
      update: (patch) => ({
        eq: (_col, code) => {
          state.updates.push({ table, code, patch })
          return Promise.resolve({ error: null })
        },
      }),
      insert: (row) => {
        state.inserts.push({ table, row })
        return Promise.resolve({ error: null })
      },
    }),
  },
}))

vi.mock('../api/supabaseClient', () => ({
  db: {
    rmaConfig: {
      getAll: () =>
        Promise.resolve({ missing: false, data: [{ config_key: 'purchase_tax_in_cost', config_value: false }] }),
      set: (key, value, actor) => {
        state.configWrites.push({ key, value, actor })
        return Promise.resolve()
      },
    },
  },
}))

vi.mock('../hooks/useBaseCurrency', () => ({ useBaseCurrency: () => 'EGP' }))
vi.mock('../lib/sentry', () => ({ captureException: vi.fn() }))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))

const { default: CurrencySettings } = await import('../pages/cp/CurrencySettings')

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <CurrencySettings currentUserEmail="admin@example.com" />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  state.updates = []
  state.inserts = []
  state.configWrites = []
  state.docCount = 109
})
afterEach(cleanup)

describe('base currency', () => {
  it('is shown, and shown as locked once documents exist', async () => {
    renderScreen()
    // getAllByText: the base currency legitimately appears twice — once as the
    // heading of the base card and once as a row in the currency list. A
    // getByText here failed on correct markup for being ambiguous.
    await waitFor(() => expect(screen.getAllByText('EGP').length).toBeGreaterThan(0))
    // 7 tables x 109 from the stub — what matters is that a count reaches the
    // message rather than the message claiming a lock with no evidence.
    const locked = await screen.findByText(/cp\.currency\.baseLocked/)
    expect(locked.textContent).toMatch(/"count":\d+/)
    expect(screen.queryByText(/cp\.currency\.baseChangeable/)).toBeNull()
  })

  it('says it is still changeable when no documents exist yet', async () => {
    state.docCount = 0
    renderScreen()
    await waitFor(() => expect(screen.getByText(/cp\.currency\.baseChangeable/)).toBeTruthy())
    expect(screen.queryByText(/cp\.currency\.baseLocked/)).toBeNull()
  })

  // Every amount in the system is denominated in it; a toggle here would offer
  // an action that breaks the whole installation.
  it('offers no deactivate toggle for the base currency', async () => {
    renderScreen()
    await waitFor(() => expect(screen.getByText('cp.currency.alwaysOn')).toBeTruthy())
    expect(screen.queryByLabelText('EGP')).toBeNull()
    // The others do get one.
    expect(screen.getByLabelText('USD')).toBeTruthy()
    expect(screen.getByLabelText('JPY')).toBeTruthy()
  })
})

describe('the currency list', () => {
  it('shows every currency, active or not, with its own decimals', async () => {
    renderScreen()
    await waitFor(() => expect(screen.getByText('Japanese Yen')).toBeTruthy())
    expect(screen.getByText('US Dollar')).toBeTruthy()
    // JPY has 0 minor units. Formatting reads this from data rather than
    // assuming 2, so it has to survive to the screen.
    const jpyRow = screen.getByText('Japanese Yen').closest('tr')
    expect(jpyRow.textContent).toContain('0')
  })

  it('turns a currency on by writing is_active, not by deleting the row', async () => {
    renderScreen()
    const toggle = await screen.findByLabelText('JPY')
    fireEvent.click(toggle)
    await waitFor(() => expect(state.updates.length).toBe(1))
    // Deactivating must never remove the row: documents raised in it carry a
    // foreign key to currencies(code) and would be orphaned.
    expect(state.updates[0]).toMatchObject({
      table: 'currencies',
      code: 'JPY',
      patch: { is_active: true },
    })
  })

  it('turns an active one off', async () => {
    renderScreen()
    fireEvent.click(await screen.findByLabelText('USD'))
    await waitFor(() => expect(state.updates.length).toBe(1))
    expect(state.updates[0].patch).toEqual({ is_active: false })
  })
})

describe('adding a currency', () => {
  const openForm = async () => {
    renderScreen()
    fireEvent.click(await screen.findByText('cp.currency.add'))
    return {
      code: screen.getByLabelText('cp.currency.colCode'),
      name: screen.getByLabelText('cp.currency.colName'),
      symbol: screen.getByLabelText('cp.currency.colSymbol'),
      save: screen.getByText('common.add').closest('button'),
    }
  }

  // char(3) at the database: a shorter code fails as a type error rather than
  // anything a person could act on.
  it('will not save a code that is not exactly three characters', async () => {
    const f = await openForm()
    fireEvent.change(f.code, { target: { value: 'JP' } })
    fireEvent.change(f.name, { target: { value: 'Japanese Yen' } })
    fireEvent.change(f.symbol, { target: { value: '¥' } })
    expect(f.save.disabled).toBe(true)

    fireEvent.change(f.code, { target: { value: 'JPY' } })
    await waitFor(() => expect(f.save.disabled).toBe(false))
  })

  it('will not save without a name or a symbol', async () => {
    const f = await openForm()
    fireEvent.change(f.code, { target: { value: 'JPY' } })
    expect(f.save.disabled).toBe(true)
    fireEvent.change(f.name, { target: { value: 'Japanese Yen' } })
    expect(f.save.disabled).toBe(true)
    fireEvent.change(f.symbol, { target: { value: '¥' } })
    await waitFor(() => expect(f.save.disabled).toBe(false))
  })

  it('upper-cases the code, since the column stores ISO 4217', async () => {
    const f = await openForm()
    fireEvent.change(f.code, { target: { value: 'jpy' } })
    fireEvent.change(f.name, { target: { value: 'Japanese Yen' } })
    fireEvent.change(f.symbol, { target: { value: '¥' } })
    fireEvent.click(f.save)
    await waitFor(() => expect(state.inserts.length).toBe(1))
    expect(state.inserts[0].row.code).toBe('JPY')
  })

  it('sends decimals as a number, defaulting to 2', async () => {
    const f = await openForm()
    fireEvent.change(f.code, { target: { value: 'CHF' } })
    fireEvent.change(f.name, { target: { value: 'Swiss Franc' } })
    fireEvent.change(f.symbol, { target: { value: 'Fr' } })
    fireEvent.click(f.save)
    await waitFor(() => expect(state.inserts.length).toBe(1))
    expect(state.inserts[0].row.decimals).toBe(2)
    expect(typeof state.inserts[0].row.decimals).toBe('number')
  })
})

describe('purchase tax in cost', () => {
  it('starts off, matching the migration default', async () => {
    renderScreen()
    const toggle = await screen.findByLabelText('cp.currency.taxTitle')
    expect(toggle.className).not.toContain('bg-indigo-600')
  })

  it('writes the config key with the acting user', async () => {
    renderScreen()
    fireEvent.click(await screen.findByLabelText('cp.currency.taxTitle'))
    await waitFor(() => expect(state.configWrites.length).toBe(1))
    expect(state.configWrites[0]).toEqual({
      key: 'purchase_tax_in_cost',
      value: true,
      actor: 'admin@example.com',
    })
  })
})
