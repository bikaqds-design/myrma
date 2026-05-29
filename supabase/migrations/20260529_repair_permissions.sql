-- ============================================================================
-- PERM-3 — One-time repair of corrupted per-user permission overrides
-- ============================================================================
-- Audit finding (2026-05-29): the per-user "Edit Permissions" modal was broken
-- until commit 5de277d. It rendered empty checkboxes and seeded from an all-FALSE
-- template, so any Save wrote a restrictive / empty permissions object onto the
-- user's user_roles.permissions column.
--
-- At runtime this collided with the "empty/partial object is truthy" trap
-- (PERM-1): `stored || ROLE_DEFAULT_PERMISSIONS[role]` let that bad object
-- override the role defaults, stripping non-admin users (e.g. managers) of the
-- ability to create products / tickets / customers.
--
-- PERM-1 (resolvePermissions merge) now self-heals NULL / {} / partial rows at
-- read time. The only rows it CANNOT safely heal are fully-populated objects with
-- explicit `false`s — we can't tell "intentional restriction" from "corruption".
--
-- Because the modal was broken, NO legitimate custom overrides could have been
-- created before today. Therefore it is safe to clear every non-admin override so
-- each user falls back cleanly to their role defaults. admin / super_admin bypass
-- all permission checks, so their permissions column is irrelevant and left alone.
--
-- This is a ONE-TIME repair. After it runs, admins can set real custom overrides
-- through the now-fixed modal; those will not be touched (this migration runs once).
--
-- ROLLBACK:
--   None — the previous values were corrupt by definition. If a specific user
--   needs a custom override afterwards, set it via the User Management UI.
-- ============================================================================

UPDATE public.user_roles
SET    permissions = NULL
WHERE  role IN ('manager', 'technician', 'viewer')
  AND  permissions IS NOT NULL;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Expected: 0 rows. Any remaining non-admin row with a non-null permissions
-- object after this migration would be a real (post-fix) custom override.
--
--   SELECT user_email, role, permissions
--   FROM   public.user_roles
--   WHERE  role IN ('manager', 'technician', 'viewer')
--     AND  permissions IS NOT NULL;
