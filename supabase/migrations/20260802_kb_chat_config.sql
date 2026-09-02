-- 20260802_kb_chat_config.sql
-- Knowledge Center, part 2 — configuration for the answer engine.
--
-- ═══ What is here, and what is deliberately not ══════════════════════════════
--
-- Two settings: which model to use, and which OpenAI-compatible endpoint to
-- reach it at. Both are safe to keep in the database and safe for staff to
-- read, and keeping them here rather than in the function's environment means
-- changing model is a dropdown rather than a redeploy — which matters, because
-- providers retire model identifiers on their own schedule.
--
-- THE API KEY IS NOT HERE, and must never be. Anything in rma_config is
-- readable by every staff member and travels in backups. The key lives only in
-- the Edge Function's secret environment:
--
--   supabase secrets set KB_LLM_API_KEY=...
--
-- ═══ Why the model name is empty by default ══════════════════════════════════
--
-- Model identifiers change, and a wrong one baked into a migration produces a
-- confusing provider error at the moment someone first tries to use the
-- feature. Empty means "not configured yet", the chat says exactly that, and
-- whoever sets it pastes the identifier from their provider's own console —
-- which is the only place it is reliably correct.
--
-- ═══ Applying ════════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL editor. Apply 20260801 first.
-- Verify with supabase/manual/20260846_verify_kb_chat.sql.

INSERT INTO public.rma_config (config_key, config_value) VALUES
  -- The provider's model identifier, copied from their console. NVIDIA's
  -- OpenAI-compatible endpoint takes names like 'nvidia/llama-3.1-nemotron-70b-instruct';
  -- confirm the exact string against your own account rather than trusting this
  -- comment, which will age.
  ('kb_llm_model',    '""'::jsonb),
  -- Any OpenAI-compatible base URL. Blank uses the function's default.
  ('kb_llm_base_url', '""'::jsonb)
ON CONFLICT (config_key) DO NOTHING;

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.rma_config WHERE config_key = 'kb_llm_model'
  ) THEN
    RAISE EXCEPTION 'Refusing to apply: kb_llm_model was not created.';
  END IF;

  -- The one thing worth refusing outright. If a key has been pasted into
  -- config by someone following a half-remembered instruction, it is readable
  -- by every staff member and sitting in every backup.
  IF EXISTS (
    SELECT 1 FROM public.rma_config
     WHERE config_key LIKE 'kb_llm%'
       AND length(config_value #>> '{}') > 60
  ) THEN
    RAISE EXCEPTION
      'Refusing to apply: a kb_llm_* config value is long enough to be an API key. Keys belong in the Edge Function secret, not in rma_config, which every staff member can read and every backup contains.';
  END IF;

  RAISE NOTICE 'Knowledge Center chat configuration ready. Set the API key with: supabase secrets set KB_LLM_API_KEY=...';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Run supabase/manual/20260846_verify_kb_chat.sql.
