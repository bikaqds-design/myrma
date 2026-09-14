/**
 * knowledgeTree.test.js -- byte formatting for the Knowledge Center listings.
 *
 * The folder-tree placement and roll-up tests that lived here moved with the
 * tree itself into the database: supabase/tests/knowledge_explorer_views.sql.
 */
import { describe, it, expect } from 'vitest'
import { formatBytes } from '../lib/knowledgeTree'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [500, '500 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [1097002, '1.0 MB'],
    [150 * 1024 * 1024, '150 MB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('handles null and undefined without throwing', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(undefined)).toBe('')
  })
})
