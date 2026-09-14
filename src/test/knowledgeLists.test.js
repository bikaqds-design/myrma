/**
 * knowledgeLists.test.js — BUG-066, phase 5b: the Knowledge Center Vault's reads.
 *
 * The folder tree, its counts and its search moved into the database
 * (20260855_knowledge_explorer_views.sql, pinned by
 * supabase/tests/knowledge_explorer_views.sql). What is pinned here is the
 * request, since a wrong one still returns rows:
 *
 *  - a folder scopes by path, and the root scopes by nothing;
 *  - a search goes through the matching function and brings the text back for
 *    its snippet, browsing does not;
 *  - a folder page lists child folders first and fills the rest with its
 *    documents, from the right offset;
 *  - the provisioning gate counts without reading.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls = []
let responses = []

function builder(target) {
  const b = {}
  for (const method of ['select', 'eq', 'neq', 'is', 'in', 'not', 'gt', 'contains', 'order', 'range', 'limit', 'maybeSingle']) {
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
    rpc: (fn, args, options) => {
      calls.push(['rpc', fn, args, options])
      return builder(fn)
    },
  },
}))

const { knowledgeLists, applyVaultFilters, toDocument, KNOWLEDGE_ROOT } = await import('../api/db/knowledgeLists')

beforeEach(() => {
  calls.length = 0
  responses = []
})

const on = (target, method) => calls.filter((c) => c[0] === target && c[1] === method).map((c) => c.slice(2))

function recorder() {
  const seen = []
  const q = {}
  for (const m of ['eq', 'neq', 'contains']) {
    q[m] = (...args) => {
      seen.push([m, ...args])
      return q
    }
  }
  return { q, seen }
}

describe('applyVaultFilters', () => {
  it('scopes a folder by path and the root by nothing', () => {
    const inFolder = recorder()
    applyVaultFilters(inFolder.q, { folderId: 'brand-1' })
    expect(inFolder.seen).toEqual([['contains', 'path', ['brand-1']]])

    const atRoot = recorder()
    applyVaultFilters(atRoot.q, { folderId: KNOWLEDGE_ROOT })
    expect(atRoot.seen).toEqual([])
  })

  it('filters "not searchable" as anything but ok', () => {
    const r = recorder()
    applyVaultFilters(r.q, { notSearchableOnly: true, docType: 'manual' })
    expect(r.seen).toEqual([
      ['eq', 'doc_type', 'manual'],
      ['neq', 'extraction_status', 'ok'],
    ])
  })
})

describe('documentsPage', () => {
  it('searches through the matching function, with the text for snippets and an exact count', async () => {
    await knowledgeLists.documentsPage({ folderId: 'cat-1', query: '  gammix  ' }, 2, 25)
    expect(calls.find((c) => c[0] === 'rpc')).toEqual([
      'rpc',
      'rma_knowledge_documents_matching',
      { p_term: 'gammix' },
      { count: 'exact' },
    ])
    expect(on('rma_knowledge_documents_matching', 'select')[0][0]).toContain('extracted_text')
    expect(on('rma_knowledge_documents_matching', 'is')).toEqual([['deleted_at', null]])
    expect(on('rma_knowledge_documents_matching', 'contains')).toEqual([['path', ['cat-1']]])
    expect(on('rma_knowledge_documents_matching', 'range')).toEqual([[25, 49]])
  })

  it('browses filters without the document body, ordered by title then id', async () => {
    await knowledgeLists.documentsPage({ docType: 'datasheet' }, 1, 25)
    expect(calls.some((c) => c[0] === 'rpc')).toBe(false)
    expect(on('v_knowledge_documents', 'select')[0][0]).not.toContain('extracted_text')
    expect(on('v_knowledge_documents', 'order')).toEqual([
      ['title', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })
})

describe('browsePage', () => {
  it('lists child folders first, then fills the page with documents from the right offset', async () => {
    const folders = Array.from({ length: 5 }, (_, i) => ({ id: `f${25 + i}` }))
    const docs = [{ id: 'd0', product_id: 'p1', product_sku: 'SKU', product_name: 'Prod' }]
    responses = [
      { data: folders, error: null, count: 30 },
      { data: docs, error: null, count: 1 },
    ]
    const page = await knowledgeLists.browsePage('p1', 2, 25)

    expect(on('v_knowledge_nodes', 'range')).toEqual([[25, 49]])
    // 30 folders in all: page 2 shows the last 5, then documents from the first.
    expect(on('v_knowledge_documents', 'range')).toEqual([[0, 19]])
    expect(page.count).toBe(31)
    expect(page.data.map((r) => r.kind)).toEqual(['folder', 'folder', 'folder', 'folder', 'folder', 'document'])
  })

  it('does not look for documents at the root, where only folders sit', async () => {
    responses = [{ data: [{ id: 'b1' }], error: null, count: 1 }]
    await knowledgeLists.browsePage(KNOWLEDGE_ROOT, 1, 25)
    expect(on('v_knowledge_documents', 'range')).toEqual([])
  })
})

describe('toDocument', () => {
  it('nests the product the view flattens', () => {
    const doc = toDocument({
      id: 'd1',
      product_id: 'p1',
      title: 'Sheet',
      product_sku: 'PRD-1',
      product_name: 'Monitor',
      product_brand_id: 'b1',
      product_category_id: null,
      product_subcategory_id: null,
    })
    expect(doc.product).toEqual({
      id: 'p1',
      sku: 'PRD-1',
      product_name: 'Monitor',
      brand_id: 'b1',
      category_id: null,
      subcategory_id: null,
    })
    expect(doc).not.toHaveProperty('product_sku')
  })
})

describe('isProvisioned', () => {
  it('counts without reading rows', async () => {
    responses = [{ data: null, error: null, count: 3 }]
    expect(await knowledgeLists.isProvisioned()).toBe(true)
    expect(on('product_documents', 'select')).toEqual([['id', { count: 'exact', head: true }]])
  })

  it('reports an unprovisioned library rather than throwing', async () => {
    responses = [{ data: null, error: { code: 'PGRST205' }, count: null }]
    expect(await knowledgeLists.isProvisioned()).toBe(false)
  })
})
