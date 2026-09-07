/**
 * Clear cached API responses on sign-out. (Audit finding BUG-024.)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The PWA service worker was configured to cache every Supabase request:
 *
 *   urlPattern: a case-insensitive regex matching every https://<any>.supabase.co URL
 *   handler:    'NetworkFirst'
 *   options:    { cacheName: 'supabase-api', cacheableResponse: { statuses: [0, 200] } }
 *
 * That pattern matches REST, Auth and Storage alike, so every authenticated GET
 * — customers, tickets, invoices, user_roles — was written to Cache Storage and
 * left there. Nothing in the codebase called `caches.delete` or unregistered the
 * worker, so signing out removed the session and left the data. On a shared
 * machine the next person to open the browser could read the previous user's
 * records straight out of DevTools, without a session at all.
 *
 * ── Why both halves are needed ──────────────────────────────────────────────
 *
 * The `runtimeCaching` rule is gone from vite.config.js, which stops *new*
 * caching. It does nothing about browsers that already hold a populated
 * `supabase-api` cache — those keep it until something deletes it. This is that
 * something, and it is the part that remediates the existing exposure rather
 * than just preventing more of it.
 *
 * Deliberately best-effort: Cache Storage is unavailable in some contexts
 * (private windows, older browsers, blocked site data) and a failure to purge
 * must never prevent someone signing out.
 */

/** Cache names this app is allowed to delete. Static-asset caches are left alone. */
const API_CACHE_PREFIXES = ['supabase-api', 'workbox-runtime']

/**
 * Delete any cached API responses. Safe to call when Cache Storage is missing.
 * @returns {Promise<string[]>} the cache names actually deleted
 */
export async function purgeApiCaches() {
  const deleted = []
  try {
    const store = globalThis.caches
    if (!store?.keys) return deleted
    const names = await store.keys()
    for (const name of names) {
      if (API_CACHE_PREFIXES.some((p) => name.startsWith(p))) {
        try {
          if (await store.delete(name)) deleted.push(name)
        } catch {
          /* one cache failing must not stop the others */
        }
      }
    }
  } catch {
    /* Cache Storage unavailable — nothing to purge */
  }
  return deleted
}
