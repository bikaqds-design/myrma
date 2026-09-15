// @vitest-environment node
/**
 * trackerProof.test.js — BUG-023: the public tracker needs the RMA number.
 *
 * `comments` and `addComment` accepted a bare ticket id. Ids are not secret —
 * they appear in staff links (`?ticket=<id>`) — so anyone holding one could
 * read a ticket's public thread or post to it. Pinned here:
 *
 *  - provenTicketId: the number must name a ticket and that ticket must be the
 *    one asked for; a wrong number, a wrong id and a failed lookup all answer
 *    the same null, and the lookup gets the trimmed number;
 *  - the function uses that proof for both actions, stores the proven id (not
 *    the caller's), checks reply threading against it, and never returns
 *    user_email from an insert;
 *  - the tracker page and its client API send the number with the id;
 *  - the function still parses.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { provenTicketId, escapeLikePattern } from '../../supabase/functions/_shared/trackerProof.ts'

const ID = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

describe('provenTicketId', () => {
  const lookup = vi.fn(async (n) => (n.toUpperCase() === 'RMA-15092026-0001' ? ID : null))

  it('accepts the RMA number of the requested ticket, in any case, trimmed', async () => {
    expect(await provenTicketId(lookup, '  rma-15092026-0001 ', ID)).toBe(ID)
    expect(lookup).toHaveBeenLastCalledWith('rma-15092026-0001')
  })

  it('refuses a real RMA number paired with a different ticket id', async () => {
    expect(await provenTicketId(lookup, 'RMA-15092026-0001', OTHER)).toBeNull()
  })

  it('refuses an unknown number exactly as it refuses a mismatch', async () => {
    expect(await provenTicketId(lookup, 'RMA-00000000-0000', ID)).toBeNull()
  })

  it('refuses missing, non-string and over-long input without looking anything up', async () => {
    lookup.mockClear()
    for (const [number, id] of [[undefined, ID], ['', ID], [42, ID], ['RMA-15092026-0001', ''], ['RMA-15092026-0001', null], ['x'.repeat(65), ID]]) {
      expect(await provenTicketId(lookup, number, id)).toBeNull()
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it('treats a failing lookup as no proof', async () => {
    const broken = async () => { throw new Error('db down') }
    expect(await provenTicketId(broken, 'RMA-15092026-0001', ID)).toBeNull()
  })

  it('escapes LIKE metacharacters so a pattern cannot stand in for a number', () => {
    expect(escapeLikePattern('RMA-2105%')).toBe('RMA-2105\\%')
    expect(escapeLikePattern('a_b\\c')).toBe('a\\_b\\\\c')
  })
})

describe('the public-track function', () => {
  const fn = readFileSync('supabase/functions/public-track/index.ts', 'utf8')
  const section = (name) => {
    const start = fn.indexOf(`case '${name}': {`)
    const next = fn.indexOf("\n    case '", start + 1)
    return fn.slice(start, next === -1 ? fn.indexOf('\n    default:', start) : next)
  }

  it('requires proof before listing comments', () => {
    const c = section('comments')
    expect(c).toContain('provenTicketId(ticketIdLookup(admin), body.rmaNumber, body.ticketId)')
    expect(c.indexOf('provenTicketId')).toBeLessThan(c.indexOf("from('ticket_comments')"))
    expect(c).toContain(".eq('ticket_id', ticketId)")
  })

  it('requires proof before posting, and stores and threads against the proven id', () => {
    const a = section('addComment')
    expect(a).toContain('provenTicketId(ticketIdLookup(admin), c.rmaNumber, c.ticketId)')
    expect(a.indexOf('provenTicketId')).toBeLessThan(a.indexOf('.insert('))
    expect(a).toContain('ticket_id: provenId')
    expect(a).toContain('parent.ticket_id !== provenId')
    expect(a).not.toContain('ticket_id: c.ticketId')
  })

  it('answers an unproven request the same way whatever was wrong', () => {
    expect(section('comments')).toContain("json({ error: 'Ticket not found' }, 404)")
    expect(section('addComment')).toContain("json({ error: 'Ticket not found' }, 404)")
  })

  it('returns only public columns from an insert', () => {
    const a = section('addComment')
    expect(a).toContain('.select(COMMENT_PUBLIC_COLUMNS)')
    expect(a).not.toMatch(/\.insert\(\[[a-z]+\]\)\.select\(\)/)
  })

  it('parses', async () => {
    const esbuild = await import('esbuild')
    await expect(
      esbuild.build({ entryPoints: ['supabase/functions/public-track/index.ts'], bundle: false, write: false, loader: { '.ts': 'ts' }, format: 'esm' })
    ).resolves.toBeTruthy()
  })
})

describe('the tracker sends the RMA number', () => {
  it('the page passes the ticket’s own number to both calls', () => {
    const page = readFileSync('src/pages/RMATracker.jsx', 'utf8')
    expect(page).toContain('getPublicComments(found.id, found.rma_number)')
    expect(page).toMatch(/addComment\(\s*ticket\.id,\s*ticket\.rma_number,/)
  })

  it('the client API puts it in both request bodies', async () => {
    const invoke = vi.fn(async () => ({ data: { comments: [], comment: { id: 'c' } }, error: null }))
    vi.doMock('../api/client.js', () => ({ supabase: { functions: { invoke } } }))
    const { rmaTracker } = await import('../api/db/tickets')
    await rmaTracker.getPublicComments(ID, 'RMA-15092026-0001')
    await rmaTracker.addComment(ID, 'RMA-15092026-0001', 'Ann', 'ann@example.com', 'hello')
    expect(invoke.mock.calls[0][1].body).toEqual({ action: 'comments', ticketId: ID, rmaNumber: 'RMA-15092026-0001' })
    expect(invoke.mock.calls[1][1].body.comment).toMatchObject({ ticketId: ID, rmaNumber: 'RMA-15092026-0001', authorName: 'Ann' })
  })
})
