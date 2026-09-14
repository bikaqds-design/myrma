-- ############################################################################
-- #  DB TEST TIER — bulk-upload SKU candidates (BUG-066, phase 5b)
-- #
-- #  rma_product_sku_candidates() (20260856) returns the products
-- #  src/lib/skuMatch.js could pick for each normalised filename base. It must
-- #  never leave out a product the matcher would have chosen, and must not
-- #  offer ones it could not:
-- #
-- #    - an exact normalised SKU match, at any length;
-- #    - a SKU of 4+ characters contained in the name;
-- #    - not a shorter contained SKU ("SSD" inside every filename);
-- #    - SKU punctuation and case do not matter;
-- #    - a blank base matches nothing; the index maps back to the input order.
-- #
-- #  NOT in CI: the db-tests job is disabled (needs Docker). Run against the
-- #  hosted project with the cleanup replaced by an unconditional RAISE.
-- ############################################################################

DO $$
DECLARE
  v_tag text := floor(random() * 1000000)::text;
  p_long uuid; p_short uuid; p_tiny uuid; p_punct uuid;
  v_ids uuid[];
  v_failures text[] := '{}';
  v_checks int := 0;
BEGIN
  INSERT INTO public.products (sku, product_name, product_type, status)
    VALUES ('CIQ' || v_tag || 'E16', 'CI SKU long', 'hardware', 'active') RETURNING id INTO p_long;
  INSERT INTO public.products (sku, product_name, product_type, status)
    VALUES ('CIQ' || v_tag, 'CI SKU short', 'hardware', 'active') RETURNING id INTO p_short;
  INSERT INTO public.products (sku, product_name, product_type, status)
    VALUES ('Q' || substr(v_tag, 1, 2), 'CI SKU tiny', 'hardware', 'active') RETURNING id INTO p_tiny;
  INSERT INTO public.products (sku, product_name, product_type, status)
    VALUES ('ci-pn_' || v_tag || '.x', 'CI SKU punctuated', 'hardware', 'active') RETURNING id INTO p_punct;

  -- ── CHECK 1: both contained SKUs are offered; the matcher picks the longer ──
  v_checks := v_checks + 1;
  SELECT array_agg(id ORDER BY id) INTO v_ids
    FROM public.rma_product_sku_candidates(ARRAY['DATASHEETCIQ' || v_tag || 'E16REV2'])
   WHERE id IN (p_long, p_short, p_tiny, p_punct);
  IF v_ids IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[p_long, p_short]) x) THEN
    v_failures := array_append(v_failures, format('CHECK 1: contained candidates %s, expected the long and short SKU', v_ids));
  END IF;

  -- ── CHECK 2: a SKU under 4 characters is offered only on an exact match ─────
  v_checks := v_checks + 1;
  IF EXISTS (SELECT 1 FROM public.rma_product_sku_candidates(ARRAY['ABCQ' || substr(v_tag, 1, 2) || 'XYZ']) WHERE id = p_tiny) THEN
    v_failures := array_append(v_failures, 'CHECK 2a: a 3-character SKU matched by containment');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rma_product_sku_candidates(ARRAY['Q' || substr(v_tag, 1, 2)]) WHERE id = p_tiny) THEN
    v_failures := array_append(v_failures, 'CHECK 2b: a 3-character SKU did not match exactly');
  END IF;

  -- ── CHECK 3: punctuation and case in the SKU do not matter ──────────────────
  v_checks := v_checks + 1;
  IF NOT EXISTS (SELECT 1 FROM public.rma_product_sku_candidates(ARRAY['CIPN' || v_tag || 'X']) WHERE id = p_punct) THEN
    v_failures := array_append(v_failures, 'CHECK 3: a punctuated lower-case SKU did not match its normalised form');
  END IF;

  -- ── CHECK 4: blanks match nothing; the index follows the input ──────────────
  v_checks := v_checks + 1;
  IF EXISTS (SELECT 1 FROM public.rma_product_sku_candidates(ARRAY['', NULL])) THEN
    v_failures := array_append(v_failures, 'CHECK 4a: a blank base matched products');
  END IF;
  IF (SELECT array_agg(DISTINCT base_index) FROM public.rma_product_sku_candidates(ARRAY['', 'CIQ' || v_tag]) WHERE id = p_short)
     IS DISTINCT FROM ARRAY[2] THEN
    v_failures := array_append(v_failures, 'CHECK 4b: base_index does not point back at the input position');
  END IF;

  -- ── CHECK 5: access ─────────────────────────────────────────────────────────
  v_checks := v_checks + 1;
  IF has_function_privilege('anon', 'public.rma_product_sku_candidates(text[])', 'EXECUTE') THEN
    v_failures := array_append(v_failures, 'CHECK 5: anon can call rma_product_sku_candidates');
  END IF;

  DELETE FROM public.products WHERE id IN (p_long, p_short, p_tiny, p_punct);

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'% of % sku-candidate check(s) FAILED:\n%',
      array_length(v_failures, 1), v_checks, array_to_string(v_failures, E'\n');
  END IF;
  RAISE NOTICE 'All % sku-candidate checks passed', v_checks;
END $$;
