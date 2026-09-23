// @vitest-environment node
/**
 * supplierInvoicePoAmendment.test.js — BL-10 / I-06.
 *
 * The behaviour is proven against a real database in
 * supabase/tests/supplier_invoice_po_amendment.sql (60/60 on staging). Pinned
 * here: the migration keeps what makes each control hold, and the browser
 * client and screens speak the new contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260881_supplier_invoice_po_amendment.sql', 'utf8')

function fn(name) {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  expect(start, name + ' not found').toBeGreaterThan(-1)
  const end = migration.indexOf('$function$;', migration.indexOf('AS $function$', start))
  return migration.slice(start, end)
}
const header = (name) => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(')
  return migration.slice(start, migration.indexOf('AS $function$', start))
}

describe('supplier invoice identity', () => {
  it('is unique per supplier, ignoring case and spaces, per year, over live invoices only', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX vendor_invoices_supplier_no_uniq/)
    expect(migration).toMatch(/public\.rma_norm_supplier_no\(supplier_invoice_no\)/)
    expect(migration).toMatch(/WHERE supplier_invoice_no IS NOT NULL AND status <> 'cancelled'/)
  })

  it('uses only immutable expressions in the index (a timestamptz year would be rejected)', () => {
    const idx = migration.slice(migration.indexOf('CREATE UNIQUE INDEX'), migration.indexOf('-- ── the vendor-invoice identity'))
    expect(idx).toContain("created_at AT TIME ZONE 'UTC'")
    // the year is the year it was entered: a supplier date the client types must not move it
    expect(idx).not.toContain('supplier_invoice_date')
    expect(idx).not.toMatch(/now\(\)|current_date/i)
  })

  it('requires the number before a draft is submitted, and names the invoice already on file', () => {
    const body = fn('rma_guard_vendor_invoice_identity')
    expect(body).toMatch(/OLD\.status = 'draft' AND NEW\.status = 'pending_approval'/)
    expect(body).toContain("Enter the supplier''s own invoice number")
    expect(body).toContain('has already been entered for this supplier')
  })

  it('asks for a reason on a near-duplicate: same supplier and currency, within 1% and 30 days', () => {
    const body = fn('rma_guard_vendor_invoice_identity')
    expect(body).toMatch(/abs\(o\.total - NEW\.total\) <= NEW\.total \* 0\.01/)
    expect(body).toMatch(/<= 30/)
    expect(body).toMatch(/o\.currency = NEW\.currency/)
    expect(body).toMatch(/length\(COALESCE\(NEW\.duplicate_override_reason, ''\)\) < 10/)
  })

  it('escapes the literal percent sign in its RAISE message (an unescaped one broke the whole migration)', () => {
    expect(migration).toContain('an amount within 1%% and within 30 days')
  })
})

describe('review findings: bypasses of the approval and duplicate rules', () => {
  const body = fn('rma_guard_vendor_invoice_identity')

  it('normalises the number past non-breaking and zero-width spaces', () => {
    const norm = fn('rma_norm_supplier_no')
    expect(norm).toContain('\\u00a0')
    expect(norm).toContain('\\u200b')
    expect(header('rma_norm_supplier_no')).toMatch(/IMMUTABLE/)
  })

  it('will not let created_by be rewritten in the statement that approves the invoice', () => {
    expect(body).toMatch(/NEW\.created_by := OLD\.created_by/)
    expect(body).toMatch(/NEW\.created_at := OLD\.created_at/)
  })

  it('locks supplier, order, currency, amounts, lines and supplier number once it has left draft', () => {
    const at = body.indexOf("IF OLD.status <> 'draft'")
    const lock = body.slice(at, body.indexOf('RAISE EXCEPTION', at))
    for (const c of ['vendor_id', 'purchase_order_id', 'currency', 'total', 'subtotal', 'line_items', 'supplier_invoice_no', 'supplier_invoice_date']) {
      expect(lock, c).toContain('NEW.' + c + ' IS DISTINCT FROM')
    }
  })

  it('treats a missing approver or creator as a refusal, not a pass (a NULL comparison would not fire)', () => {
    expect(body).toMatch(/v_approver IS NULL/)
    expect(body).toMatch(/COALESCE\(lower\(v_approver\) = lower\(NEW\.created_by\), true\)/)
  })
})

describe('who approves, and creating past the approval', () => {
  const body = fn('rma_guard_vendor_invoice_identity')

  it('requires a reason on an invoice with no purchase order', () => {
    expect(body).toMatch(/NEW\.purchase_order_id IS NULL AND length\(COALESCE\(NEW\.non_po_reason, ''\)\) < 10/)
  })

  it('will not let the creator approve a non-PO invoice, and records the approver from the login', () => {
    expect(body).toMatch(/OLD\.status = 'pending_approval' AND NEW\.status = 'approved'/)
    expect(body).toMatch(/NEW\.approved_by := v_approver/)
    expect(body).toMatch(/lower\(v_approver\) = lower\(NEW\.created_by\)/)
  })

  it('creates a vendor invoice and a purchase order only as a draft from the client', () => {
    expect(body).toMatch(/TG_OP = 'INSERT' THEN\s+-- [^\n]*\n\s+IF NEW\.status <> 'draft'/)
    expect(fn('rma_guard_purchase_order_client_writes')).toMatch(/NEW\.status <> 'draft'/)
  })

  it('polices the client surface only, so receive/payment RPCs and Backup & Restore are unaffected', () => {
    for (const name of ['rma_guard_vendor_invoice_identity', 'rma_guard_purchase_order_client_writes']) {
      expect(fn(name), name).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
      expect(header(name), name).not.toMatch(/SECURITY DEFINER/)
    }
  })

  it('keeps the revision number out of client hands', () => {
    expect(fn('rma_guard_purchase_order_client_writes')).toMatch(/NEW\.revision_no := OLD\.revision_no/)
  })
})

describe('amend_purchase_order', () => {
  const body = fn('amend_purchase_order')

  it('needs a manager and a reason of at least 10 characters', () => {
    expect(body).toMatch(/NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    expect(body).toMatch(/length\(v_reason\) < 10/)
  })

  it('amends only a confirmed order with no live vendor invoice against it', () => {
    expect(body).toMatch(/v_po\.status <> 'confirmed'/)
    expect(body).toMatch(/purchase_order_id = p_po_id AND status <> 'cancelled'/)
  })

  it('never changes the supplier, currency or status', () => {
    const settable = body.slice(body.indexOf('v_settable text[]'), body.indexOf('v_derived'))
    for (const k of ['vendor_id', 'currency', 'exchange_rate', 'status', 'po_code']) {
      expect(settable, k).not.toContain(`'${k}'`)
    }
  })

  it('ignores the totals the caller sends and recomputes them from the lines', () => {
    expect(body).toMatch(/v_derived\s+text\[\] := ARRAY\['subtotal', 'discount_amount', 'tax_amount', 'total'\]/)
    expect(body).toMatch(/v_new_total := round\(v_sub - v_dsum \+ v_tsum, 2\)/)
    // the stored total comes from v_new_total, never from p_changes
    expect(body).not.toMatch(/p_changes ->> 'total'/)
  })

  it('sends it back for approval when the value rises or any price, discount or tax changes', () => {
    expect(body).toMatch(/v_reapprove := v_price_changed OR v_new_total > v_po\.total/)
    expect(body).toMatch(/status\s+= CASE WHEN v_reapprove THEN 'pending_confirmation' ELSE status END/)
  })

  it('snapshots the order before changing it and bumps the revision', () => {
    expect(body.indexOf('INSERT INTO public.purchase_order_revisions')).toBeLessThan(body.indexOf('UPDATE public.purchase_orders'))
    expect(body).toMatch(/revision_no\s+= revision_no \+ 1/)
  })

  it('validates every line as text before casting, so a malformed quantity gets a clear refusal', () => {
    expect(body).toMatch(/!~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'/)
  })

  it('pins pg_temp last and is not executable by anon', () => {
    expect(body).toBeTruthy()
    expect(header('amend_purchase_order')).toMatch(/SET search_path TO 'public', 'pg_temp'/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.amend_purchase_order\(uuid, jsonb, text, text\) FROM PUBLIC, anon/)
  })
})

describe('reopening a confirmed order is the RPC\'s alone', () => {
  const body = fn('assert_purchase_status_transition')

  it('allows confirmed -> pending_confirmation only while the amend flag is on', () => {
    expect(body).toMatch(/OLD\.status = 'confirmed' AND current_setting\('rma\.po_amend', true\) = 'on'/)
    expect(body).toContain("array_append(v_allowed, 'pending_confirmation'::text)")
  })

  it('sets the flag for the RPC\'s own transaction only, and clears it', () => {
    const amend = fn('amend_purchase_order')
    expect(amend).toContain("set_config('rma.po_amend', 'on', true)")
    expect(amend).toContain("set_config('rma.po_amend', 'off', true)")
  })

  it('keeps every other transition exactly as it was', () => {
    expect(body).toMatch(/WHEN 'confirmed'\s+THEN ARRAY\['partially_completed', 'completed', 'cancelled', 'expired'\]/)
    expect(body).toMatch(/WHEN 'approved'\s+THEN ARRAY\['partially_received', 'received', 'cancelled'\]/)
  })
})

describe('the revisions table', () => {
  it('is readable by managers and accountants, and written by nobody but the RPC', () => {
    expect(migration).toMatch(/CREATE POLICY manager_read_po_revisions[\s\S]{0,200}rma_is_manager_or_above\(\) OR public\.rma_user_role\(\) = 'accountant'/)
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.purchase_order_revisions FROM authenticated/)
  })

  it('cannot hold two versions with the same number for one order', () => {
    expect(migration).toMatch(/UNIQUE \(po_id, rev_no\)/)
  })
})

describe('no new function is executable by anon', () => {
  it('revokes PUBLIC and anon on each', () => {
    for (const sig of ['rma_guard_vendor_invoice_identity\\(\\)', 'rma_guard_purchase_order_client_writes\\(\\)', 'amend_purchase_order\\(uuid, jsonb, text, text\\)']) {
      expect(migration, sig).toMatch(new RegExp('REVOKE ALL ON FUNCTION public\\.' + sig + ' FROM PUBLIC, anon'))
    }
  })
})

// ── The browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpcCalls: [], updates: [], inserted: [], rpcResult: { data: null, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpcCalls.push({ name, args })
      return Promise.resolve(mocks.rpcResult)
    },
    from: (table) => ({
      insert: (rows) => {
        mocks.inserted.push({ table, rows })
        return { select: () => Promise.resolve({ data: rows, error: null }) }
      },
      update: (patch) => {
        mocks.updates.push({ table, patch })
        return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'x' }], error: null }) }) }
      },
      select: () => ({
        eq: () => ({ order: () => ({ range: () => Promise.resolve({ data: [{ rev_no: 2 }, { rev_no: 1 }], error: null }) }) }),
      }),
    }),
  },
}))

const { purchaseOrders, vendorInvoices } = await import('../api/db/purchasing')

describe('purchasing client', () => {
  beforeEach(() => {
    mocks.rpcCalls.length = 0
    mocks.updates.length = 0
    mocks.inserted.length = 0
    mocks.rpcResult = { data: { id: 'po-1', status: 'pending_confirmation', revision_no: 2 }, error: null }
  })

  it('amends through the RPC with the reason and the actor', async () => {
    const row = await purchaseOrders.amend('po-1', { payment_terms: 'net 60' }, 'Supplier agreed longer terms', 'a@b.c')
    expect(mocks.rpcCalls[0]).toEqual({
      name: 'amend_purchase_order',
      args: { p_po_id: 'po-1', p_changes: { payment_terms: 'net 60' }, p_reason: 'Supplier agreed longer terms', p_actor_email: 'a@b.c' },
    })
    expect(row.revision_no).toBe(2)
  })

  it('throws the database\'s refusal so the screen can show it', async () => {
    mocks.rpcResult = { data: null, error: { code: 'P0001', message: 'Only a confirmed purchase order is amended' } }
    await expect(purchaseOrders.amend('po-1', { notes: 'x' }, 'A long enough reason', 'a@b.c')).rejects.toMatchObject({ code: 'P0001' })
  })

  it('reads the revision history newest first', async () => {
    const rows = await purchaseOrders.revisions('po-1')
    expect(rows.map((r) => r.rev_no)).toEqual([2, 1])
  })

  it('creates a vendor invoice with the supplier number, date and non-PO reason', async () => {
    await vendorInvoices.create({
      vendorId: 'v1', lineItems: [], currency: 'EGP', createdBy: 'a@b.c',
      supplierInvoiceNo: 'INV-778', supplierInvoiceDate: '2026-09-01', nonPoReason: 'Emergency freight, no PO',
    })
    // since 20260889 through create_vendor_invoice, not a direct insert
    expect(mocks.inserted).toEqual([])
    expect(mocks.rpcCalls[0].name).toBe('create_vendor_invoice')
    expect(mocks.rpcCalls[0].args.p_fields).toMatchObject({ supplier_invoice_no: 'INV-778', supplier_invoice_date: '2026-09-01', non_po_reason: 'Emergency freight, no PO' })
  })

  it('submits for approval with no override by default, and with a trimmed one when given', async () => {
    await vendorInvoices.submitForApproval('vi-1')
    await vendorInvoices.submitForApproval('vi-1', '  Second delivery, billed separately  ')
    expect(mocks.updates[0].patch).toEqual({ status: 'pending_approval' })
    expect(mocks.updates[1].patch).toEqual({ status: 'pending_approval', duplicate_override_reason: 'Second delivery, billed separately' })
  })
})

describe('the screens', () => {
  const modals = readFileSync('src/pages/Purchasing/_modals.jsx', 'utf8')
  const detail = readFileSync('src/pages/Purchasing/PurchaseDocumentDetail.jsx', 'utf8')

  it('the vendor invoice form captures the supplier number, date and, with no PO, a reason', () => {
    expect(modals).toContain('supplier_invoice_no: supplierNo.trim() || null')
    expect(modals).toContain('nonPoReason: nonPoReason.trim() || undefined')
    expect(modals).toMatch(/!initial\?\.purchase_order_id && \(/)
  })

  it('asks for a reason instead of dead-ending on a suspected duplicate', () => {
    expect(detail).toMatch(/looks like a duplicate/i)
    expect(detail).toContain('setShowDuplicate(true)')
    expect(detail).toContain('submitVI(reason)')
  })

  it('offers Amend only on a confirmed order, and re-raises the approval when it goes back for one', () => {
    expect(detail).toMatch(/!poIsConverted && doc\.status === 'confirmed' && \(\s*<Button[\s\S]{0,160}setShowAmend\(true\)/)
    expect(detail).toMatch(/row\?\.status === 'pending_confirmation'\) await createPOApprovalActivity\(\)/)
  })

  it('shows the revision history of an amended order', () => {
    expect(detail).toContain('db.purchaseOrders.revisions(docId)')
  })

  it('the amend form sends only what changed, and needs a reason before it will save', () => {
    expect(modals).toContain('if (linesChanged) changes.line_items = lines')
    expect(modals).toMatch(/const valid = anyChange && reason\.trim\(\)\.length >= REASON_MIN/)
  })

  it('has every new string in English and Arabic', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).purchasing
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).purchasing
    const keys = ['supplierInvoiceNo', 'supplierInvoiceDate', 'supplierInvoiceHint', 'nonPoReason', 'nonPoReasonPlaceholder',
      'duplicateTitle', 'duplicateBody', 'duplicateReason', 'duplicatePlaceholder', 'duplicateConfirm', 'reasonMin', 'approvedBy',
      'revision', 'revisionLabel', 'revisionHistory', 'amendOrder', 'amendTitle', 'amendHint', 'amendReason', 'amendReasonPlaceholder',
      'amendNeedsApproval', 'amendConfirm', 'amendedToast', 'amendedNeedsApprovalToast']
    for (const k of keys) {
      expect(en[k], 'en ' + k).toBeTruthy()
      expect(ar[k], 'ar ' + k).toBeTruthy()
    }
  })
})
