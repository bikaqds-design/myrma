-- Make custom roles assignable.
--
-- Today they can be created, listed and deleted, and never used: the role
-- dropdown offers only the seven built-ins, and chk_user_role rejects anything
-- else outright. A feature that looks complete and cannot do the one thing it
-- exists for.
--
-- The hard part is not the dropdown. It is that RLS has no idea what a custom
-- role is. rma_is_staff() and rma_is_manager_or_above() match fixed lists, so a
-- role named 'bookkeeper' is in neither: the database would serve it almost
-- nothing while the app's permission map said otherwise. That is the same
-- "interface shows it, database refuses it" split this month has been spent
-- closing, and shipping the dropdown alone would have recreated it wholesale.
--
-- So a custom role declares what it inherits:
--
--   RLS      treats the user as their BASE role — the coarse boundary the
--            server enforces
--   canDo    uses the custom role's own permission map — the finer rules the
--            interface enforces
--
-- A custom role therefore can never exceed its base role's server access. It
-- can only be narrower, which is the direction that is safe to be wrong in.
--
-- base_role deliberately excludes super_admin and admin: canDo() returns true
-- unconditionally for those two, so a custom role based on either would ignore
-- its own permission map entirely and silently grant everything.

-- ── 1. Declare the inheritance ───────────────────────────────────────────────

ALTER TABLE public.custom_roles
  ADD COLUMN IF NOT EXISTS base_role text NOT NULL DEFAULT 'viewer';

ALTER TABLE public.custom_roles DROP CONSTRAINT IF EXISTS chk_custom_base_role;
ALTER TABLE public.custom_roles
  ADD CONSTRAINT chk_custom_base_role
  CHECK (base_role IN ('manager', 'technician', 'viewer', 'sales_rep', 'accountant'));

-- role_name has to be usable as a role value, and must not collide with a
-- built-in or another custom role.
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_role_name_key
  ON public.custom_roles (role_name);

ALTER TABLE public.custom_roles DROP CONSTRAINT IF EXISTS chk_custom_role_name;
ALTER TABLE public.custom_roles
  ADD CONSTRAINT chk_custom_role_name
  CHECK (role_name NOT IN ('super_admin','admin','manager','technician',
                           'viewer','sales_rep','accountant'));

-- ── 2. Let user_roles.role hold one ──────────────────────────────────────────
-- A CHECK cannot contain a subquery, so the fixed list becomes a trigger that
-- accepts a built-in or any defined custom role.

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS chk_user_role;

CREATE OR REPLACE FUNCTION public.rma_validate_user_role() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.role IN ('super_admin','admin','manager','technician',
                  'viewer','sales_rep','accountant') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.custom_roles WHERE role_name = NEW.role) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Unknown role "%": not a built-in and not defined in custom_roles', NEW.role
    USING ERRCODE = 'check_violation';
END
$$;

DROP TRIGGER IF EXISTS trg_validate_user_role ON public.user_roles;
CREATE TRIGGER trg_validate_user_role
  BEFORE INSERT OR UPDATE OF role ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.rma_validate_user_role();

-- Deleting a custom role that people still hold would strand them on a role
-- nothing recognises, and rma_user_role() would resolve to NULL — no access,
-- no obvious cause. Refuse it instead.
CREATE OR REPLACE FUNCTION public.rma_guard_custom_role_delete() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.user_roles WHERE role = OLD.role_name;
  IF v_n > 0 THEN
    RAISE EXCEPTION
      'Cannot delete role "%": % user(s) still hold it. Reassign them first.',
      OLD.role_name, v_n
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_guard_custom_role_delete ON public.custom_roles;
CREATE TRIGGER trg_guard_custom_role_delete
  BEFORE DELETE ON public.custom_roles
  FOR EACH ROW EXECUTE FUNCTION public.rma_guard_custom_role_delete();

-- ── 3. Teach RLS to resolve it ───────────────────────────────────────────────
-- Every existing policy compares against rma_user_role(). Resolving a custom
-- role to its base here means all of them keep working untouched, rather than
-- each policy learning about custom roles separately.

CREATE OR REPLACE FUNCTION public.rma_user_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER AS
$$
  SELECT COALESCE(cr.base_role, ur.role)
    FROM public.user_roles ur
    LEFT JOIN public.custom_roles cr ON cr.role_name = ur.role
   WHERE ur.user_email = (auth.jwt() ->> 'email')
   LIMIT 1
$$;

COMMENT ON FUNCTION public.rma_user_role() IS
  'The role RLS should treat this user as. A custom role resolves to its '
  'base_role, so policies never need to know custom roles exist. The custom '
  'role''s own permission map is applied by the application layer (canDo), '
  'which can only narrow what the base role already allows.';

-- ─── Verification ────────────────────────────────────────────────────────────
-- Inside a rolled-back transaction:
--   INSERT INTO custom_roles(role_name, role_description, permissions, base_role)
--     VALUES ('zz_bookkeeper','probe','{}'::jsonb,'viewer');
--   INSERT INTO user_roles(user_email, role, status)
--     VALUES ('zz@example.com','zz_bookkeeper','active');       -- accepted
--   INSERT INTO user_roles(user_email, role, status)
--     VALUES ('zz2@example.com','not_a_role','active');         -- refused
--   DELETE FROM custom_roles WHERE role_name = 'zz_bookkeeper'; -- refused, 1 holder
