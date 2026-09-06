import { db, storage } from '../api/supabaseClient'
import { captureException } from './sentry'
import { TRASH_RETENTION_DAYS } from '../api/db/documents.js'

export { TRASH_RETENTION_DAYS }

/**
 * Purges Trash: anything moved there more than 5 days ago is removed for
 * good — the row and its storage file.
 *
 * ── Why this runs lazily, on a page visit, rather than on a schedule ────────
 *
 * A "delete after N days" feature usually means a cron job. This app has no
 * server component to run one on except Supabase's own pg_cron, and the
 * 2026-09-03 audit already found the existing cron wiring failing with a 401
 * — a separate, pre-existing problem, but not one to quietly build a second
 * feature on top of. A sweep that runs whenever someone opens the Vault or
 * Trash needs no infrastructure beyond what already works, and is honest
 * about its own limit: a document is purged the next time anyone visits,
 * which is usually the same day it expires and is never later than that,
 * but is not a guaranteed-exact 5-day timer for a Trash nobody opens.
 *
 * ── Why the row is deleted before the storage file, not after ───────────────
 *
 * Same reasoning as the original single-document delete this replaces: the
 * row is what the app reads, so a deleted row pointing at a file that has not
 * been cleaned up yet is untidy but harmless, while a live row pointing at an
 * already-deleted file is a broken link someone could still click.
 *
 * A storage failure is caught per-document and reported, not thrown — one
 * missing file must not stop the rest of the sweep from finishing.
 *
 * Shared between product documents and company documents (20260809) — both
 * are `{ listExpiredTrash, remove }` shaped, and a fix here should not have
 * to be made twice.
 */
async function purgeExpiredFrom(store) {
  const expired = await store.listExpiredTrash()
  let purged = 0
  for (const doc of expired) {
    try {
      await store.remove(doc.id)
      try {
        await storage.deleteFile(doc.storage_path)
      } catch (fileErr) {
        captureException(fileErr)
      }
      purged += 1
    } catch (err) {
      captureException(err)
    }
  }
  return purged
}

export function purgeExpiredTrash() {
  return purgeExpiredFrom(db.productDocuments)
}

export function purgeExpiredCompanyTrash() {
  return purgeExpiredFrom(db.companyDocuments)
}

/** Whole days left before a trashed document is purged, for display. Never negative. */
export function daysUntilPurge(deletedAt) {
  if (!deletedAt) return TRASH_RETENTION_DAYS
  const purgeAt = new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * 86_400_000
  const days = Math.ceil((purgeAt - Date.now()) / 86_400_000)
  return Math.max(0, days)
}
