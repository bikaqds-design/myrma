-- ============================================================================
-- 20260891_line_readers_fingerprint_receive.sql
-- W2 / L-02, third step: the last two database readers of the line_items
-- copy move to the rows, so the copy is only ever WRITTEN (and can be dropped
-- once the screens are checked in a browser — the next step).
--
--   * The credit-note approval fingerprint (submitted_hash). submit takes it
--     over the note's rows (rma_credit_note_lines_json, 20260890); issue
--     re-checks it the same way. A note submitted BEFORE this migration was
--     fingerprinted over its copy: issue still accepts it, but only if that
--     copy is still identical to the rows — a note whose copy and rows
--     disagree (possible only for data the 20260887 backfill corrected) is
--     refused with a plain message to return it to draft and submit again.
--   * receive_vendor_invoice reads the invoice's lines once, from the rows
--     (rma_vendor_invoice_lines_json), wherever it read the copy: the line
--     count, the product on a line, which line a product is on, and what a
--     line has left to receive. It still writes the copy (rebuilt from the
--     rows it read) and the rows, as 20260889 made it.
--
-- As in 20260867 / 20260890, only the listed expressions change in the live
-- definitions, each counted before anything is replaced.
-- ============================================================================

DO $$
DECLARE
  v_rules jsonb := jsonb_build_array(
    -- submit: fingerprint the rows
    jsonb_build_array('submit_credit_note_for_approval',
      'v_cn.total::text, v_cn.subtotal::text, v_cn.line_items::text)),',
      'v_cn.total::text, v_cn.subtotal::text, public.rma_credit_note_lines_json(v_cn.id)::text)),', 1),
    -- issue: the rows' fingerprint, or (a note submitted before 20260891) the
    -- copy's, accepted only while the copy still equals the rows
    jsonb_build_array('issue_credit_note',
      'IF v_cn.submitted_hash IS DISTINCT FROM md5(concat_ws(''|'', v_cn.type, v_cn.customer_id::text, COALESCE(v_cn.source_invoice_id::text, ''''),
                                        v_cn.total::text, v_cn.subtotal::text, v_cn.line_items::text)) THEN',
      'IF v_cn.submitted_hash IS DISTINCT FROM md5(concat_ws(''|'', v_cn.type, v_cn.customer_id::text, COALESCE(v_cn.source_invoice_id::text, ''''),
                                        v_cn.total::text, v_cn.subtotal::text, public.rma_credit_note_lines_json(v_cn.id)::text))
       AND NOT (v_cn.line_items IS NOT DISTINCT FROM public.rma_credit_note_lines_json(v_cn.id)
                AND v_cn.submitted_hash IS NOT DISTINCT FROM md5(concat_ws(''|'', v_cn.type, v_cn.customer_id::text, COALESCE(v_cn.source_invoice_id::text, ''''),
                                        v_cn.total::text, v_cn.subtotal::text, v_cn.line_items::text))) THEN', 1),
    -- receive: read the rows once
    jsonb_build_array('receive_vendor_invoice',
      '  v_final_line_items   jsonb;',
      '  v_final_line_items   jsonb;
  v_items              jsonb;                  -- the invoice''s lines, from its rows (20260891)', 1),
    jsonb_build_array('receive_vendor_invoice',
      '  v_lines := jsonb_array_length(COALESCE(v_vi.line_items, ''[]''::jsonb));',
      '  v_items := public.rma_vendor_invoice_lines_json(p_vi_id);
  v_lines := jsonb_array_length(v_items);', 1),
    jsonb_build_array('receive_vendor_invoice', 'v_vi.line_items', 'v_items', 5)
  );
  v_fn    text;
  v_def   text;
  v_old   text;
  v_new   text;
  v_want  integer;
  v_have  integer;
  v_r     jsonb;
  v_defs  jsonb := '{}'::jsonb;
BEGIN
  FOR v_r IN SELECT * FROM jsonb_array_elements(v_rules) LOOP
    v_fn := v_r->>0; v_old := v_r->>1; v_new := v_r->>2; v_want := (v_r->>3)::integer;
    IF NOT v_defs ? v_fn THEN
      SELECT pg_get_functiondef(p.oid) INTO STRICT v_def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn;
      v_defs := v_defs || jsonb_build_object(v_fn, v_def);
    END IF;
    v_def  := v_defs->>v_fn;
    v_have := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_have <> v_want THEN
      RAISE EXCEPTION 'Refusing to apply: % holds "%" % time(s), expected %', v_fn, left(v_old, 80), v_have, v_want;
    END IF;
    v_defs := jsonb_set(v_defs, ARRAY[v_fn], to_jsonb(replace(v_def, v_old, v_new)));
  END LOOP;

  FOR v_fn IN SELECT jsonb_object_keys(v_defs) LOOP
    EXECUTE v_defs->>v_fn;   -- CREATE OR REPLACE keeps the signature, owner and grants
  END LOOP;
END $$;

-- ── guard: what still touches the copy is known and intended ─────────────────
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'receive_vendor_invoice';
  IF v_def ~ 'v_vi\.line_items' THEN
    RAISE EXCEPTION 'Refusing to finish: receive_vendor_invoice still reads the line_items copy';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'submit_credit_note_for_approval';
  IF v_def ~ 'line_items' THEN
    RAISE EXCEPTION 'Refusing to finish: submit_credit_note_for_approval still fingerprints the line_items copy';
  END IF;
END $$;
