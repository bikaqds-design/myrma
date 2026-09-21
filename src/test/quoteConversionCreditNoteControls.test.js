// @vitest-environment node
/**
 * quoteConversionCreditNoteControls.test.js — BL-05 / I-05.
 *
 * The behaviour is proven against a real database in
 * supabase/tests/quote_conversion_credit_note_controls.sql (75/75 on staging).
 * Pinned here: the migration keeps what makes each control hold, and the
 * browser client speaks the new contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260880_quote_conversion_credit_note_controls.sql', 'utf8')

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

describe('convert_quotation_to_so', () => {
  const body = fn('convert_quotation_to_so')

  it('converts only an accepted quotation', () => {
    expect(body).toMatch(/v_qt\.status <> 'accepted'/)
  })

  it('needs a manager and a real reason (10+ characters) to convert an expired one', () => {
    expect(body).toMatch(/v_qt\.validity_until < public\.rma_today\(\)/)
    expect(body).toMatch(/NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    expect(body).toMatch(/length\(v_reason\) < 10/)
  })

  it("judges 'expired' by the tenant's own date, not the server's UTC date", () => {
    expect(body).not.toMatch(/current_date/i)
    expect(fn('rma_today')).toMatch(/config_key = 'timezone'/)
  })

  it('takes the actor from the login, and records the override on the order', () => {
    expect(body).toMatch(/COALESCE\(public\.rma_current_user_email\(\), p_actor_email\)/)
    expect(body).toContain('override_reason')
  })

  it('drops the two-argument overload, so no call can route round the new rules', () => {
    expect(migration).toMatch(/DROP FUNCTION IF EXISTS public\.convert_quotation_to_so\(uuid, text\);/)
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.convert_quotation_to_so\(uuid, text, text\) FROM PUBLIC, anon/)
  })
})

describe('credit-note limits', () => {
  const body = fn('_credit_note_assert_within_caps')

  it('caps a credit note at the invoice total minus what was already issued', () => {
    expect(body).toMatch(/v_cn\.total > v_inv\.total - v_prior/)
    // Only issued/applied notes count: not drafts, not voided ones.
    expect(body).toMatch(/c\.status IN \('issued', 'applied'\)/)
  })

  it('locks the invoice so two notes issued at once cannot share the same room', () => {
    expect(body).toMatch(/FROM public\.crm_invoices WHERE id = v_cn\.source_invoice_id FOR UPDATE/)
  })

  it('requires a posted invoice belonging to the same customer', () => {
    expect(body).toMatch(/v_inv\.doc_status <> 'posted'/)
    expect(body).toMatch(/v_inv\.customer_id <> v_cn\.customer_id/)
  })

  it('also caps the units a return or correction credits, per product', () => {
    expect(body).toMatch(/v_cn\.type IN \('rma_return', 'correction'\)/)
    expect(body).toMatch(/v_line\.qty \+ v_done > v_sold/)
  })

  it('is not callable by a client role', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\._credit_note_assert_within_caps\(uuid\) FROM PUBLIC, anon, authenticated/)
  })
})

describe('issue_credit_note', () => {
  const body = fn('issue_credit_note')

  it('needs a reason code', () => {
    expect(body).toMatch(/v_cn\.reason_code IS NULL/)
  })

  it('refuses a direct issue when approval is required, and the creator as approver', () => {
    expect(body).toMatch(/v_cn\.status = 'draft' AND v_needs/)
    expect(body).toMatch(/lower\(v_actor\) = lower\(v_cn\.created_by\)/)
  })

  it('checks the limits before it takes a number from the sequence', () => {
    expect(body.indexOf('_credit_note_assert_within_caps')).toBeGreaterThan(-1)
    expect(body.indexOf('_credit_note_assert_within_caps')).toBeLessThan(body.indexOf("nextval_for_type('credit_note')"))
  })

  it('records who approved and when', () => {
    expect(body).toMatch(/approved_by\s*=\s*v_approver/)
  })

  it('fails closed on a role-less caller', () => {
    expect(body).toMatch(/IF NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
  })
})

describe('what a rewrite is most likely to drop', () => {
  it('issue_credit_note still closes the originating ticket in the same transaction (BUG-048)', () => {
    const body = fn('issue_credit_note')
    expect(body).toContain('p_close_ticket AND v_cn.ticket_id IS NOT NULL')
    expect(body).toMatch(/ticket_status\s*=\s*'Closed'/)
  })

  it('convert_quotation_to_so still refuses free-form lines and a second sales order', () => {
    const body = fn('convert_quotation_to_so')
    expect(body).toContain('have no product')
    expect(body).toContain('Quotation already converted to a sales order')
  })
})

describe('the review fixes', () => {
  it('refuses a credit-note line with a malformed quantity instead of counting it as zero', () => {
    expect(fn('_credit_note_assert_within_caps')).toMatch(/!~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'[\s\S]{0,80}THEN\s+RAISE EXCEPTION 'A line on this credit note has an invalid quantity/)
  })

  it('asks for approval on an invoice-less correction as well as a rebate or discount, but not an RMA return', () => {
    const body = fn('rma_credit_note_needs_approval')
    expect(body).toMatch(/p_type IN \('rebate', 'discount', 'correction'\)/)
    expect(body).not.toMatch(/'rma_return'/)
  })

  it('lets only managers ask whether an amount needs approval (it would reveal the threshold)', () => {
    expect(fn('rma_credit_note_needs_approval')).toMatch(/NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
  })

  it('fingerprints a note when it is submitted and checks it when it is issued', () => {
    expect(fn('submit_credit_note_for_approval')).toContain('submitted_hash = md5(')
    expect(fn('issue_credit_note')).toContain('was changed after it was submitted for approval')
    expect(fn('return_credit_note_to_draft')).toContain('submitted_hash = NULL')
  })

  it('backfills existing drafts with a reason code, so they can still be issued', () => {
    expect(migration).toMatch(/UPDATE public\.credit_notes\s+SET reason_code = CASE type[\s\S]{0,300}WHERE reason_code IS NULL AND status = 'draft'/)
  })
})

describe('the approval rule', () => {
  it('always applies to an invoice-less rebate, discount or correction, and above the configured threshold', () => {
    const body = fn('rma_credit_note_needs_approval')
    expect(body).toMatch(/NOT p_has_invoice AND p_type IN \('rebate', 'discount', 'correction'\)/)
    expect(body).toMatch(/p_total > v_threshold/)
  })

  it('treats an unset or malformed threshold as "no threshold", never as an error at issue time', () => {
    expect(fn('rma_credit_note_needs_approval')).toMatch(/v_text !~ '\^\[0-9\]\+\(\\\.\[0-9\]\+\)\?\$'/)
  })

  it('adds the pending_approval status, and the coded reasons', () => {
    expect(migration).toMatch(/status IN \('draft', 'pending_approval', 'issued', 'applied', 'voided'\)/)
    for (const c of ['price_adjustment', 'return', 'damaged', 'goodwill', 'billing_error', 'rebate']) {
      expect(migration).toContain(`'${c}'`)
    }
  })

  it('only managers can submit or return a note', () => {
    for (const name of ['submit_credit_note_for_approval', 'return_credit_note_to_draft']) {
      expect(fn(name), name).toMatch(/NOT COALESCE\(public\.rma_is_manager_or_above\(\), false\)/)
    }
  })
})

describe('a credit note cannot be created past the controls', () => {
  const body = fn('rma_guard_credit_note_client_writes')

  it('only ever creates a draft from the client, in the signed-in user\'s name', () => {
    expect(body).toMatch(/NEW\.status <> 'draft'/)
    expect(body).toMatch(/NEW\.created_by\s*:=\s*COALESCE\(public\.rma_current_user_email\(\), NEW\.created_by\)/)
  })

  it('keeps every RPC-owned field out of client hands on update (each one pinned to its OLD value)', () => {
    // Split at the UPDATE branch: the INSERT branch also mentions these, and
    // used to satisfy a bare "contains NEW.x" check.
    const update = body.slice(body.indexOf('ELSE', body.indexOf("TG_OP = 'INSERT'")))
    for (const col of ['created_by', 'cn_code', 'issued_at', 'approved_by', 'approved_at', 'applied_amount', 'remaining_balance',
      'voided_at', 'voided_by', 'void_reason', 'ticket_id', 'submitted_hash']) {
      expect(update, col).toMatch(new RegExp('NEW\\.' + col + '\\s*:=\\s*OLD\\.' + col))
    }
  })

  it('refuses a status change outright, whoever asks (the transition guard exempts administrators)', () => {
    expect(body).toMatch(/NEW\.status IS DISTINCT FROM OLD\.status/)
  })

  it('refuses loudly an attempt to rewrite a protected field of a settled note', () => {
    expect(body).toMatch(/OLD\.status <> 'draft' AND \(/)
    expect(body).toContain('can no longer be edited directly')
  })

  it('fixes ticket_id, which decides which RMA ticket issue_credit_note closes', () => {
    expect(body).toMatch(/NEW\.ticket_id\s*:=\s*OLD\.ticket_id/)
  })

  it('polices the client surface only, so Backup & Restore (an RPC) is unaffected', () => {
    expect(body).toMatch(/current_user NOT IN \('authenticated', 'anon'\)/)
    expect(header('rma_guard_credit_note_client_writes')).not.toMatch(/SECURITY DEFINER/)
  })

  it('is attached to both INSERT and UPDATE', () => {
    expect(migration).toMatch(/CREATE TRIGGER trg_credit_notes_guard_client_writes\s+BEFORE INSERT OR UPDATE ON public\.credit_notes/)
  })
})

describe('the new functions are not executable by anon', () => {
  it('revokes PUBLIC and anon on each', () => {
    for (const sig of [
      'rma_today\\(\\)',
      'convert_quotation_to_so\\(uuid, text, text\\)',
      'rma_credit_note_needs_approval\\(text, boolean, numeric\\)',
      'submit_credit_note_for_approval\\(uuid, text\\)',
      'return_credit_note_to_draft\\(uuid, text\\)',
      'rma_guard_credit_note_client_writes\\(\\)',
    ]) {
      expect(migration, sig).toMatch(new RegExp('REVOKE ALL ON FUNCTION public\\.' + sig + ' FROM PUBLIC, anon'))
    }
  })

  it('pins pg_temp last in search_path', () => {
    for (const name of ['rma_today', 'convert_quotation_to_so', 'rma_credit_note_needs_approval', '_credit_note_assert_within_caps',
      'submit_credit_note_for_approval', 'return_credit_note_to_draft', 'issue_credit_note', 'rma_guard_credit_note_client_writes']) {
      expect(fn(name), name).toMatch(/SET search_path TO 'public', 'pg_temp'/)
    }
  })
})

// ── The browser client ──────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({ rpcCalls: [], inserted: [], rpcResult: { data: true, error: null } }))

vi.mock('../api/client.js', () => ({
  supabase: {
    rpc: (name, args) => {
      mocks.rpcCalls.push({ name, args })
      return Promise.resolve(mocks.rpcResult)
    },
    from: () => ({
      insert: (row) => {
        mocks.inserted.push(row)
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'cn-1', ...row }, error: null }) }) }
      },
    }),
  },
}))

const { creditNotes, CREDIT_NOTE_REASON_CODES } = await import('../api/db/creditNotes')
const { quotations } = await import('../api/db/quotations')

describe('creditNotes client', () => {
  beforeEach(() => {
    mocks.rpcCalls.length = 0
    mocks.inserted.length = 0
    mocks.rpcResult = { data: true, error: null }
  })

  it('offers exactly the six reason codes the database accepts', () => {
    expect([...CREDIT_NOTE_REASON_CODES]).toEqual(['price_adjustment', 'return', 'damaged', 'goodwill', 'billing_error', 'rebate'])
  })

  it('sends the reason code when it creates a credit note', async () => {
    await creditNotes.create({ type: 'discount', customer_id: 'c1', reason: 'r', reason_code: 'goodwill', created_by: 'a@b.c', line_items: [] })
    expect(mocks.inserted[0].reason_code).toBe('goodwill')
  })

  it('submits, returns and asks about approval through the RPCs', async () => {
    await creditNotes.submitForApproval('cn-1', 'a@b.c')
    await creditNotes.returnToDraft('cn-1', 'a@b.c')
    const needs = await creditNotes.needsApproval('rebate', false, 10)
    expect(mocks.rpcCalls.map((c) => c.name)).toEqual([
      'submit_credit_note_for_approval', 'return_credit_note_to_draft', 'rma_credit_note_needs_approval',
    ])
    expect(mocks.rpcCalls[2].args).toEqual({ p_type: 'rebate', p_has_invoice: false, p_total: 10 })
    expect(needs).toBe(true)
  })

  it('turns an RPC error into a thrown error the screen can show', async () => {
    mocks.rpcResult = { data: null, error: { code: 'P0001', message: 'needs approval' } }
    await expect(creditNotes.submitForApproval('cn-1', 'a@b.c')).rejects.toMatchObject({ code: 'P0001' })
  })
})

describe('quotations.convertToSalesOrder', () => {
  beforeEach(() => { mocks.rpcCalls.length = 0; mocks.rpcResult = { data: 'so-1', error: null } })

  it('passes no override by default', async () => {
    await quotations.convertToSalesOrder('q1', 'a@b.c')
    expect(mocks.rpcCalls[0].args).toEqual({ p_quotation_id: 'q1', p_actor_email: 'a@b.c', p_override_reason: null })
  })

  it('passes a trimmed override reason, and treats a blank one as none', async () => {
    await quotations.convertToSalesOrder('q1', 'a@b.c', '  the customer confirmed in writing  ')
    expect(mocks.rpcCalls[0].args.p_override_reason).toBe('the customer confirmed in writing')
    await quotations.convertToSalesOrder('q1', 'a@b.c', '   ')
    expect(mocks.rpcCalls[1].args.p_override_reason).toBeNull()
  })
})

describe('the screens', () => {
  const modals = readFileSync('src/pages/SalesDocuments/_modals.jsx', 'utf8')
  const detail = readFileSync('src/pages/SalesDocuments/SalesDocumentDetail.jsx', 'utf8')
  const activities = readFileSync('src/pages/Activities/index.jsx', 'utf8')

  it('will not create a credit note without a reason code', () => {
    expect(modals).toMatch(/const isValid = !!customerId && !!reasonCode/)
    expect(modals).toContain('reason_code: reasonCode')
  })

  it('submits a credit note that needs approval instead of issuing it', () => {
    expect(detail).toContain('db.creditNotes.needsApproval(')
    expect(detail).toContain('db.creditNotes.submitForApproval(')
  })

  it('disables "approve" for the person who made the note (the database refuses it too)', () => {
    expect(detail).toMatch(/currentUserEmail\?\.toLowerCase\(\) === doc\.created_by\?\.toLowerCase\(\)/)
  })

  it('asks for a reason before converting an expired quotation', () => {
    expect(detail).toContain('OverrideReasonModal')
    expect(detail).toContain('db.quotations.convertToSalesOrder(doc.id, currentUserEmail, reason)')
  })

  it('says why an approval was refused instead of a bare "Error"', () => {
    expect(activities).toMatch(/err\?\.code === 'P0001' && err\?\.message \? err\.message : t\('common\.error'\)/)
  })

  it('does not decide "expired" from the browser clock', () => {
    expect(detail).not.toMatch(/toLocaleDateString\('en-CA'\)/)
    expect(detail).toMatch(/err\?\.code === 'P0001' && \/expired\/i\.test/)
  })

  it('submits from the RMA ticket path when a credit note needs approval', () => {
    const drawer = readFileSync('src/pages/RMATickets/TicketDrawer.jsx', 'utf8')
    expect(drawer).toContain('db.creditNotes.needsApproval(')
    expect(drawer).toContain('db.creditNotes.submitForApproval(')
  })

  it('shows "awaiting approval" in the list with its own colour', () => {
    expect(readFileSync('src/pages/SalesDocuments/index.jsx', 'utf8')).toMatch(/pending_approval:\s+'bg-amber-100/)
  })

  it('rejecting a credit note in the approval pool sends it back to draft rather than voiding it', () => {
    expect(activities).toMatch(/case 'credit_note':\s+return db\.creditNotes\.returnToDraft\(/)
  })

  it('has every new string in English and Arabic', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).salesDocuments
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).salesDocuments
    const keys = ['st_pending_approval', 'cnReasonCode', 'cnReasonCodeChoose', 'cnApproveIssue', 'cnReturnToDraft', 'cnSubmittedToast',
      'cnReturnedToast', 'cnAwaitingApproval', 'convertExpiredTitle', 'convertExpiredBody', 'convertExpiredReason',
      'convertExpiredPlaceholder', 'convertExpiredMin', 'convertExpiredConfirm',
      ...['price_adjustment', 'return', 'damaged', 'goodwill', 'billing_error', 'rebate'].map((c) => 'cnReasonCode_' + c)]
    for (const k of keys) {
      expect(en[k], 'en ' + k).toBeTruthy()
      expect(ar[k], 'ar ' + k).toBeTruthy()
    }
  })
})

describe('the approval limit can be set from the app', () => {
  const screen = readFileSync('src/pages/cp/setup/RegionalSettings.jsx', 'utf8')

  it('has a field that saves credit_note_approval_threshold', () => {
    expect(screen).toContain("useConfigValue('credit_note_approval_threshold'")
    expect(screen).toContain("write('credit_note_approval_threshold'")
  })

  it('stores "no limit" as an empty string, because config_value is NOT NULL, and refuses a malformed number', () => {
    expect(screen).toMatch(/creditBlank \? '' : creditNumber/)
    expect(screen).toMatch(/\^\[0-9\]\+\(\\.\[0-9\]\+\)\?\$/)
    expect(screen).toMatch(/disabled=\{busy \|\| !creditValid \|\| draftCredit === null\}/)
  })

  it('has its strings in English and Arabic', () => {
    const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8')).cp.setup
    const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8')).cp.setup
    for (const k of ['creditTitle', 'creditHint', 'creditThreshold', 'creditNoLimit', 'creditInvalid', 'creditAlways']) {
      expect(en[k], 'en ' + k).toBeTruthy()
      expect(ar[k], 'ar ' + k).toBeTruthy()
    }
  })
})
