-- Verify 20260811_scope_storage_write_policies.sql  (audit BUG-003, part 1)
--
-- Runs inside one transaction that ends in a RAISE, so nothing is committed —
-- including every row this script inserts into storage.objects. A successful
-- run ENDS IN AN ERROR whose message is the verdict. Read the message, not the
-- exit status.
--
-- Safe to run against production.
--
-- ── Two things this script had to discover the hard way ─────────────────────
--
-- The first version read the bucket's limits AFTER switching the session to a
-- viewer identity, and reported FAIL. storage.buckets has row security enabled
-- with ZERO policies — confirmed from the catalog — which means default-deny:
-- nobody but a role that bypasses RLS can read it. The failure was the probe
-- reading its own fixture while impersonating the wrong identity, not the
-- bucket being unconfigured. Fixed by reading the bucket row while the script
-- is still unscoped, at the very top.
--
-- The second is more fundamental. Supabase installs a statement-level trigger,
-- storage.protect_delete(), that refuses EVERY direct SQL DELETE against
-- storage.objects — for any role, under any RLS policy — unless the session
-- has set the GUC storage.allow_delete_query = 'true'. Its purpose is to stop
-- an accidental `DELETE FROM storage.objects` from orphaning real files in the
-- object store, since a raw SQL delete does not remove the underlying bytes the
-- way the Storage API does. The first version of this script did not know that
-- and read the resulting 42501 as "RLS refused a viewer" — which happened to be
-- the right verdict for the wrong reason, and would have reported the SAME
-- false PASS for a policy that let anyone delete anything, because the
-- blanket trigger fires before RLS is even consulted.
--
-- Opening that gate is what makes this an honest test rather than a guess: it
-- is a transaction-local setting (`true` as the third argument to set_config),
-- so it reverts the instant this script's transaction ends, and it is only
-- ever applied to the disposable, metadata-only fixture row this script
-- creates and immediately destroys — never to a real upload, and there is no
-- real file in the object store for that fixture path to begin with, so
-- nothing is left orphaned. Confirmed empirically before writing this: with
-- the gate open, a viewer's delete of the fixture row still affects 0 rows,
-- and a different technician's delete still succeeds — proving RLS, not the
-- platform guard, is what these checks are now measuring.

DO $verify$
DECLARE
  v_viewer     text;
  v_tech       text;
  v_other_tech text;
  v_obj_id     uuid;
  v_n          integer;
  v_limit      bigint;
  v_types      text[];
  v_out        text := '';
BEGIN
  -- ── Fixtures and the bucket read, all unscoped ─────────────────────────────
  SELECT user_email INTO v_viewer
    FROM public.user_roles WHERE role = 'viewer' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_tech
    FROM public.user_roles WHERE role = 'technician' AND status = 'active' LIMIT 1;
  SELECT user_email INTO v_other_tech
    FROM public.user_roles WHERE role = 'technician' AND status = 'active'
     AND user_email <> coalesce(v_tech, '') LIMIT 1;

  IF v_viewer IS NULL OR v_tech IS NULL THEN
    RAISE EXCEPTION 'Cannot verify: need an active viewer (%) and an active technician (%).',
      coalesce(v_viewer, 'none'), coalesce(v_tech, 'none');
  END IF;

  -- Read here, before any role switch — storage.buckets has RLS enabled with
  -- no policies at all, so this row is invisible under any impersonated
  -- identity and must be read while the script still runs as its own caller.
  SELECT file_size_limit, allowed_mime_types INTO v_limit, v_types
    FROM storage.buckets WHERE id = 'rma-attachments';

  IF v_limit IS NULL OR v_types IS NULL THEN
    v_out := v_out || 'FAIL bucket still has no size/type limit. ';
  ELSE
    v_out := v_out || format('PASS bucket limits present (%s MB, %s types). ',
                              round(v_limit / 1024.0 / 1024.0, 1), array_length(v_types, 1));
  END IF;

  -- Transaction-local only. See the header for why this is safe here and must
  -- never be set outside a rolled-back verification script.
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  PERFORM set_config('role', 'authenticated', true);

  -- ═══ 1. A viewer must not be able to upload ════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);

  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner, metadata)
    VALUES ('rma-attachments', 'probe/viewer-upload-' || gen_random_uuid()::text || '.txt',
            auth.uid(), '{"mimetype":"text/plain","size":1}'::jsonb);
    v_out := v_out || 'FAIL viewer upload: still succeeded. ';
  EXCEPTION
    WHEN insufficient_privilege THEN v_out := v_out || 'PASS viewer upload refused. ';
    WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE viewer upload (SQLSTATE %s). ', SQLSTATE);
  END;

  -- ═══ 2. A technician must be able to upload ════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_tech, 'role', 'authenticated')::text, true);

  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner, metadata)
    VALUES ('rma-attachments', 'probe/tech-upload-' || gen_random_uuid()::text || '.txt',
            auth.uid(), '{"mimetype":"text/plain","size":1}'::jsonb)
    RETURNING id INTO v_obj_id;
    v_out := v_out || 'PASS technician upload allowed. ';
  EXCEPTION
    WHEN OTHERS THEN
      v_out := v_out || format('FAIL technician upload refused (SQLSTATE %s) - staff screens would break. ', SQLSTATE);
  END;

  -- ═══ 3. A viewer must not be able to delete it ═════════════════════════════
  -- The delete-protection gate is open (see header), so a row actually
  -- disappearing or not now reflects RLS alone.
  IF v_obj_id IS NULL THEN
    v_out := v_out || 'SKIP viewer delete (upload above failed, nothing to target). ';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_viewer, 'role', 'authenticated')::text, true);
    BEGIN
      DELETE FROM storage.objects WHERE id = v_obj_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 0 THEN
        v_out := v_out || 'PASS viewer delete filtered to zero rows. ';
      ELSE
        v_out := v_out || 'FAIL viewer delete removed the fixture row. ';
      END IF;
    EXCEPTION
      WHEN insufficient_privilege THEN v_out := v_out || 'PASS viewer delete refused. ';
      WHEN OTHERS THEN v_out := v_out || format('INCONCLUSIVE viewer delete (SQLSTATE %s). ', SQLSTATE);
    END;
  END IF;

  -- ═══ 4. A DIFFERENT technician must be able to delete it ═══════════════════
  -- Deletes are not owner-scoped in the interface (the Trash sweep and ticket
  -- attachment removal both run as whichever staff member is looking at the
  -- screen), so any non-viewer staff member cleaning up after a colleague is
  -- the intended behaviour, not a gap.
  IF v_obj_id IS NULL OR v_other_tech IS NULL THEN
    v_out := v_out || 'SKIP cross-technician delete (only one active technician, or upload above failed). ';
  ELSE
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', v_other_tech, 'role', 'authenticated')::text, true);
    BEGIN
      DELETE FROM storage.objects WHERE id = v_obj_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN
        v_out := v_out || 'PASS a different technician can delete a colleague''s upload.';
      ELSE
        v_out := v_out || 'FAIL delete matched 0 rows unexpectedly (was it already removed above?).';
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        v_out := v_out || format('FAIL cross-technician delete refused (SQLSTATE %s).', SQLSTATE);
    END;
  END IF;

  RAISE EXCEPTION 'VERIFY 20260811 (rolled back) :: %', v_out;
END
$verify$;

-- ─── Manual follow-up (cannot be scripted in SQL) ────────────────────────────
-- storage-api enforces file_size_limit and allowed_mime_types at the HTTP
-- layer, before a storage.objects row exists, so a SQL probe cannot exercise
-- it — and every check above uses metadata-only fixture rows with no real file
-- behind them, so the actual Storage API path is still worth confirming once
-- by hand:
--   1. As any staff member, try to upload a file larger than 25 MB to a ticket
--      -> expect a storage-api error, not a silent success.
--   2. Try to upload a .svg (e.g. as a brand logo) -> expect a rejection,
--      since image/svg+xml is deliberately not in allowed_mime_types.
--   3. As a technician, delete a ticket attachment through the app (not one you
--      uploaded yourself) -> expect it to work, matching check 4 above.
--   4. Confirm a viewer has no delete control offered anywhere in the UI for an
--      attachment — the RLS check in 3 above is the real boundary either way,
--      but the button should not be there to click.
