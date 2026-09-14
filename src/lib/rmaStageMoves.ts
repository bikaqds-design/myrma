// ─── RMA stage auto-move orchestration (Warehouse Module R1) ───────────────
// buildRmaMoves is pure and unit-tested (see __tests__/rmaStageMoves.test.ts).
// dispatchRmaStageMoves is the thin async wrapper the 3 ticket-save hooks
// (TicketForm create/edit, RMATickets bulk product-status) call — it fetches
// the ticket's units, computes the moves, and calls the move_rma_units RPC.
// The RPC itself is idempotent (skips a unit already at its target), so
// buildRmaMoves does not need to know each unit's current location — it
// always proposes a target for every active_rma unit it can confidently match.

import { db } from '../api/supabaseClient.js'
import { RMA_STAGE_LOCATION, SYSTEM_WAREHOUSE_CODES } from './constants.js'
import type { SystemWarehouseCode } from './constants.js'
import type { InventoryUnitRow } from '../api/db/inventory.js'

export interface RmaMove {
  unit_id: string
  to_code: string
}

export interface TicketProductLike {
  product_name?: string | null
  serial_number?: string | null
  product_status?: string | null
}

/**
 * Matches each active_rma unit to its ticket product entry (serial_number
 * first, product_name fallback) and resolves the target system location.
 * Ambiguous matches (multiple ticket products share the same serial or, with
 * no serial, the same name) are skipped rather than guessed.
 */
export function buildRmaMoves(
  units: InventoryUnitRow[],
  ticketProducts: TicketProductLike[] | null | undefined
): RmaMove[] {
  const products = ticketProducts || []

  const bySerial = new Map<string, TicketProductLike[]>()
  const byName = new Map<string, TicketProductLike[]>()
  for (const p of products) {
    if (p.serial_number) {
      const list = bySerial.get(p.serial_number) || []
      list.push(p)
      bySerial.set(p.serial_number, list)
    }
    if (p.product_name) {
      const list = byName.get(p.product_name) || []
      list.push(p)
      byName.set(p.product_name, list)
    }
  }

  const moves: RmaMove[] = []

  for (const unit of units) {
    if (unit.status !== 'active_rma') continue

    let match: TicketProductLike | null = null

    if (unit.serial_number) {
      const serialMatches = bySerial.get(unit.serial_number)
      if (serialMatches?.length === 1) match = serialMatches[0]
      else if (serialMatches && serialMatches.length > 1) continue // ambiguous
    }

    if (!match && unit.product_name) {
      const nameMatches = byName.get(unit.product_name)
      if (nameMatches?.length === 1) match = nameMatches[0]
      else if (nameMatches && nameMatches.length > 1) continue // ambiguous
    }

    const statusText = match?.product_status || ''
    // product_status is free text on the ticket, so an unknown value is real and
    // looks up nothing, which the fallback already handles.
    const toCode =
      (RMA_STAGE_LOCATION as Record<string, SystemWarehouseCode | undefined>)[statusText] ||
      SYSTEM_WAREHOUSE_CODES.RMA_RECEIVED

    moves.push({ unit_id: unit.id, to_code: toCode })
  }

  return moves
}

/**
 * Fetches the ticket's units, computes moves, and dispatches them via the
 * move_rma_units RPC. Fire-and-forget from callers — failures should toast,
 * not block the ticket save that triggered them.
 */
export async function dispatchRmaStageMoves(
  ticketId: string,
  products: TicketProductLike[] | null | undefined,
  actorEmail: string
): Promise<number> {
  const units = await db.inventory.listUnitsByTicket(ticketId)
  const moves = buildRmaMoves(units, products)
  if (!moves.length) return 0
  return db.inventory.moveRmaUnits(ticketId, moves, actorEmail)
}
