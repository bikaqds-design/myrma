/**
 * chatSessions.test.js — recent conversations, kept in the browser.
 *
 * Deliberately not in the database: a table, its policies, a row on every
 * message and a query on every page load is real load for a convenience. The
 * trade is that history lives in ONE browser, which these tests do not change
 * but the module's own comment states plainly.
 *
 * The properties worth pinning are the ones where being wrong is silent: a
 * conversation that duplicates on every follow-up, a list that grows without
 * bound, and a storage failure that takes the page down.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  listSessions,
  saveSession,
  deleteSession,
  clearSessions,
  sessionTitle,
  MAX_SESSIONS,
} from '../lib/chatSessions.js'

const turn = (q, a) => [
  { role: 'user', content: q },
  { role: 'assistant', content: a, sources: [{ n: 1, title: 'doc' }] },
]

beforeEach(() => {
  clearSessions()
})

describe('saving', () => {
  it('stores a completed conversation', () => {
    const saved = saveSession('a', turn('what is the TDP?', '65W'), '2026-09-01T10:00:00Z')
    expect(saved).toHaveLength(1)
    expect(saved[0].title).toBe('what is the TDP?')
    expect(saved[0].messages).toHaveLength(2)
  })

  // A question with no answer would otherwise appear in the list the instant
  // someone pressed Ask, before anything came back.
  it('ignores a question that has no answer yet', () => {
    expect(saveSession('a', [{ role: 'user', content: 'pending?' }])).toEqual([])
    expect(saveSession('a', [
      { role: 'user', content: 'pending?' },
      { role: 'assistant', content: '' },
    ])).toEqual([])
  })

  it('ignores an empty conversation', () => {
    expect(saveSession('a', [])).toEqual([])
    expect(saveSession('a', null)).toEqual([])
  })

  // The property that makes a five-item list useful rather than a list of one
  // conversation five times over.
  it('updates in place as a conversation continues', () => {
    saveSession('a', turn('first question', 'answer one'))
    const after = saveSession('a', [
      ...turn('first question', 'answer one'),
      ...turn('and the weight?', 'answer two'),
    ])
    expect(after).toHaveLength(1)
    expect(after[0].messages).toHaveLength(4)
    expect(after[0].title).toBe('first question')
  })

  it('keeps distinct conversations apart, newest first', () => {
    saveSession('a', turn('older', 'x'))
    saveSession('b', turn('newer', 'y'))
    expect(listSessions().map((s) => s.title)).toEqual(['newer', 'older'])
  })

  // localStorage is a shared, size-limited space. An unbounded log in it
  // eventually breaks something unrelated to this feature.
  it('keeps only the most recent five', () => {
    for (let i = 1; i <= 8; i++) saveSession(`s${i}`, turn(`question ${i}`, 'a'))
    const sessions = listSessions()
    expect(sessions).toHaveLength(MAX_SESSIONS)
    expect(sessions[0].title).toBe('question 8')
    expect(sessions.map((s) => s.title)).not.toContain('question 1')
  })

  it('truncates a pasted wall of text rather than spending the quota on it', () => {
    const huge = 'x'.repeat(10_000)
    const saved = saveSession('a', turn('q', huge))
    expect(saved[0].messages[1].content.length).toBeLessThanOrEqual(4000)
  })

  it('takes the time from the caller rather than reading a clock', () => {
    const saved = saveSession('a', turn('q', 'a'), '2026-09-01T10:00:00Z')
    expect(saved[0].at).toBe('2026-09-01T10:00:00Z')
    expect(saveSession('b', turn('q2', 'a'))[0].at).toBeNull()
  })
})

describe('titles', () => {
  it('is the first question, which is what a person recognises', () => {
    expect(sessionTitle(turn('what is the TDP?', 'answer'))).toBe('what is the TDP?')
  })

  it('is shortened rather than allowed to break the row', () => {
    const long = 'w'.repeat(200)
    expect(sessionTitle([{ role: 'user', content: long }]).length).toBeLessThanOrEqual(71)
    expect(sessionTitle([{ role: 'user', content: long }]).endsWith('…')).toBe(true)
  })

  it('is empty when there is no question', () => {
    expect(sessionTitle([{ role: 'assistant', content: 'hello' }])).toBe('')
    expect(sessionTitle([])).toBe('')
  })
})

describe('removing', () => {
  it('deletes one and leaves the rest', () => {
    saveSession('a', turn('keep me', 'x'))
    saveSession('b', turn('delete me', 'y'))
    expect(deleteSession('b').map((s) => s.title)).toEqual(['keep me'])
  })

  it('clears everything', () => {
    saveSession('a', turn('q', 'a'))
    expect(clearSessions()).toEqual([])
    expect(listSessions()).toEqual([])
  })
})

/**
 * localStorage throws rather than returning null in a private window, when the
 * quota is full, and when site data is blocked. An unguarded read would take
 * the whole page down over saved history.
 */
describe('when the browser refuses to store anything', () => {
  it('reads as empty rather than throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => listSessions()).not.toThrow()
    expect(listSessions()).toEqual([])
    spy.mockRestore()
  })

  it('survives a write failure', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveSession('a', turn('q', 'a'))).not.toThrow()
    spy.mockRestore()
  })

  it('recovers from corrupted stored data', () => {
    localStorage.setItem('myrma.kb.sessions.v1', 'not json at all')
    expect(listSessions()).toEqual([])
    // And can still save over it.
    expect(saveSession('a', turn('q', 'a'))).toHaveLength(1)
  })

  it('ignores stored data of the wrong shape', () => {
    localStorage.setItem('myrma.kb.sessions.v1', '{"not":"an array"}')
    expect(listSessions()).toEqual([])
  })
})
