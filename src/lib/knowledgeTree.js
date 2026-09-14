/**
 * Formatting for the Knowledge Center's file listings.
 *
 * This file used to build the whole Brand > Category > Subcategory > Product
 * folder tree in the browser from the entire catalogue and every document.
 * That load was capped by the Data API at 1 000 rows, so the tree silently
 * lost products past it (BUG-066). The placement and roll-up rules now live in
 * supabase/migrations/20260855_knowledge_explorer_views.sql and are pinned by
 * supabase/tests/knowledge_explorer_views.sql; only the byte formatting is
 * left here.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * Bytes as a file manager shows them.
 *
 * Deliberately unlocalised units: B/KB/MB/GB are read as symbols rather than
 * as words, and every file manager an Arabic user has ever opened writes them
 * this way. The number beside them is still bidi-isolated by the caller.
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return ''
  if (bytes <= 0) return `0 ${UNITS[0]}`
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  // Whole bytes have no meaningful fraction; everything else reads better with
  // one decimal until it reaches three digits.
  const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(decimals)} ${UNITS[exponent]}`
}
