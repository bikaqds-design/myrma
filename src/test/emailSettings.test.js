/**
 * emailSettings.test.js — BUG-059.
 *
 * The Resend key must never be requested by the browser, and saving the form
 * must never erase a key the browser is not allowed to see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
const results = []

function query(table) {
  const record = { table, ops: [] }
  calls.push(record)
  const next = () => Promise.resolve(results.shift() ?? { data: null, error: null })
  const api = {
    select: (cols) => (record.ops.push(['select', cols]), api),
    update: (payload) => (record.ops.push(['update', payload]), api),
    insert: (rows) => (record.ops.push(['insert', rows]), api),
    eq: (col, val) => (record.ops.push(['eq', col, val]), api),
    single: () => (record.ops.push(['single']), next()),
    then: (resolve, reject) => next().then(resolve, reject),
  }
  return api
}

vi.mock('../api/client.js', () => ({
  supabase: { from: (table) => query(table) },
  supabaseUrl: 'https://example.supabase.co',
}))

const { notifications } = await import('../api/email.js')

const op = (record, name) => record.ops.find((o) => o[0] === name)
const columns = (record) => {
  const sel = op(record, 'select')
  return sel ? sel[1].split(',').map((c) => c.trim()) : []
}

beforeEach(() => {
  calls.length = 0
  results.length = 0
})

describe('getEmailSettings', () => {
  it('never asks for the key, and says whether one is saved', async () => {
    results.push({
      data: { id: '1', provider: 'resend', from_email: 'a@b.co', from_name: 'X', is_active: true, has_api_key: true },
      error: null,
    })
    const settings = await notifications.getEmailSettings()
    expect(columns(calls[0])).not.toContain('api_key')
    expect(columns(calls[0])).not.toContain('*')
    expect(settings.has_api_key).toBe(true)
    // The form field for typing a replacement starts empty.
    expect(settings.api_key).toBe('')
  })

  it('reports no saved key when there is no settings row yet', async () => {
    results.push({ data: null, error: { code: 'PGRST116' } })
    const settings = await notifications.getEmailSettings()
    expect(settings.has_api_key).toBe(false)
    expect(settings.api_key).toBe('')
  })
})

describe('updateEmailSettings', () => {
  const loaded = {
    id: '1', provider: 'resend', from_email: 'a@b.co', from_name: 'X', is_active: true,
    has_api_key: true, updated_date: '2026-01-01', updated_by: 'someone',
  }

  it('saving without typing a key leaves the saved key alone', async () => {
    results.push({ data: { id: '1' }, error: null }, { data: [{ id: '1', has_api_key: true }], error: null })
    await notifications.updateEmailSettings({ ...loaded, api_key: '' }, 'admin@x.co')

    const [lookup, write] = calls
    expect(op(lookup, 'select')[1]).toBe('id')
    const payload = op(write, 'update')[1]
    expect(payload).not.toHaveProperty('api_key')
    // Generated column — writing it would fail the whole update.
    expect(payload).not.toHaveProperty('has_api_key')
    expect(payload).not.toHaveProperty('id')
    expect(op(write, 'eq')).toEqual(['eq', 'id', '1'])
    // A bare select() after a write is RETURNING *, which the revoked column refuses.
    expect(columns(write)).not.toContain('api_key')
    expect(columns(write)).not.toContain('*')
  })

  it('treats a key made only of spaces as no key', async () => {
    results.push({ data: { id: '1' }, error: null }, { data: [{ id: '1' }], error: null })
    await notifications.updateEmailSettings({ ...loaded, api_key: '    ' }, 'admin@x.co')
    expect(op(calls[1], 'update')[1]).not.toHaveProperty('api_key')
  })

  it('saves a typed key, trimmed', async () => {
    results.push({ data: { id: '1' }, error: null }, { data: [{ id: '1' }], error: null })
    await notifications.updateEmailSettings({ ...loaded, api_key: '  re_new_key  ' }, 'admin@x.co')
    expect(op(calls[1], 'update')[1].api_key).toBe('re_new_key')
  })

  it('the first save inserts without a blank key and names its returned columns', async () => {
    results.push({ data: null, error: { code: 'PGRST116' } }, { data: [{ id: 'new' }], error: null })
    await notifications.updateEmailSettings(
      { provider: 'resend', api_key: '', from_email: 'a@b.co', from_name: 'X', is_active: false },
      'admin@x.co'
    )
    const write = calls[1]
    const [row] = op(write, 'insert')[1]
    expect(row).not.toHaveProperty('api_key')
    expect(row.updated_by).toBe('admin@x.co')
    expect(columns(write)).not.toContain('api_key')
    expect(columns(write)).not.toContain('*')
  })
})
