/**
 * backupCoverage.test.js — the backup manifest must not drift from the app.
 *
 * This is the test that was missing. src/api/backup.js exported 9 tables and
 * restored 5, out of the 53 the application uses, while the screen said
 * "Complete backup includes all system data". Nothing compared the two lists,
 * so the gap grew silently every time a module was added — the CRM, accounting,
 * purchasing and inventory tables were never in a backup at all.
 *
 * The list is derived from source rather than written down again here. A second
 * hardcoded list would be a second thing to forget to update, which is the
 * failure this file exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_TABLES, INTENTIONALLY_NOT_BACKED_UP } from '../api/backup.js'

/**
 * Every table in the live public schema. Last checked against the live
 * database on 2026-09-01 (62 tables) during the backup/restore drill; the
 * 2026-08-19 snapshot it replaced had already gone stale, missing
 * product_documents from 20260801.
 *
 * This list exists because deriving coverage from `.from(...)` call sites was
 * measuring the wrong universe. It matched the tables the application reads
 * directly, so it missed four that the app only touches through RPCs and
 * triggers — including document_sequences, which holds the document numbering
 * counters. Restoring without it restarts invoice numbering at 1 and collides
 * with the codes just restored.
 *
 * It is a snapshot, which this review has repeatedly shown to be a liability.
 * The mitigation is that adding a table is a migration, and a migration is the
 * moment to add it here — and that the assertion below names what is missing
 * rather than silently passing.
 */
const LIVE_PUBLIC_TABLES = `activities announcements branding_settings brands categories contacts
countries country_area_codes credit_note_applications credit_notes crm_invoices currencies
custom_field_definitions custom_roles
customer_notes customers deals document_sequences email_queue email_settings email_templates
inventory_units invoices kb_articles leads manufacturer_batches notification_logs
notification_preferences notification_queue notification_settings notifications parts
payment_applications payments pipelines product_documents product_images products purchase_orders quotations
rma_config rma_tickets sales_orders stock_moves subcategories ticket_activity ticket_comments
ticket_parts ticket_resolutions time_entries user_activity_log user_permissions user_preferences
user_roles vendor_invoice_charges vendor_invoices vendor_payment_applications vendor_payments warehouse_stock warehouses
webhooks whatsapp_templates`
  .split(/\s+/)
  .filter(Boolean)

/** Every `.from('table')` in the app, excluding v_* views. */
function tablesUsedByApp() {
  const found = new Set()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        // Tests are not the application, and this file quotes the very pattern
        // being searched for — scanning it makes the test match itself.
        if (entry !== 'test') walk(path)
        continue
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry)) continue
      // The backup module names every table by definition; counting it would
      // make this test compare the manifest against itself.
      if (path.endsWith(join('api', 'backup.js'))) continue
      const src = readFileSync(path, 'utf8')
      for (const m of src.matchAll(/\.from\('([a-z_]+)'\)/g)) {
        // Views carry no rows of their own — they read through to the base
        // tables, which are backed up individually.
        if (!m[1].startsWith('v_')) found.add(m[1])
      }
    }
  }
  walk('src')
  return found
}

const manifest = BACKUP_TABLES.map((s) => s.table)

describe('backup manifest', () => {
  it('covers every table the application reads or writes', () => {
    const used = tablesUsedByApp()
    const missing = [...used].filter((t) => !manifest.includes(t)).sort()
    expect(missing, `not covered by BACKUP_TABLES: ${missing.join(', ')}`).toEqual([])
  })

  // The stronger version of the assertion above. Coverage measured against
  // call sites missed four tables that exist but are only reached through RPCs
  // and triggers; this measures against the schema instead. Anything not
  // backed up has to be named in INTENTIONALLY_NOT_BACKED_UP with a reason.
  it('accounts for every table in the live schema', () => {
    const excluded = Object.keys(INTENTIONALLY_NOT_BACKED_UP)
    const unaccounted = LIVE_PUBLIC_TABLES.filter(
      (t) => !manifest.includes(t) && !excluded.includes(t)
    ).sort()
    expect(
      unaccounted,
      `neither backed up nor listed as a deliberate exclusion: ${unaccounted.join(', ')}`
    ).toEqual([])
  })

  it('gives a reason for every deliberate exclusion', () => {
    for (const [table, why] of Object.entries(INTENTIONALLY_NOT_BACKED_UP)) {
      expect(LIVE_PUBLIC_TABLES, `${table} is excluded but does not exist`).toContain(table)
      expect(why.length, `${table} has no reason`).toBeGreaterThan(20)
    }
  })

  // document_sequences carries the last_value for every document code series.
  // A restore that omits it restarts numbering at 1, and the next invoice
  // collides with one just restored on its unique inv_code.
  it('captures the document numbering counters', () => {
    expect(manifest).toContain('document_sequences')
  })

  it('lists no table twice', () => {
    expect(manifest.length).toBe(new Set(manifest).size)
  })

  it('backs up more than the handful the old version covered', () => {
    // Guards against a regression to the 9-table export rather than asserting
    // an exact count, which would need editing every time a table is added.
    expect(manifest.length).toBeGreaterThan(40)
  })

  // A restore writes in manifest order, so a child appearing before its parent
  // fails on a foreign key against an empty database. Spot-checked on the
  // relationships that actually exist rather than every pair.
  it.each([
    ['brands', 'products'],
    ['categories', 'products'],
    ['warehouses', 'inventory_units'],
    ['warehouses', 'warehouse_stock'],
    ['products', 'inventory_units'],
    ['products', 'product_documents'],
    ['customers', 'rma_tickets'],
    ['customers', 'contacts'],
    ['customers', 'customer_notes'],
    ['pipelines', 'deals'],
    ['rma_tickets', 'ticket_comments'],
    ['rma_tickets', 'ticket_activity'],
    ['rma_tickets', 'ticket_parts'],
    ['quotations', 'sales_orders'],
    ['sales_orders', 'crm_invoices'],
    ['crm_invoices', 'payment_applications'],
    ['payments', 'payment_applications'],
    ['credit_notes', 'credit_note_applications'],
    ['purchase_orders', 'vendor_invoices'],
    ['vendor_payments', 'vendor_payment_applications'],
    ['parts', 'ticket_parts'],
    // Both of these were wrong in the hand-written order and were caught by
    // 20260825_verify_restore_order.sql running against the live foreign keys,
    // not by this list. They are pinned here so a future reshuffle fails fast
    // rather than waiting for someone to run the SQL again.
    ['vendor_invoices', 'inventory_units'], // inventory_units.vendor_invoice_id
    ['deals', 'leads'], // leads.converted_deal_id
    ['purchase_orders', 'vendor_invoices'],
    ['brands', 'purchase_orders'],
    // Added with the currency engine: both tables carry a foreign key to
    // currencies, so it has to be restored before either of them.
    ['currencies', 'purchase_orders'],
    ['currencies', 'vendor_invoices'],
    ['vendor_invoices', 'vendor_invoice_charges'],
    // Added with System Setup: countries reference a currency, area codes
    // reference a country, and customers and vendors both carry a country
    // override — so countries has to land before all three.
    ['currencies', 'countries'],
    ['countries', 'country_area_codes'],
    ['countries', 'customers'],
    ['countries', 'brands'],
  ])('restores %s before %s', (parent, child) => {
    expect(manifest.indexOf(parent)).toBeGreaterThanOrEqual(0)
    expect(manifest.indexOf(child)).toBeGreaterThanOrEqual(0)
    expect(manifest.indexOf(parent)).toBeLessThan(manifest.indexOf(child))
  })

  // activities.related_id is polymorphic — it points at a deal, lead, customer,
  // purchase order or vendor invoice depending on related_type — so Postgres
  // cannot enforce it and only ordering keeps a restore coherent.
  it('restores activities after every table they can point at', () => {
    const at = manifest.indexOf('activities')
    for (const parent of ['deals', 'leads', 'customers', 'purchase_orders', 'vendor_invoices']) {
      expect(manifest.indexOf(parent)).toBeLessThan(at)
    }
  })

  describe('tables deliberately not restored', () => {
    const notRestored = BACKUP_TABLES.filter((s) => s.restore === false)

    it('each states why', () => {
      for (const spec of notRestored) {
        expect(spec.why, `${spec.table} has restore:false with no reason`).toBeTruthy()
      }
    })

    // Restoring queued jobs would re-send every notification that was pending
    // when the backup was taken. Exported for the record, never written back.
    it('excludes the notification queue', () => {
      expect(notRestored.map((s) => s.table)).toContain('notification_queue')
    })

    // The secret columns are excluded from the export, so restoring the row
    // would overwrite live credentials with redaction placeholders.
    it('excludes email_settings', () => {
      expect(notRestored.map((s) => s.table)).toContain('email_settings')
    })
  })

  it('reads email_settings without its secret columns', () => {
    const spec = BACKUP_TABLES.find((s) => s.table === 'email_settings')
    expect(spec.select).toBeTruthy()
    for (const secret of ['api_key', 'smtp_password', 'smtp_user', 'webhook_secret']) {
      expect(spec.select).not.toContain(secret)
    }
  })
})
