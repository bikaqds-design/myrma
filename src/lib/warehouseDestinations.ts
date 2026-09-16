// ─── Warehouse destination lists — pure core ───────────────────────────────
// Which warehouses a user may pick as the destination of a manual stock
// operation (receive / transfer / adjust).
//
// Exists because the same filter was written inline four times and got it
// wrong in all four (found in manual QA 2026-08-05,
// docs/archive/WAREHOUSE_R1_TEST_CHECKLIST.md §9):
//
//   TransferStockModal.jsx   is_active + not-source            → missing !is_system
//   BulkStockActionModal.jsx is_active                    (×2) → missing !is_system
//   ReceiveStockModal.jsx    no filter at all                  → missing both
//
// The rule, from the Warehouse Module R1 design (migration 20260764, and the
// comment on TransferModal.jsx): **units reach a system location only through
// the RMA auto-move / promote flow, never a manual stock operation.** Offering
// SCRAP or RMA-RECEIVED in a transfer dropdown lets a user write stock off
// with no RMA ticket, or create an RMA unit with a NULL rma_ticket_id —
// corrupting the Warehouse Dashboard's RMA counts and Physical Total.
//
// Archived warehouses are excluded for the obvious reason: stock should not be
// moved into a location that is no longer in service.

export interface DestinationWarehouse {
  id: string
  name?: string | null
  is_active?: boolean | null
  is_system?: boolean | null
}

export interface DestinationOptions {
  /** Warehouse to leave out — the source of a transfer. */
  excludeId?: string | null
}

/**
 * The warehouses a manual receive / transfer / adjust may target: active,
 * non-system, and not the operation's own source.
 *
 * Order is preserved so callers keep whatever sort the caller supplied.
 */
export function destinationWarehouses<T extends DestinationWarehouse>(
  warehouses: T[] | null | undefined,
  { excludeId = null }: DestinationOptions = {}
): T[] {
  // `is_active` is checked for truthiness, not `=== true`, to match the
  // filters this replaced — a row with the flag absent was already treated as
  // inactive and stays that way.
  return (warehouses || []).filter((w) => w.is_active && !w.is_system && w.id !== excludeId)
}
