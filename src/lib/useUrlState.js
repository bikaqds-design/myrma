import { useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Writes made in the current tick, before the router has committed any of them.
 *
 * React Router's setSearchParams does NOT queue functional updates the way
 * useState does: each call is applied against the last *committed* location, so
 * two setters running in one handler both start from the same snapshot and the
 * second silently discards the first. That is the ordinary case — changing a
 * filter also resets the page — not an edge case.
 *
 * So writes accumulate here synchronously and flush once. Found by a test that
 * fired both setters in a single handler; a test that clicked them separately
 * passed against the broken version, because React re-renders between events.
 */
let pending = null

/**
 * `useState`, but the value lives in the URL query string.
 *
 * Search and filter state was held in ordinary component state on every list
 * page, so it existed only in that tab, in that moment (UX-SEARCH-001). A
 * filtered view could not be sent to a colleague, and a refresh silently threw
 * it away — on a page with several filters set, that is real lost work.
 *
 * Deliberately shaped as a drop-in replacement:
 *
 *     const [q, setQ] = useState('')          becomes
 *     const [q, setQ] = useUrlState('q', '')
 *
 * so a page can be converted without restructuring how it holds state.
 *
 * ── Two decisions worth knowing ─────────────────────────────────────────────
 *
 * **Default values are omitted from the URL.** Otherwise every list page would
 * carry `?status=&type=&page=1` before anyone had touched anything, and the
 * shareable link — the whole point — would be noise.
 *
 * **Updates replace rather than push.** Typing eight characters into a search
 * box would otherwise leave eight history entries, and Back would walk the user
 * backwards through their own typing one letter at a time. The cost is that
 * Back does not step through filter changes either; that is the better trade,
 * but it is a trade, not a free win.
 */
export function useUrlState(key, defaultValue) {
  const [params, setParams] = useSearchParams()

  const parse = useCallback(
    (raw) => {
      if (raw === null) return defaultValue
      if (typeof defaultValue === 'number') {
        const n = Number(raw)
        // A hand-edited or stale `?page=abc` must not put the page into NaN.
        return Number.isFinite(n) ? n : defaultValue
      }
      if (typeof defaultValue === 'boolean') return raw === 'true'
      return raw
    },
    [defaultValue]
  )

  const value = parse(params.get(key))

  const setValue = useCallback(
    (next) => {
      // Build on any write already made this tick, not on the committed URL.
      const base = pending ?? params
      const p = new URLSearchParams(base)
      const current = parse(p.get(key))
      const resolved = typeof next === 'function' ? next(current) : next

      if (resolved === defaultValue || resolved === '' || resolved == null) {
        p.delete(key)
      } else {
        p.set(key, String(resolved))
      }

      const first = pending === null
      pending = p

      if (first) {
        // One navigation per tick, carrying every write made during it.
        queueMicrotask(() => {
          const flush = pending
          pending = null
          if (flush) setParams(flush, { replace: true })
        })
      }
    },
    // `params` is deliberately omitted. The callback reads `pending ?? params`,
    // and `pending` is what carries writes made earlier in the same tick.
    // Including `params` would give setValue a new identity on every URL
    // change, re-creating it mid-tick and breaking the one-navigation-per-tick
    // accumulation this hook exists to provide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, defaultValue, parse, setParams]
  )

  return [value, setValue]
}

export default useUrlState

/**
 * Run `reset` when `deps` actually change — not on mount.
 *
 * Every list page resets to page 1 when a filter changes. Once the page number
 * lives in the URL, doing that on mount discards the page from a shared link:
 * `?q=acme&page=3` would land the recipient on page 1.
 *
 * Compares values rather than using a "have I mounted" flag. React StrictMode
 * double-invokes effects in development, so a flag is consumed by the first
 * invocation and the second resets anyway — behaving one way locally and another
 * in production, which is worse than the bug it was meant to fix.
 *
 * Sets are serialised by their sorted contents. Several pages hold multi-select
 * filters as a Set, and plain JSON.stringify turns every Set into `{}` — so two
 * different selections would look identical and the reset would never fire.
 */
export function useResetOnFilterChange(deps, reset) {
  const last = useRef(null)
  const signature = JSON.stringify(deps, (_k, v) =>
    v instanceof Set ? [...v].sort() : v
  )
  useEffect(() => {
    if (last.current === null) {
      last.current = signature
      return
    }
    if (last.current === signature) return
    last.current = signature
    reset()
  }, [signature]) // eslint-disable-line react-hooks/exhaustive-deps
}
