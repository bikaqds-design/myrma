// @vitest-environment node
/**
 * baselineSeedData.test.js — BL-04: a tenant provisioned from the baseline
 * gets the rows the code assumes exist.
 *
 * The behaviour is proven against a real database in
 * supabase/tests/baseline_seed_data.sql (24/24 on staging). What is pinned
 * here is what that file cannot see from inside one project: that the
 * provisioning script actually applies the seed, and that the seed keeps the
 * properties that make it safe to hand to a stranger — no credential, no
 * single tenant's URL or Meta ids, and messaging off until someone turns it on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const seed = readFileSync('supabase/migrations/00000002_baseline_seed_data.sql', 'utf8')
const reference = readFileSync('supabase/migrations/00000001_baseline_reference_data.sql', 'utf8')
const provisioner = readFileSync('scripts/provision-project.mjs', 'utf8')

/** The text of one INSERT statement, so an assertion cannot be satisfied by a comment elsewhere. */
function statement(table) {
  const start = seed.indexOf('INSERT INTO public.' + table)
  expect(start, 'INSERT INTO public.' + table + ' not found').toBeGreaterThan(-1)
  const end = seed.indexOf('WHERE NOT EXISTS', start)
  return seed.slice(start, end)
}

describe('provisioning applies the seed', () => {
  it('lists the seed file after the schema and the reference data', () => {
    // The seed inserts into tables the schema creates, so order is the contract.
    const list = provisioner.match(/const ALL_FILES = \[([^\]]*)\]/)
    expect(list, 'ALL_FILES not found').not.toBeNull()
    expect(list[1].replace(/\s+/g, ' ').trim()).toBe(
      "'00000000_baseline_schema.sql', '00000001_baseline_reference_data.sql', SEED_FILE"
    )
    expect(provisioner).toContain("const SEED_FILE = '00000002_baseline_seed_data.sql'")
  })
})

describe('the seed carries nothing that belongs to one tenant', () => {
  it('has no bearer token, access token or pasted curl command', () => {
    // Production's ticket_created WhatsApp body holds a live Meta token; the
    // seed is written from the declared variables instead of copied from it.
    expect(seed).not.toMatch(/EAA[A-Za-z0-9]{20,}/)
    expect(seed.toLowerCase()).not.toMatch(/bearer |access_token|authorization:/)
    expect(seed).not.toMatch(/curl /)
  })

  it('has no phone number id or business account id', () => {
    expect(seed).not.toMatch(/phone_number_id|business_account_id/)
    expect(seed).not.toMatch(/\b\d{15,16}\b/)
  })

  it('has no deployment URL and no real e-mail address', () => {
    expect(seed).not.toMatch(/https?:\/\//)
    // example.invalid is reserved for tests; anything else would be a person.
    const emails = seed.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []
    expect(emails.filter((e) => !e.endsWith('example.invalid'))).toEqual([])
  })
})

describe('the seed is safe to run more than once', () => {
  it('guards every insert, so re-running changes nothing', () => {
    const inserts = seed.match(/INSERT INTO public\.\w+/g) ?? []
    expect(inserts.length).toBeGreaterThan(0)
    // Each INSERT ... SELECT block ends in a NOT EXISTS guard.
    expect((seed.match(/WHERE NOT EXISTS/g) ?? []).length).toBe(inserts.length)
  })
})

describe('a new tenant does not message anyone until it is told to', () => {
  it('seeds the channel switches off', () => {
    for (const key of ['whatsapp_enabled', 'email_enabled', 'sms_enabled']) {
      expect(seed).toMatch(new RegExp(`\\('${key}',\\s*'false'\\)`))
    }
  })

  it('seeds WhatsApp templates as pending, not active', () => {
    // Their Meta template names are not registered in a new tenant's account,
    // so 'active' would mean sends that Meta rejects. Assert on the INSERT
    // itself: the word also appears in the header comment, and if the status
    // column were dropped the table default is 'active'.
    const insert = statement('whatsapp_templates')
    expect(insert).toMatch(/body_content, variables, attach_pdf, status\)/)
    expect(insert).toContain("'pending_approval'")
  })

  it('uses the dotted event names the handlers emit', () => {
    // event_type is the THIRD column. An underscore form (crm_deal_won) would
    // insert cleanly, since nothing constrains it, and never match a lookup.
    // 'crm_deal_won' is fine in the FIRST column: that is the template's name.
    for (const [name, event] of [
      ['crm_lead_assigned', 'crm.lead_assigned'],
      ['crm_deal_won', 'crm.deal_won'],
      ['crm_followup_due', 'crm.followup_due'],
      ['crm_deal_overdue', 'crm.deal_overdue'],
    ]) {
      expect(seed).toMatch(new RegExp("\\('" + name + "', 'CRM[^']*', '" + event.replace('.', '\\.') + "'"))
    }
  })

  it('seeds the crm.* notification events with the application defaults', () => {
    // An absent key reads as enabled (flags[event] !== false).
    expect(seed).toContain('"crm.followup_due":false')
    expect(seed).toContain('"crm.deal_overdue":false')
    expect(seed).toContain('"crm.lead_assigned":true')
    expect(seed).toContain('"crm.deal_won":true')
  })
})

describe('the rows the app cannot start without', () => {
  it('seeds every document sequence nextval_for_type knows a prefix for', () => {
    for (const t of ['invoice', 'credit_note', 'payment', 'vendor_invoice', 'vendor_payment', 'batch']) {
      expect(seed).toContain(`('${t}')`)
    }
  })

  it('seeds all eight system locations the RMA auto-move resolves by code', () => {
    for (const code of ['RMA-RECEIVED', 'RMA-REPAIR', 'RMA-REPAIRED', 'RMA-CANTREPAIR', 'RMA-STOCK', 'REPLACEMENT', 'CREDIT-NOTE', 'SCRAP']) {
      expect(seed).toContain(`'${code}'`)
    }
  })

  it('never types a system location as sellable', () => {
    // main/branch (and a NULL type, which reads as legacy-sellable) would make
    // RMA intake count as stock available to sell.
    const rows = statement('warehouses')
    expect(rows).not.toMatch(/'(main|branch)'/)
    expect(rows).toMatch(/'SCRAP'[\s\S]{0,120}'virtual'/)
  })

  it('seeds a pipeline with a won and a lost stage', () => {
    expect(seed).toMatch(/"is_won":true/)
    expect(seed).toMatch(/"is_lost":true/)
  })
})

describe('the reference data carries no tenant identity', () => {
  it('leaves the company name, phone and address on the PDF layouts blank', () => {
    // Both rows were first exported from QDS Egypt; left in, every other
    // tenant would print QDS's name and address on its own invoices.
    const data = reference.split('\n').filter((l) => l.startsWith('INSERT')).join('\n')
    expect(data).not.toMatch(/QDS|Quality Durable|Zamalek|Ahmed Heshmat/)
    expect(data).not.toMatch(/"company(Name|Phone|Address)": "[^"]+"/)
  })

  it('has no BEGIN/COMMIT of its own, so the provisioner owns the transaction', () => {
    // A COMMIT here committed the schema before a later file could fail, and a
    // "roll back everything" claim was false until this was removed.
    expect(reference).not.toMatch(/^(BEGIN|COMMIT);/m)
  })
})

describe('the provisioner is all-or-nothing', () => {
  it('opens one transaction around every file and commits once, after the last', () => {
    expect((provisioner.match(/query\('begin'\)/g) ?? []).length).toBe(1)
    expect((provisioner.match(/query\('commit'\)/g) ?? []).length).toBe(1)
    expect(provisioner.indexOf("query('begin')")).toBeLessThan(provisioner.indexOf('for (const file of FILES)'))
    expect(provisioner.indexOf("query('commit')")).toBeGreaterThan(provisioner.indexOf('for (const file of FILES)'))
  })

  it('offers --no-seed for a project that will be filled from a backup', () => {
    expect(provisioner).toContain("hasFlag('no-seed')")
    expect(provisioner).toContain('rma_reconcile_document_sequences')
  })
})
