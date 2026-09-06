// Who is allowed to use an Edge Function, decided the same way the database
// decides it.  (Audit finding BUG-021.)
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Row-level security fails closed for a suspended account: rma_user_role()
// returns NULL for anything that is not an active, unexpired row, so every
// policy denies and the app shows the access-denied screen.
//
// The Edge Functions had no equivalent. They read `user_roles.role` with the
// service-role key — which bypasses RLS entirely — and never looked at `status`
// or `access_expires_at`. So the database's answer and the functions' answer
// disagreed for exactly the accounts where it matters most.
//
// That gap is reachable because suspending someone does not revoke the session
// they already hold (BUG-049). A suspended technician with a tab still open
// kept a valid JWT, and with it could send WhatsApp messages on the company's
// account and drain the notification queue, long after being locked out of the
// interface.
//
// ── Mirrors rma_access_is_current() ──────────────────────────────────────────
//
// Three conditions, matching the SQL helper and accessDenialReason() in
// src/lib/permissions.ts:
//
//   * a row exists and carries a role
//   * status is 'active'  (a NULL status reads as active — rows predating the
//     column, same COALESCE the SQL helper uses)
//   * access_expires_at, when set, has not passed
//
// Keep the three in step. If one gains a state the others do not, the database,
// the interface and the functions will disagree about who may act.

/**
 * Structurally typed rather than importing SupabaseClient, because the
 * functions in this project pin different supabase-js versions ('@2' in most,
 * '@2.45.0' in kb-chat) and a shared type import would tie them together.
 */
// deno-lint-ignore no-explicit-any
type AdminClient = { from: (table: string) => any }

export interface AccessRow {
  role: string
  status: string | null
  access_expires_at: string | null
}

/**
 * The caller's user_roles row, but only when their access is current.
 * Returns null for absent, suspended, locked, deactivated, pending or expired —
 * the caller should treat null as "no access" without needing to know which.
 *
 * The lookup is lower-cased: user_roles is keyed by email, and a case mismatch
 * would silently deny a legitimate user rather than fail loudly.
 */
export async function currentAccess(
  adminClient: AdminClient,
  email: string | null | undefined,
): Promise<AccessRow | null> {
  if (!email) return null

  const { data } = await adminClient
    .from('user_roles')
    .select('role, status, access_expires_at')
    .eq('user_email', email.toLowerCase())
    .single()

  if (!data?.role) return null
  if ((data.status ?? 'active') !== 'active') return null
  if (data.access_expires_at && new Date(data.access_expires_at) <= new Date()) return null

  return data as AccessRow
}

/**
 * Current staff who are not read-only.
 *
 * 'viewer' is the line for anything that spends money or leaves the building —
 * a WhatsApp message, an LLM call, draining the send queue. It matches the
 * `rma_is_staff() AND rma_user_role() <> 'viewer'` idiom used throughout the
 * RLS layer.
 */
export function canAct(row: AccessRow | null): boolean {
  return !!row && row.role !== 'viewer'
}
