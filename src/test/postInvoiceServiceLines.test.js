// @vitest-environment node
/**
 * postInvoiceServiceLines.test.js — 20260886.
 *
 * post_invoice's "the stock this invoice bills must be reserved" check counted
 * service lines (stock_tracking_mode defaults to 'serialized' for them too), and
 * funnel_reserve_line never reserves a service, so an order invoice with a
 * service on it could never be posted. supabase/tests/post_invoice_service_lines.sql
 * failed on the first check before the fix and passes after it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const sql = readFileSync('supabase/migrations/20260886_post_invoice_service_lines.sql', 'utf8')

describe('post_invoice and service lines', () => {
  it('leaves service lines out of the serialized units it expects to be reserved', () => {
    expect(sql).toMatch(/WHERE p\.stock_tracking_mode = 'serialized'[\s\S]{0,400}AND p\.product_type IS DISTINCT FROM 'service';/)
  })

  it('keeps the precondition itself (an unreserved serialized line is still refused)', () => {
    expect(sql).toContain('Cannot post this invoice: it bills % serialized unit(s) but only % are reserved')
  })

  it('redefines the same function, so its grants are kept', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.post_invoice\(p_invoice_id uuid, p_actor_email text\)/)
  })
})
