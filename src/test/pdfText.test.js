/**
 * pdfText.test.js — turning a document into searchable text.
 *
 * The extraction itself needs a real PDF and a browser, so what is tested here
 * is the part that decides whether search works at all: the normalisation, the
 * chunking, and — most importantly — the honest reporting of failure.
 *
 * A document whose text could not be read must say so. If those silently never
 * appeared in results, the team would slowly learn not to trust the search,
 * which is a worse outcome than a smaller library everyone believes.
 */
import { describe, it, expect } from 'vitest'
import {
  normaliseText,
  chunkText,
  extractText,
  EXTRACTABLE_TYPES,
  EXTRACT_OK,
  EXTRACT_EMPTY,
  EXTRACT_FAILED,
  EXTRACT_UNSUPPORTED,
} from '../lib/pdfText.js'

const NUL = String.fromCharCode(0)
const NBSP = String.fromCharCode(160)

describe('normaliseText', () => {
  it('is empty for nothing', () => {
    expect(normaliseText('')).toBe('')
    expect(normaliseText(null)).toBe('')
    expect(normaliseText(undefined)).toBe('')
  })

  // Both of these are what PDF producers actually emit, and both would
  // otherwise end up in the stored text and the search index.
  it('strips the NUL bytes PDFs put between glyphs', () => {
    expect(normaliseText(`B6${NUL}60M`)).toBe('B660M')
  })

  it('treats a non-breaking space as a word separator', () => {
    expect(normaliseText(`DDR5${NBSP}4800`)).toBe('DDR5 4800')
  })

  it('collapses runs of spaces and tabs without eating line structure', () => {
    expect(normaliseText('a   \t  b\n\n\n\nc')).toBe('a b\n\nc')
  })

  it('trims the edges', () => {
    expect(normaliseText('  spec  ')).toBe('spec')
  })
})

describe('chunkText', () => {
  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText(null)).toEqual([])
  })

  it('leaves a short document as one piece', () => {
    expect(chunkText('a short datasheet')).toEqual(['a short datasheet'])
  })

  it('splits a long document', () => {
    const text = 'x'.repeat(5000)
    const chunks = chunkText(text, { size: 1000, overlap: 100 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 1000)).toBe(true)
  })

  // The overlap is the point: a specification split exactly across a boundary
  // would otherwise be findable from neither side.
  it('overlaps consecutive chunks', () => {
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkText(text, { size: 500, overlap: 100 })
    expect(chunks.length).toBeGreaterThan(1)
    const endOfFirst = chunks[0].slice(-50)
    const anyShared = endOfFirst
      .split(' ')
      .filter(Boolean)
      .some((w) => chunks[1].includes(w))
    expect(anyShared).toBe(true)
  })

  it('always makes progress rather than looping on a pathological input', () => {
    // overlap >= size would otherwise mean start never advances.
    const chunks = chunkText('y'.repeat(3000), { size: 100, overlap: 500 })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThan(3100)
  })

  it('produces no empty chunks', () => {
    const chunks = chunkText('a\n\n\n\nb\n\n\n\nc', { size: 4, overlap: 1 })
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true)
  })
})

describe('extractText reports failure rather than hiding it', () => {
  const fileOf = (content, type) => ({
    type,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  })

  it('reads a plain text file', async () => {
    const r = await extractText(fileOf('TDP 65W', 'text/plain'))
    expect(r.status).toBe(EXTRACT_OK)
    expect(r.text).toBe('TDP 65W')
  })

  // A file that parses but holds nothing is a scan — a picture of text.
  // Distinguishing that from a hard failure tells the user whether OCR
  // would be the answer.
  it('calls an empty file empty, not failed', async () => {
    const r = await extractText(fileOf('   ', 'text/plain'))
    expect(r.status).toBe(EXTRACT_EMPTY)
  })

  it('calls a type it cannot read unsupported, not failed', async () => {
    const r = await extractText(fileOf('...', 'application/msword'))
    expect(r.status).toBe(EXTRACT_UNSUPPORTED)
    expect(r.text).toBe('')
  })

  it('never throws, so a bad file cannot lose the upload', async () => {
    const broken = {
      type: 'text/plain',
      text: async () => {
        throw new Error('unreadable')
      },
    }
    const r = await extractText(broken)
    expect(r.status).toBe(EXTRACT_FAILED)
  })

  it('handles being given nothing', async () => {
    const r = await extractText(null)
    expect(r.status).toBe(EXTRACT_FAILED)
  })

  it('claims to read only what it can actually read', () => {
    expect(EXTRACTABLE_TYPES).toContain('application/pdf')
    expect(EXTRACTABLE_TYPES).toContain('text/plain')
    // Word and Excel are storable but not readable — claiming otherwise would
    // promise searchability the upload cannot deliver.
    expect(EXTRACTABLE_TYPES).not.toContain('application/msword')
  })
})

describe('the document type list matches the database', () => {
  it('offers exactly the types the CHECK constraint allows', async () => {
    const { readFileSync } = await import('node:fs')
    const { DOC_TYPES } = await import('../lib/documentTypes.js')
    const sql = readFileSync('supabase/migrations/20260801_product_documents.sql', 'utf8')
    const match = sql.match(/CHECK \(doc_type IN\s*\n?\s*\(([^)]*)\)/)
    expect(match, 'could not find the doc_type constraint').toBeTruthy()
    const allowed = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    expect([...DOC_TYPES].sort()).toEqual([...allowed].sort())
  })
})

describe('the Knowledge Center is staff-only and searchable', () => {
  it('refuses anon and indexes the text', async () => {
    const { readFileSync } = await import('node:fs')
    const sql = readFileSync('supabase/migrations/20260801_product_documents.sql', 'utf8')
    expect(sql).toContain('REVOKE ALL ON public.product_documents FROM PUBLIC, anon')
    expect(sql).toContain('USING GIN (search_vector)')
    // Generated, so the index can never describe text the document no longer has.
    expect(sql).toMatch(/search_vector tsvector\s*\n?\s*GENERATED ALWAYS AS/)
    // 'simple' and not 'english': these are part numbers and units, and English
    // stemming would fold and stop-word away exactly the terms that matter.
    expect(sql).toContain("to_tsvector('simple'")
    expect(sql).not.toContain("to_tsvector('english'")
  })
})
