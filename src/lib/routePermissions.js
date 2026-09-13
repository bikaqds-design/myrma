import { canDo } from './permissions'

/**
 * Which permissions admit each route. (Audit finding BUG-072.)
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * Every route took exactly one permission, and Activities was listed as
 * `deals.view`. But the Activities page itself — the `<Route>` element in
 * App.jsx — admits `deals.view OR leads.view`, because activities hang off
 * leads as well as deals. The route guard runs first, so a custom role with
 * `leads.view` and no `deals.view` was stopped at the door with "you don't
 * have access to Deals", on a page it was entitled to, and the OR in the
 * element never got a chance to run. Two places disagreed about one route.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 *
 * A route now lists its alternatives; meeting ANY of them admits it. Every
 * other route still lists exactly one, unchanged. When access is refused, the
 * first alternative names the module, which keeps the existing message.
 *
 * ── Matching rules (moved here from App.jsx with the table) ─────────────────
 *
 * Prefix matching covers detail routes (/sales/:type/:id and friends) without
 * an entry each, and the longest match wins, so /purchasing/vendor/:id cannot
 * resolve against a shorter, laxer prefix. A prefix only matches whole path
 * segments.
 *
 * Not listed means no permission required. That is only `/` and `/account`:
 * the dashboard is the universal landing page and account settings are the
 * user's own. `/control-panel` keeps its own role check at its route.
 *
 * Hiding a nav link is a courtesy, not a guard: a page is reachable by its URL
 * whatever the nav shows, which is why this table exists. The comment this
 * replaced described the table as a source of truth shared with the nav items;
 * nothing but the route guard ever read it, so a route added here still needs
 * its nav entry checked by hand.
 *
 * This remains the interface agreeing with row-level security, not a security
 * boundary of its own.
 */
export const ROUTE_PERMISSIONS = [
  ['/products', [['products', 'view']]],
  ['/customers', [['customers', 'view']]],
  ['/leads', [['leads', 'view']]],
  ['/pipeline', [['deals', 'view']]],
  ['/activities', [['deals', 'view'], ['leads', 'view']]],
  ['/sales', [['sales', 'view']]],
  ['/accounting', [['accounting', 'view']]],
  ['/purchasing', [['purchasing', 'view']]],
  ['/rma-tickets', [['rma_tickets', 'view_all']]],
  ['/inventory', [['inventory', 'view']]],
  ['/calendar', [['calendar', 'view']]],
  ['/reports', [['reports', 'view']]],
  ['/knowledge-center', [['products', 'view']]],
]

/**
 * The alternatives guarding `pathname`, or null if the route is unguarded.
 * The longest matching prefix wins, and a prefix only matches whole path
 * segments — `/products` guards `/products/42`, not `/products-archive`.
 */
export function requiredPermissionsFor(pathname) {
  let best = null
  for (const [prefix, alternatives] of ROUTE_PERMISSIONS) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      if (!best || prefix.length > best[0].length) best = [prefix, alternatives]
    }
  }
  return best ? best[1] : null
}

/**
 * The module to name when `pathname` is refused, or null when it is allowed
 * (including routes with no requirement at all).
 */
export function deniedModuleFor(role, permissions, pathname) {
  const alternatives = requiredPermissionsFor(pathname)
  if (!alternatives) return null
  const allowed = alternatives.some(([section, action]) => canDo(role, permissions, section, action))
  return allowed ? null : alternatives[0][0]
}
