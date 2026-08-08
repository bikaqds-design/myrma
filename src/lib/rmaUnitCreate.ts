// ─── RMA unit creation — pure core (Warehouse Module R1) ───────────────────
// The pure half of db.inventory.createUnitsFromTicket. Kept here (rather than
// inline in api/db/inventory.ts) for the same reason as rmaStageMoves.ts: the
// decision logic is unit-testable without a Supabase mock, and the DB module
// stays a thin transport layer.
//
// Background — the bug this module exists to prevent (found in manual QA on
// 2026-08-05, WAREHOUSE_R1_TEST_CHECKLIST.md §2): a ticket carrying one
// already-tracked serial had ALL of its units discarded, because the units
// were inserted as a single batch and every error was swallowed with
// `return []`. Both halves are addressed — the insert falls back to per-row
// on failure (see createUnitsFromTicket), and findSerialConflicts lets the
// form reject the known-bad case up front with a message naming the serial.
//
// This module has no imports on purpose: nothing here touches Supabase, i18n,
// or React, so it can never introduce an import cycle with api/db/inventory.ts.

/** A single row of a ticket's `products` JSONB. */
export interface TicketProductInput {
  product_id?: string | null
  product_name?: string | null
  serial_number?: string | null
  warranty_status?: string | null
}

/** An `inventory_units` row, shaped for insert. */
export interface NewUnitRow {
  rma_ticket_id: string
  rma_number: string
  product_id: string | null
  product_name: string
  serial_number: string
  warranty_status: string
  status: string
  created_date: string
}

/** The catalog subset needed to re-link a ticket product to its `products` row. */
export interface CatalogProduct {
  id: string
  product_name?: string | null
}

/**
 * An existing `inventory_units` row that occupies a serial number. Only rows
 * the partial unique index actually covers should be passed in — see
 * `db.inventory.findTrackedSerials`, which applies the `status <> 'closed'`
 * filter that mirrors `inv_units_serial_unique_idx`.
 */
export interface TrackedUnit {
  id?: string
  serial_number: string | null
  status?: string | null
  rma_number?: string | null
  product_name?: string | null
}

export interface SerialConflict {
  serial: string
  /**
   * `duplicate_in_ticket` — the same serial is typed on two product lines of
   *   the ticket being saved. The second insert would always fail.
   * `already_tracked` — a non-closed `inventory_units` row already holds this
   *   serial, so the insert would violate `inv_units_serial_unique_idx`.
   */
  reason: 'duplicate_in_ticket' | 'already_tracked'
  /** For `already_tracked`: the RMA the existing unit belongs to, when it has one. */
  rmaNumber?: string | null
  /** For `already_tracked`: the existing unit's status (`active_rma`, `company_stock`, …). */
  status?: string | null
}

/**
 * Normalises a serial the same way both the insert and the conflict check see
 * it. Trimming matters: `inv_units_serial_unique_idx` excludes `''` but NOT
 * `'   '`, so an untrimmed whitespace-only serial would be indexed and would
 * collide with the next whitespace-only serial.
 */
export function normalizeSerial(serial: string | null | undefined): string {
  return (serial || '').trim()
}

/** Case-insensitive, whitespace-tolerant key for matching a product by name. */
function nameKey(name: string | null | undefined): string {
  return (name || '').trim().toLowerCase()
}

/**
 * Builds the name → id lookup used to re-link a ticket product to the catalog.
 * A name shared by two catalog products is dropped rather than guessed — the
 * unit stays name-only instead of being attributed to the wrong product.
 */
export function buildCatalogIndex(
  catalog: CatalogProduct[] | null | undefined
): Map<string, string | null> {
  const index = new Map<string, string | null>()
  for (const p of catalog || []) {
    const key = nameKey(p.product_name)
    if (!key) continue
    index.set(key, index.has(key) ? null : p.id) // second sighting ⇒ ambiguous
  }
  return index
}

/**
 * Resolves the catalog product a ticket line refers to. The id the form
 * captured wins; otherwise the name is matched against the catalog, which
 * covers lines typed rather than picked, and tickets saved before the form
 * started storing `product_id` at all.
 *
 * Returns `null` for genuinely non-catalog products — an RMA may legitimately
 * name something the shop never sold.
 */
export function resolveProductId(
  product: TicketProductInput,
  catalogIndex: Map<string, string | null>
): string | null {
  if (product.product_id) return product.product_id
  return catalogIndex.get(nameKey(product.product_name)) ?? null
}

/**
 * Maps a ticket's `products` JSONB to `inventory_units` insert rows.
 * Product entries with neither a name nor a serial are dropped — they are
 * empty rows left behind by the form's "add product" button.
 *
 * `product_id` matters more than it looks: `getStockSummary` groups units by
 * it, so a unit without one can never count toward a catalog product's RMA
 * column and shows up as "Not in catalog" instead (checklist §2 note, §8).
 *
 * `now` is injectable so tests don't have to freeze the clock.
 */
export function buildTicketUnits(
  ticketId: string,
  rmaNumber: string,
  products: TicketProductInput[] | null | undefined,
  now: string = new Date().toISOString(),
  catalog: CatalogProduct[] | null | undefined = null
): NewUnitRow[] {
  const catalogIndex = buildCatalogIndex(catalog)
  return (products || [])
    .filter((p) => p.product_name || normalizeSerial(p.serial_number))
    .map((p) => ({
      rma_ticket_id: ticketId,
      rma_number: rmaNumber,
      product_id: resolveProductId(p, catalogIndex),
      product_name: p.product_name || '',
      serial_number: normalizeSerial(p.serial_number),
      warranty_status: p.warranty_status || '',
      status: 'active_rma',
      created_date: now,
    }))
}

/** Every distinct, non-empty serial on a ticket — the lookup set for the pre-save check. */
export function serialsToCheck(products: TicketProductInput[] | null | undefined): string[] {
  const seen = new Set<string>()
  for (const p of products || []) {
    const serial = normalizeSerial(p.serial_number)
    if (serial) seen.add(serial)
  }
  return [...seen]
}

/**
 * Decides which serials on a ticket would be rejected by the database, so the
 * form can say so before saving instead of after.
 *
 * Returns at most one conflict per serial, and reports `duplicate_in_ticket`
 * in preference to `already_tracked` — the in-form duplicate is the one the
 * user can fix without touching existing inventory.
 */
export function findSerialConflicts(
  products: TicketProductInput[] | null | undefined,
  trackedUnits: TrackedUnit[] | null | undefined
): SerialConflict[] {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const p of products || []) {
    const serial = normalizeSerial(p.serial_number)
    if (!serial) continue
    if (!counts.has(serial)) order.push(serial)
    counts.set(serial, (counts.get(serial) || 0) + 1)
  }

  const tracked = new Map<string, TrackedUnit>()
  for (const unit of trackedUnits || []) {
    const serial = normalizeSerial(unit.serial_number)
    if (serial && !tracked.has(serial)) tracked.set(serial, unit)
  }

  const conflicts: SerialConflict[] = []
  for (const serial of order) {
    if ((counts.get(serial) || 0) > 1) {
      conflicts.push({ serial, reason: 'duplicate_in_ticket' })
      continue
    }
    const existing = tracked.get(serial)
    if (existing) {
      conflicts.push({
        serial,
        reason: 'already_tracked',
        rmaNumber: existing.rma_number ?? null,
        status: existing.status ?? null,
      })
    }
  }
  return conflicts
}

/**
 * Short, comma-separated identification of the units an insert failed on, for
 * the error toast. Falls back to the product name when a serial wasn't given,
 * because an empty serial is legal and tells the user nothing.
 */
export function describeFailedUnits(
  failed: { serial_number?: string | null; product_name?: string | null }[]
): string {
  return failed
    .map((f) => normalizeSerial(f.serial_number) || f.product_name || '—')
    .join(', ')
}
