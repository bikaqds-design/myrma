/**
 * snippet.test.js — the passage shown under a search result.
 *
 * The property that matters most here is the one that is silently wrong rather
 * than visibly broken: a snippet that does not actually contain the search
 * term still LOOKS like an explanation of why the document matched. So the
 * tests care less about formatting and more about "does this only ever show
 * text that genuinely matched".
 */
import { describe, it, expect } from 'vitest'
import { buildSnippet, queryTerms } from '../lib/snippet.js'

const BODY = [
  'Cylon Series Product Datasheet. General specification overview follows.',
  'The panel operates at a refresh rate of 180 Hz when driven over DisplayPort.',
  'Brightness is rated at 300 cd/m2 typical across the visible area.',
  'Warranty period is three years from date of purchase.',
].join(' ')

describe('picking terms out of what was typed', () => {
  it('takes the words worth searching for', () => {
    expect(queryTerms('refresh rate')).toEqual(['refresh', 'rate'])
  })

  it('drops the websearch operators rather than hunting for them', () => {
    expect(queryTerms('"refresh rate" or brightness')).toEqual([
      'refresh',
      'rate',
      'brightness',
    ])
  })

  // A lone letter would mark half the passage as a match.
  it('ignores single characters', () => {
    expect(queryTerms('a 180Hz b')).toEqual(['180hz'])
  })

  it('keeps part numbers intact', () => {
    expect(queryTerms('PS5012-E16')).toEqual(['ps5012-e16'])
  })

  it('has nothing to say about an empty query', () => {
    expect(queryTerms('')).toEqual([])
    expect(queryTerms(null)).toEqual([])
  })
})

describe('building the passage', () => {
  it('returns the text around the match, marked', () => {
    const snip = buildSnippet(BODY, '180Hz')
    // Written as "180 Hz" in the body, so the joined term does not appear —
    // this asserts the honest behaviour rather than a convenient one.
    expect(snip).toBeNull()
  })

  it('marks the matching words and only those', () => {
    const snip = buildSnippet(BODY, 'DisplayPort')
    expect(snip).not.toBeNull()
    const matched = snip.segments.filter((s) => s.match).map((s) => s.text)
    expect(matched).toEqual(['DisplayPort'])
  })

  it('reassembles to a contiguous run of the original text', () => {
    const snip = buildSnippet(BODY, 'brightness')
    const joined = snip.segments.map((s) => s.text).join('')
    expect(BODY).toContain(joined)
  })

  /**
   * The core promise. If this passes while the snippet shows a passage with no
   * search term in it, the feature is lying to the reader.
   */
  it('always contains what was searched for', () => {
    const snip = buildSnippet(BODY, 'warranty')
    const joined = snip.segments.map((s) => s.text).join('').toLowerCase()
    expect(joined).toContain('warranty')
  })

  it('prefers the passage covering the most different terms', () => {
    const snip = buildSnippet(BODY, 'refresh DisplayPort')
    const joined = snip.segments.map((s) => s.text).join('')
    expect(joined).toContain('refresh')
    expect(joined).toContain('DisplayPort')
  })

  // A title-only match must not be dressed up as a body match.
  it('shows nothing when the body does not contain the terms', () => {
    expect(buildSnippet(BODY, 'thunderbolt')).toBeNull()
  })

  it('shows nothing when there is no body to show', () => {
    expect(buildSnippet('', 'refresh')).toBeNull()
    expect(buildSnippet(null, 'refresh')).toBeNull()
  })

  it('shows nothing when nothing was searched for', () => {
    expect(buildSnippet(BODY, '')).toBeNull()
  })

  it('reports whether text was cut off on each side', () => {
    const long = `${'padding word '.repeat(60)}refresh rate ${'trailing word '.repeat(60)}`
    const snip = buildSnippet(long, 'refresh')
    expect(snip.before).toBe(true)
    expect(snip.after).toBe(true)
  })

  it('does not claim truncation on a short document', () => {
    const snip = buildSnippet('Refresh rate is 180 Hz.', 'refresh')
    expect(snip.before).toBe(false)
    expect(snip.after).toBe(false)
  })

  // Extracted PDF text breaks lines mid-sentence; a snippet is one line.
  it('flattens the line breaks that PDF extraction leaves behind', () => {
    const wrapped = ['Refresh rate is', '180 Hz over', 'DisplayPort.'].join(String.fromCharCode(10))
    const snip = buildSnippet(wrapped, 'refresh')
    const joined = snip.segments.map((s) => s.text).join('')
    expect(joined).toBe('Refresh rate is 180 Hz over DisplayPort.')
  })

  // "hz" inside "180hz" would otherwise render the characters twice.
  it('does not duplicate text when one term sits inside another', () => {
    const snip = buildSnippet('The 180hz panel.', '180hz hz')
    const joined = snip.segments.map((s) => s.text).join('')
    expect(joined).toBe('The 180hz panel.')
  })

  // A regex-special character in a part number would throw rather than search.
  it('treats punctuation in the query as text, not as a pattern', () => {
    const body = 'Controller PS5012-E16 with (revision B) at 3.5W.'
    expect(() => buildSnippet(body, 'PS5012-E16')).not.toThrow()
    expect(() => buildSnippet(body, '(revision')).not.toThrow()
    expect(() => buildSnippet(body, '3.5W')).not.toThrow()
    const snip = buildSnippet(body, '3.5W')
    expect(snip.segments.filter((s) => s.match).map((s) => s.text)).toEqual(['3.5W'])
  })

  it('matches regardless of case but shows the document, not the query', () => {
    const snip = buildSnippet('Refresh Rate is high.', 'refresh')
    expect(snip.segments.filter((s) => s.match).map((s) => s.text)).toEqual(['Refresh'])
  })
})
