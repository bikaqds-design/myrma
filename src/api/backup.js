import { supabase } from './client.js'

/**
 * Backup and restore of the whole database.
 *
 * ── What was wrong before ────────────────────────────────────────────────────
 *
 * This module exported 9 tables and restored 5, out of the 53 the application
 * uses. Not backed up at all: every deal, lead, contact, quotation, sales
 * order, invoice, payment, credit note, purchase order, vendor invoice, vendor
 * payment, inventory unit, warehouse, stock move, part, time entry, activity,
 * custom role and pipeline.
 *
 * The button said "Export Complete Backup", the toast said "Complete backup
 * exported successfully", and the on-screen tip said "Complete backup includes
 * all system data". Someone following that advice and restoring after a data
 * loss would have lost the entire CRM, accounting, purchasing and inventory
 * modules and been told the backup was complete.
 *
 * It also read each table with a single unbounded select. PostgREST caps rows
 * per response, so a table larger than the cap was silently truncated — a
 * backup that gets quietly less complete as the business grows. Every read
 * here is paginated now.
 *
 * ── Structure ────────────────────────────────────────────────────────────────
 *
 * BACKUP_TABLES is the single source of truth: what is exported, what may be
 * restored, and in which order. Add a table here and both directions pick it
 * up. The list is in foreign-key order — parents before children — so a
 * restore into an empty database succeeds without deferring constraints.
 */

const PAGE = 1000
const CHUNK = 500

/** Columns of email_settings that must never leave the server (H-6). */
/**
 * Columns of `email_settings` that are safe to write to a backup file.
 *
 * An allowlist rather than a redaction pass, so a secret column added later is
 * excluded by default instead of leaking until somebody notices.
 *
 * It must name columns that EXIST. This list previously carried smtp_host,
 * smtp_port and smtp_secure, none of which are in the table — PostgREST
 * rejected the select, readAll threw, and exportAll aborted. The result was
 * that "Export Complete Backup" produced no backup at all, and said only
 * "Failed to export". Found by running the drill; see the failure handling in
 * exportAll, which is what stops one table from costing the other fifty-nine.
 */
const EMAIL_SETTINGS_SAFE_COLUMNS =
  'id, provider, from_email, from_name, is_active, updated_by, updated_date'

/**
 * Never exported. `api_key` is the only one that currently exists; the others
 * are named so that if they are ever added, they are already excluded.
 */
const EMAIL_SETTINGS_SECRET_FIELDS = ['api_key', 'smtp_password', 'smtp_user', 'webhook_secret']

/**
 * Columns of `webhooks` that are safe to write to a backup file (BUG-025).
 *
 * `secret_key` is the HMAC key a receiver uses to verify that a delivery really
 * came from us. It was going into every backup JSON an administrator downloads
 * to their laptop, in clear text.
 *
 * Naming the columns is also now REQUIRED, not merely tidier: migration
 * 20260825 replaced `authenticated`'s table-wide SELECT on `webhooks` with a
 * column grant that omits `secret_key`, so a bare `select('*')` is refused
 * outright with "permission denied for table webhooks". Until this allowlist
 * landed, webhooks failed on every export and was reported in the file's
 * `failed` list.
 */
const WEBHOOKS_SAFE_COLUMNS =
  'id, name, url, events, is_active, last_triggered_at, created_by, created_date, updated_date, has_secret'

/**
 * Columns of `user_roles` that are safe to write to a backup file (BUG-025).
 *
 * `permissions` is deliberately INCLUDED: it is the permission map, it is
 * configuration rather than a secret, and a restore that dropped it would put
 * everyone back on default access — a worse outcome than the risk it carries.
 *
 * `notes` and `suspended_reason` are excluded. They are free text written about
 * a person — why someone was suspended, what a manager thought — and a backup
 * file that circulates on laptops and in email is not where that belongs.
 * `suspended_by` and `suspended_date` are kept: they are facts about the
 * account, not commentary about the human.
 *
 * `password_hash` is absent because the column no longer exists (BUG-039).
 * Backup files taken before 2026-09-06 still contain it and should be deleted.
 */
const USER_ROLES_SAFE_COLUMNS =
  'id, user_email, role, role_type, permissions, status, created_date, last_login, ' +
  'expiration_date, access_expires_at, suspended_by, suspended_date'

/**
 * Every table, in foreign-key order.
 *
 * `restore: false` means the table is exported for the record but never written
 * back, and `why` says on what grounds — restoring it would either do damage or
 * be meaningless.
 */
export const BACKUP_TABLES = [
  // ── Tier 1: configuration and lookups, no dependencies ────────────────────
  // currencies first: purchase_orders and vendor_invoices carry a foreign key
  // to it, so a restore that created them first would fail on the constraint.
  { table: 'currencies' },
  // countries after currencies (countries.currency_code references it) and
  // before brands and customers, which both carry a country_code override.
  { table: 'countries' },
  { table: 'country_area_codes' },
  {
    table: 'document_sequences',
    // Read through the RPC, because the table refuses client SELECT as well as
    // client writes. A plain select does not error — RLS simply returns no
    // rows — so this exported as an empty array while the manifest claimed it
    // was kept "for the record". The counters were the one thing a restore
    // cannot rebuild and the one thing the file did not have. Found by running
    // the drill and diffing the export against the database.
    rpc: 'rma_document_counters',
    restore: false,
    why:
      'the table refuses all client access by design, so a restore cannot write it — but it MUST be reinstated by an administrator in SQL. Without it nextval_for_type restarts at 1 and the next invoice, credit note or payment collides with a restored one on its unique code',
  },
  { table: 'rma_config' },
  { table: 'brands' },
  { table: 'categories' },
  { table: 'subcategories' },
  { table: 'warehouses' },
  { table: 'pipelines' },
  { table: 'parts' },
  { table: 'custom_field_definitions' },
  { table: 'custom_roles' },
  {
    table: 'user_roles',
    select: USER_ROLES_SAFE_COLUMNS,
    why: 'free-text notes and suspension reasons are about people and are excluded from the file',
  },
  { table: 'user_preferences' },
  { table: 'announcements' },
  { table: 'kb_articles' },
  {
    table: 'webhooks',
    select: WEBHOOKS_SAFE_COLUMNS,
    restore: false,
    why: 'the signing secret is excluded from the export, so restoring would overwrite live secrets with nothing',
  },
  { table: 'branding_settings' },
  { table: 'email_templates' },
  { table: 'whatsapp_templates' },
  { table: 'notification_settings' },
  { table: 'notification_preferences' },
  {
    table: 'email_settings',
    select: EMAIL_SETTINGS_SAFE_COLUMNS,
    restore: false,
    why: 'the secret columns are excluded from the export, so restoring would overwrite live credentials with nothing',
  },

  // ── Tier 2: core records ──────────────────────────────────────────────────
  { table: 'products' },
  // Real data: the image URL and storage path for every product photo. Missed
  // originally because the manifest was derived from tables the application
  // reads through `.from(...)`, and this one is only ever reached indirectly.
  { table: 'product_images' },
  // Datasheets and manuals. The FILES live in the storage bucket and are not
  // part of this export — only the rows that point at them and the text read
  // out of them. Restoring into an environment whose bucket does not hold the
  // files gives working search over documents whose links are dead, which is
  // the better half to keep.
  { table: 'product_documents' },
  // Company-wide reference material — price lists, policies, certificates
  // (20260809). Same file-not-included caveat as product_documents above.
  { table: 'company_documents' },
  { table: 'customers' },
  { table: 'contacts' },
  { table: 'customer_notes' },
  // deals before leads: leads.converted_deal_id points at the deal a lead
  // became (fk_leads_converted_deal). The reverse order reads naturally —
  // a lead becomes a deal — and is wrong. Caught by 20260825 against the live
  // foreign keys; the hand-written spot checks did not cover this pair.
  { table: 'deals' },
  { table: 'leads' },
  { table: 'rma_tickets' },

  // ── Tier 3: children of tickets ───────────────────────────────────────────
  { table: 'ticket_comments' },
  { table: 'ticket_activity' },
  { table: 'ticket_parts' },
  { table: 'ticket_resolutions' },
  { table: 'time_entries' },

  // ── Tier 4: purchasing, before inventory ──────────────────────────────────
  // inventory_units.vendor_invoice_id records the vendor invoice a unit
  // arrived on, so the whole purchasing chain has to exist first. Purchasing
  // sat after inventory originally, which reads as a sensible grouping and
  // breaks a restore — 20260825 caught it against the real foreign keys.
  // Nothing in purchasing points back: purchase_orders and vendor_invoices
  // reference only brands and each other.
  { table: 'purchase_orders' },
  { table: 'vendor_invoices' },
  // Freight, customs and clearance. Part of what the goods cost, so losing
  // these in a restore would silently change every landed unit cost derived
  // from them.
  { table: 'vendor_invoice_charges' },
  { table: 'vendor_payments' },
  { table: 'vendor_payment_applications' },

  // ── Tier 5: inventory ─────────────────────────────────────────────────────
  { table: 'manufacturer_batches' },
  { table: 'inventory_units' },
  { table: 'warehouse_stock' },
  {
    table: 'stock_moves',
    restore: false,
    why:
      'no_direct_client_insert refuses every client write by design. This is derived history that the stock RPCs write as a side effect, and attempting it would report a failure on every single restore',
  },

  // ── Tier 5: sales documents, each depending on the one above ──────────────
  { table: 'quotations' },
  { table: 'sales_orders' },
  { table: 'crm_invoices' },
  { table: 'invoices' },
  { table: 'payments' },
  { table: 'payment_applications' },
  { table: 'credit_notes' },
  { table: 'credit_note_applications' },

  // ── Tier 7: history. activities is polymorphic — related_id points at a
  //    deal, lead, customer, purchase order or vendor invoice depending on
  //    related_type — so it has no foreign key and must come after all of them.
  { table: 'activities' },
  { table: 'notifications' },
  { table: 'user_activity_log' },
  {
    table: 'notification_logs',
    restore: false,
    why: 'a delivery log describes what happened at the time; rewriting it would misrepresent history',
  },
  {
    table: 'notification_queue',
    restore: false,
    why: 'restoring queued jobs would re-send every notification that was pending when the backup was taken',
  },
]

/**
 * The system, grouped the way the business thinks about it.
 *
 * ── Why modules exist ───────────────────────────────────────────────────────
 *
 * The screen used to offer exactly three exports — products, customers, RMA
 * tickets — against sixty tables. Everything else could only be had as a
 * complete backup, so "send me the purchasing data" or "restore the catalogue"
 * had no answer. Worse, those three wrote a bare JSON array rather than the
 * envelope the restore expects, so the files they produced could not be
 * restored at all: three buttons that looked like a backup and were not one.
 *
 * A module export is the same envelope as a full backup, containing a subset of
 * the tables. That is the whole design — one file format, one restore path.
 *
 * ── What a module backup is NOT ─────────────────────────────────────────────
 *
 * It is not a standalone system. Sales rows reference customers, inventory
 * references products, and those parents live in other modules — so a module
 * file restores correctly into a system that still has the rest of its data,
 * and will fail on foreign keys if restored into an empty database. Only the
 * complete backup is self-sufficient. The screen says so rather than leaving it
 * to be discovered during a recovery.
 *
 * Order within each module follows BACKUP_TABLES, so foreign-key order is
 * inherited rather than restated — restating it would be a second thing to keep
 * right.
 */
export const BACKUP_MODULES = [
  {
    id: 'system',
    tables: [
      'currencies', 'countries', 'country_area_codes', 'document_sequences', 'rma_config',
      'custom_field_definitions', 'custom_roles', 'user_roles', 'user_preferences',
      'branding_settings', 'email_settings', 'email_templates', 'whatsapp_templates',
      'notification_settings', 'notification_preferences', 'webhooks', 'pipelines', 'warehouses',
      'company_documents',
    ],
  },
  {
    id: 'catalogue',
    tables: ['brands', 'categories', 'subcategories', 'products', 'product_images', 'product_documents', 'parts'],
  },
  {
    id: 'crm',
    tables: ['customers', 'contacts', 'customer_notes', 'deals', 'leads', 'activities'],
  },
  {
    id: 'rma',
    tables: ['rma_tickets', 'ticket_comments', 'ticket_activity', 'ticket_parts', 'ticket_resolutions', 'time_entries'],
  },
  {
    id: 'purchasing',
    tables: ['purchase_orders', 'vendor_invoices', 'vendor_invoice_charges', 'vendor_payments', 'vendor_payment_applications'],
  },
  {
    id: 'inventory',
    tables: ['manufacturer_batches', 'inventory_units', 'warehouse_stock', 'stock_moves'],
  },
  {
    id: 'sales',
    tables: [
      'quotations', 'sales_orders', 'crm_invoices', 'invoices',
      'payments', 'payment_applications', 'credit_notes', 'credit_note_applications',
    ],
  },
  {
    id: 'comms',
    tables: ['kb_articles', 'announcements', 'notifications', 'notification_logs', 'notification_queue', 'user_activity_log'],
  },
]

/**
 * Public tables deliberately left out of BACKUP_TABLES.
 *
 * The manifest was first derived from tables the application reads through
 * `.from(...)`, which is not the same set as the tables that exist — it missed
 * four. Two of them mattered and were added (`document_sequences`,
 * `product_images`). These two do not, and are named here so their absence is a
 * decision on the record rather than the same oversight repeating.
 *
 * Asserted by src/test/backupCoverage.test.js against the live table list.
 */
export const INTENTIONALLY_NOT_BACKED_UP = {
  email_queue:
    'a transient outbound spool. Restoring it would re-send mail that was pending when the backup was taken; anything still owed will be re-queued by the events that own it.',
  user_permissions:
    'a Base44-era table the application no longer reads. 20260787 closed it to admins; it holds no live state.',
}

/** Legacy key names used by version 1.0 exports, mapped to their tables. */
const LEGACY_KEYS = {
  products: 'products',
  customers: 'customers',
  tickets: 'rma_tickets',
  comments: 'ticket_comments',
  activity: 'ticket_activity',
  users: 'user_roles',
  branding: 'branding_settings',
  emailSettings: 'email_settings',
  emailTemplates: 'email_templates',
}

function redactEmailSettings(rows) {
  return (rows || []).map((row) => {
    const safe = { ...row }
    for (const field of EMAIL_SETTINGS_SECRET_FIELDS) {
      if (field in safe) safe[field] = '[REDACTED — re-enter after restore]'
    }
    return safe
  })
}

/**
 * Read a whole table, a page at a time.
 *
 * The previous single select was capped by PostgREST's max-rows and truncated
 * without any error, so a backup could be short and still report success. This
 * keeps asking until a page comes back short.
 *
 * A missing table resolves to an empty array rather than throwing: a backup
 * should not fail because one optional feature was never provisioned.
 */
/**
 * Read a table that refuses client SELECT, through a SECURITY DEFINER RPC.
 *
 * The distinction that matters: a table whose RLS denies reads returns an empty
 * array, not an error, so a backup of it looks successful and contains nothing.
 * There is no way to tell that apart from a genuinely empty table by looking at
 * the file — which is why the counters have to come through the RPC built for
 * exactly this in 20260800.
 */
async function readViaRpc(fn) {
  const { data, error } = await supabase.rpc(fn)
  if (error) {
    // A deployment that predates the RPC has no counters to export rather than
    // a broken backup; anything else is a real failure and should be reported.
    if (error.code === 'PGRST202' || error.code === '42883') return { rows: [], missing: true }
    throw new Error(`${fn}: ${error.message}`)
  }
  return { rows: data || [], missing: false }
}

async function readAll(table, select = '*') {
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + PAGE - 1)
    if (error) {
      // 42P01 undefined_table, PGRST205 unknown relation in the schema cache.
      if (error.code === '42P01' || error.code === 'PGRST205') return { rows: [], missing: true }
      throw new Error(`${table}: ${error.message}`)
    }
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { rows, missing: false }
}

export const backup = {
  /**
   * Single-entity exports, each returning a plain array of rows.
   *
   * The Backup screen has had buttons calling these since it was written, and
   * they did not exist — every click threw `backupAPI.exportProducts is not a
   * function`, which the handler caught and reported as "Failed to export
   * products". Three of the four export buttons were dead, and the failure
   * looked like a server problem rather than a missing method.
   */
  /**
   * Export a named module — the same envelope as a complete backup, holding a
   * subset of the tables, so one restore path reads both.
   */
  async exportModule(moduleId) {
    const module = BACKUP_MODULES.find((m) => m.id === moduleId)
    if (!module) throw new Error(`Unknown module: ${moduleId}`)
    const specs = BACKUP_TABLES.filter((s) => module.tables.includes(s.table))
    return exportSpecs(specs, moduleId)
  },

  async exportAll() {
    return exportSpecs(BACKUP_TABLES, null)
  },

  /**
   * Restore from an export — all of it, or none of it.
   *
   * The file is uploaded to the database in chunks (a single request carrying
   * an entire table is how large restores fail), then applied in ONE database
   * transaction by rma_restore_apply. If any table fails, the database is left
   * exactly as it was before the restore began. (BUG-025.)
   *
   * It used to write table by table from the browser, each request committing
   * on its own, so a failure at the twentieth table left nineteen restored and
   * the rest live — a state matching no moment that ever existed.
   *
   * The database, not this file, decides what may be written: administrators
   * only, only restorable tables, only writable columns, in foreign-key order.
   * Overwrites by primary key and deletes nothing — a row that exists now but
   * not in the backup survives.
   *
   * The same path reads a complete backup and a module export, because they are
   * the same file format — only the set of tables inside differs.
   */
  async importAll(backupData) {
    return importEnvelope(backupData)
  },
}

/**
 * Read a set of tables into a backup envelope.
 *
 * Shared by the complete backup and every module export so the two can never
 * drift into different file formats — which is what made the old per-entity
 * exports unrestorable: they wrote a bare array while the restore required an
 * envelope, and nothing compared the two.
 */
async function exportSpecs(specs, moduleId) {
    const data = {}
    const counts = {}
    const skipped = []
    const failed = []

    // Sequential on purpose. The previous version fired every table at once;
    // with 53 tables and pagination that is a burst of requests against the
    // same connection pool the rest of the app is using.
    for (const spec of specs) {
      let result
      try {
        result = spec.rpc ? await readViaRpc(spec.rpc) : await readAll(spec.table, spec.select)
      } catch (err) {
        // One table must not cost the whole backup.
        //
        // It used to: readAll throws on any error that is not a missing table,
        // nothing caught it, and the first failure abandoned every table after
        // it. A stale column name in the email_settings allowlist therefore
        // meant the business had no backup at all — and the screen said only
        // "Failed to export", naming neither the table nor the reason.
        //
        // Fifty-nine tables and an explicit list of what is missing beats
        // nothing. The gap is recorded in the file and shown on the screen, so
        // this is a stated partial backup rather than a silent one.
        failed.push({ table: spec.table, error: err.message })
        continue
      }
      if (result.missing) {
        skipped.push(spec.table)
        continue
      }
      data[spec.table] = spec.table === 'email_settings' ? redactEmailSettings(result.rows) : result.rows
      counts[spec.table] = data[spec.table].length
    }

    return {
      version: '2.0',
      exported_date: new Date().toISOString(),
      /** null for a complete backup, otherwise the module this file holds. */
      module: moduleId,
      // What this file covers, so a restore can tell a complete backup from a
      // partial one rather than inferring it from which keys happen to exist.
      tables: specs.map((s) => s.table),
      skipped_tables: skipped,
      /** Tables that errored. Empty on a healthy backup. */
      failed_tables: failed,
      /** The one field worth reading before trusting this file. */
      complete: failed.length === 0,
      counts,
      total_rows: Object.values(counts).reduce((a, b) => a + b, 0),
      data,
    }
}

/** The restore itself. See backup.importAll for what it guarantees. */
async function importEnvelope(backupData) {
    if (!backupData?.data) throw new Error('Invalid backup file')
    const { data } = backupData

    // Version 1.0 files keyed the payload by label rather than table name.
    const byTable = {}
    for (const [key, value] of Object.entries(data)) {
      byTable[LEGACY_KEYS[key] || key] = value
    }

    const skipped = new Map()
    const toStage = []
    for (const spec of BACKUP_TABLES) {
      const rows = byTable[spec.table]
      if (!rows?.length) continue
      if (spec.restore === false) {
        skipped.set(spec.table, { table: spec.table, skipped: true, why: spec.why, count: rows.length })
        continue
      }
      toStage.push({ table: spec.table, rows })
    }

    // Results in manifest order, whatever order they were learned in.
    const ordered = (applied) =>
      BACKUP_TABLES.map((s) => skipped.get(s.table) || applied.get(s.table)).filter(Boolean)

    if (!toStage.length) {
      return { success: true, results: ordered(new Map()), tablesRestored: 0, rowsRestored: 0 }
    }

    const { data: session, error: beginError } = await supabase.rpc('rma_restore_begin')
    if (beginError) throw new Error(beginError.message)

    try {
      for (const { table, rows } of toStage) {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const { error } = await supabase.rpc('rma_restore_stage', {
            p_session: session,
            p_table: table,
            p_rows: rows.slice(i, i + CHUNK),
          })
          if (error) throw new Error(`${table}: ${error.message}`)
        }
      }

      const { data: outcome, error: applyError } = await supabase.rpc('rma_restore_apply', {
        p_session: session,
      })
      if (applyError) throw new Error(applyError.message)

      const applied = new Map(
        (outcome?.results || []).map((r) => [
          r.table,
          { table: r.table, count: r.count, attempted: r.attempted, error: null },
        ])
      )
      return {
        success: true,
        results: ordered(applied),
        tablesRestored: outcome?.tables ?? applied.size,
        rowsRestored: outcome?.rows ?? 0,
      }
    } catch (cause) {
      // Nothing was applied: either the upload never finished, or the apply
      // rolled back as a whole. Throw away what was uploaded, and say plainly
      // that the database is unchanged — so nobody restores again on top of a
      // half-written state that does not exist. A failed discard is harmless;
      // abandoned uploads are cleared on the next begin.
      await supabase.rpc('rma_restore_discard', { p_session: session })
      const err = new Error(`Restore failed and nothing was changed — ${cause.message}`)
      err.summary = { results: ordered(new Map()), tablesRestored: 0, rowsRestored: 0, nothingChanged: true }
      throw err
    }
}
