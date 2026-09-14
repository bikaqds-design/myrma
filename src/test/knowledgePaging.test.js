/**
 * knowledgePaging.test.js — BUG-066, phase 5b-2: Company Docs, bulk upload and
 * the KB article lists.
 *
 * Each used to load a whole table into the browser and filter or match there,
 * past the Data API's 1 000-row cap. What is pinned is the request:
 *
 *  - Company Docs pages in the database, searching with websearch syntax, and
 *    only a search brings the document body back;
 *  - the KB lists page by category then order, the public one published only;
 *  - bulk upload asks for SKU candidates, and a product that could match two
 *    files comes back once — matchFiles then decides exactly as it did over
 *    the whole catalogue.
 * The candidate rule itself is pinned in supabase/tests/product_sku_candidates.sql.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target) {
  const b = {}
  for (const method of ['select', 'eq', 'is', 'or', 'textSearch', 'order', 'range', 'not', 'gt', 'lte']) {
    b[method] = (...args) => {
      calls.push([target, method, ...args])
      return b
    }
  }
  b.then = (resolve, reject) =>
    Promise.resolve(responses.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject)
  return b
}

vi.mock('../api/client.js', () => ({
  supabase: {
    from: (table) => builder(table),
    rpc: (fn, args) => {
      calls.push(['rpc', fn, args])
      return builder(fn)
    },
  },
}))

const { companyDocuments } = await import('../api/db/companyDocuments')
const { kbArticles } = await import('../api/db/kb')
const { products } = await import('../api/db/catalog')
const { matchFiles, normalise, baseName } = await import('../lib/skuMatch')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))

describe('companyDocuments.listPage', () => {
  it('lists live documents newest first, a page at a time, without the body', async () => {
    await companyDocuments.listPage('', 2, 25)
    expect(on('company_documents', 'is')).toEqual([['deleted_at', null]])
    expect(on('company_documents', 'textSearch')).toEqual([])
    expect(on('company_documents', 'select')[0][0]).not.toContain('extracted_text')
    expect(on('company_documents', 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: true }],
    ])
    expect(on('company_documents', 'range')).toEqual([[25, 49]])
  })

  it('searches in the database with websearch syntax and returns the body', async () => {
    await companyDocuments.listPage('  price list  ', 1, 25)
    expect(on('company_documents', 'textSearch')).toEqual([
      ['search_vector', 'price list', { type: 'websearch', config: 'simple' }],
    ])
    expect(on('company_documents', 'select')[0]).toEqual([expect.stringContaining('extracted_text'), { count: 'exact' }])
  })
})

describe('kbArticles.listPage', () => {
  it('orders by category, then sort order, then id', async () => {
    await kbArticles.listPage({}, 1, 25)
    expect(on('kb_articles', 'order')).toEqual([
      ['category', { ascending: true }],
      ['sort_order', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(on('kb_articles', 'eq')).toEqual([])
  })

  it('shows the public page published articles only, searching title or body', async () => {
    await kbArticles.listPage({ search: 'warranty', publishedOnly: true }, 1, 50)
    expect(on('kb_articles', 'eq')).toEqual([['is_published', true]])
    expect(on('kb_articles', 'or')).toEqual([['title.ilike."%warranty%",body.ilike."%warranty%"']])
    expect(on('kb_articles', 'range')).toEqual([[0, 49]])
  })

  it('reports an unprovisioned table as missing rather than throwing', async () => {
    responses = [{ data: null, error: { code: '42P01' }, count: null }]
    const page = await kbArticles.listPage({}, 1, 25)
    expect(page).toMatchObject({ missing: true, data: [], count: 0 })
  })
})

describe('products.skuCandidates', () => {
  it('sends the normalised bases and de-duplicates a product that fits several files', async () => {
    responses = [
      {
        data: [
          { base_index: 1, id: 'p1', sku: 'XPG-8200-PRO', product_name: 'Headset' },
          { base_index: 2, id: 'p1', sku: 'XPG-8200-PRO', product_name: 'Headset' },
          { base_index: 2, id: 'p2', sku: 'AOC-24G2', product_name: 'Monitor' },
        ],
        error: null,
      },
      { data: [], error: null },
    ]
    const files = ['xpg 8200 pro.pdf', 'XPG-8200-PRO and AOC-24G2 sheet.pdf']
    const bases = files.map((f) => normalise(baseName(f)))
    const candidates = await products.skuCandidates(bases)

    expect(calls.find((c) => c[0] === 'rpc')).toEqual(['rpc', 'rma_product_sku_candidates', { p_bases: ['XPG8200PRO', 'XPG8200PROANDAOC24G2SHEET'] }])
    expect(candidates.map((c) => c.id)).toEqual(['p1', 'p2'])
    // The matcher over the candidates: file 1 is an exact match; file 2
    // contains two SKUs of different lengths, and the longer one wins.
    expect(matchFiles(files, candidates).map((m) => [m.product?.id, m.reason])).toEqual([
      ['p1', 'exact'],
      ['p1', 'contained'],
    ])
  })

  it('makes no request when no file has a usable name', async () => {
    expect(await products.skuCandidates(['', ''])).toEqual([])
    expect(calls).toEqual([])
  })
})
