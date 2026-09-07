/**
 * attachmentUrl.test.js — BUG-023.
 *
 * Customer attachments arrive through the public tracker, which needs no
 * account. They were stored as whatever JSON was posted and rendered by staff
 * as `<a href={att.url}>` with the poster's own text as the label — so a
 * stranger could put `javascript:` or a lookalike host behind "invoice.pdf",
 * inside the staff UI, on a ticket staff already trust.
 */
import { describe, it, expect } from 'vitest'
import { safeAttachmentUrl, safeAttachmentHref } from '../lib/attachmentUrl'

// Matches the VITE_SUPABASE_URL the test env resolves to.
const ORIGIN = new URL(
  import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co'
).origin

describe('safeAttachmentUrl — rejects', () => {
  it('a javascript: URL, which is the exploit in the finding', () => {
    expect(safeAttachmentUrl('javascript:alert(1)')).toBeNull()
  })

  it('data: and vbscript: URLs', () => {
    expect(safeAttachmentUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeAttachmentUrl('vbscript:msgbox(1)')).toBeNull()
  })

  it('a different host entirely', () => {
    expect(safeAttachmentUrl('https://evil.example/invoice.pdf')).toBeNull()
  })

  it('a host that merely CONTAINS the expected origin as text', () => {
    // The reason this is an origin comparison and not a substring test.
    expect(safeAttachmentUrl(`https://evil.example/?x=${ORIGIN}`)).toBeNull()
    expect(safeAttachmentUrl(`https://evil.example#${ORIGIN}`)).toBeNull()
  })

  it('a lookalike subdomain', () => {
    const host = new URL(ORIGIN).host
    expect(safeAttachmentUrl(`https://${host}.evil.example/x.pdf`)).toBeNull()
  })

  it('plain http even on the right host', () => {
    expect(safeAttachmentUrl(ORIGIN.replace('https:', 'http:') + '/x.pdf')).toBeNull()
  })

  it('empty, null and non-string values', () => {
    expect(safeAttachmentUrl('')).toBeNull()
    expect(safeAttachmentUrl(null)).toBeNull()
    expect(safeAttachmentUrl(undefined)).toBeNull()
    expect(safeAttachmentUrl(42)).toBeNull()
    expect(safeAttachmentUrl({ url: 'x' })).toBeNull()
  })

  it('a relative path, which is not a URL', () => {
    expect(safeAttachmentUrl('/storage/v1/object/public/x.pdf')).toBeNull()
  })
})

describe('safeAttachmentUrl — accepts', () => {
  it('a genuine attachment on the project origin', () => {
    const url = `${ORIGIN}/storage/v1/object/public/rma-attachments/inv.pdf`
    expect(safeAttachmentUrl(url)).toBe(url)
  })

  it('one with a query string', () => {
    const url = `${ORIGIN}/storage/v1/object/sign/rma-attachments/a.pdf?token=abc`
    expect(safeAttachmentUrl(url)).toBe(url)
  })
})

describe('safeAttachmentHref', () => {
  it('returns undefined for an unsafe URL so no href is emitted at all', () => {
    expect(safeAttachmentHref('javascript:alert(1)')).toBeUndefined()
  })

  it('passes a safe URL through', () => {
    const url = `${ORIGIN}/storage/v1/object/public/rma-attachments/a.pdf`
    expect(safeAttachmentHref(url)).toBe(url)
  })
})
