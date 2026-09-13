/**
 * One automatic reload per session for a code chunk that failed to load.
 * (Audit finding BUG-054.)
 *
 * ── Why the reload exists ───────────────────────────────────────────────────
 *
 * Every page is a lazily-loaded chunk with a content hash in its filename. A
 * deploy replaces those files, so a tab opened before the deploy asks for a
 * chunk that no longer exists. Reloading fetches the new index.html and the
 * new hashes, and the user never notices. That part was right.
 *
 * ── Why it needed a limit ───────────────────────────────────────────────────
 *
 * The reload was unconditional. When a chunk is missing for a reason a reload
 * does not fix — a CDN outage, a broken deploy, an ad-blocker or corporate
 * proxy stripping the file — the reloaded page asks for the same chunk, fails
 * the same way, and reloads again. Forever. The user sees a flickering blank
 * page and cannot even reach the error screen that would explain it, and every
 * cycle is another full download of the app.
 *
 * Now the first failure reloads, and a second failure in the same session is
 * thrown to the ErrorBoundary instead, which offers a Reload button the user
 * controls. The flag clears as soon as any chunk loads, so a later deploy in
 * the same long-lived tab still gets its one silent reload.
 *
 * ── When storage is unavailable ─────────────────────────────────────────────
 *
 * sessionStorage can be blocked, or — in older Safari private windows — accept
 * a write and silently discard it. Either way there is no way to remember that
 * a reload was already tried, and an unremembered reload is exactly the loop
 * this exists to prevent. So no storage means no automatic reload: the error
 * screen is a worse experience than a silent recovery, and a far better one
 * than an infinite loop.
 */

export const CHUNK_RELOAD_KEY = 'myrma:chunk-reload-attempted'

// The same failure is worded differently by each engine.
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox — previously not caught at all
  /Importing a module script failed/i, // Safari
]

export function isChunkLoadError(err) {
  const message = typeof err === 'string' ? err : err?.message || ''
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null // accessing the property itself throws when site data is blocked
  }
}

/**
 * Claim this session's one automatic reload. True means reload now; false means
 * a reload was already tried, or cannot be remembered, so let the error surface.
 */
export function claimChunkReload(storage = sessionStore()) {
  if (!storage) return false
  try {
    if (storage.getItem(CHUNK_RELOAD_KEY) === '1') return false
    storage.setItem(CHUNK_RELOAD_KEY, '1')
    // Read it back: a store that silently drops writes would otherwise grant a
    // reload on every page load.
    return storage.getItem(CHUNK_RELOAD_KEY) === '1'
  } catch {
    return false
  }
}

/** A chunk loaded, so the app is reachable again; restore the one reload. */
export function clearChunkReload(storage = sessionStore()) {
  if (!storage) return
  try {
    storage.removeItem(CHUNK_RELOAD_KEY)
  } catch {
    /* nothing to clear */
  }
}
