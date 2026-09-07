-- NOTE ON PROVENANCE: recovered on 2026-09-07 from
-- `supabase_migrations.schema_migrations` (version 20260906152449). Applied to
-- production 2026-09-06; the .sql file was never written to the repository.
-- This is the SQL that actually ran, verbatim.

-- deals.status and deals.stage must agree. (Audit finding BUG-033.)
--
-- markWon() and markLost() set both together, but moveStage() and
-- bulkMoveStage() write only `stage`. Dragging a deal into the Won column
-- therefore left status='open', and the Reports win rate and forecast-versus-
-- actual value counted it as still in play. Two separate UPDATEs, no
-- transaction, and no constraint holding the pair together.
--
-- This derives rather than refuses. Raising on a mismatch would break the
-- pipeline board: moveStage legitimately writes only the stage, and moving a
-- deal into the Won column is the user saying they won it. So the stage is
-- treated as the source of truth and status/won_at/lost_at/probability follow
-- it. A direct write of status='won' with a non-won stage is normalised back to
-- follow the stage rather than silently accepted.
--
-- All 56 existing deals already agree with their stage, so this changes no
-- current row.

DO $do$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.deals d
    JOIN public.pipelines p ON p.id = d.pipeline_id
    CROSS JOIN LATERAL jsonb_array_elements(p.stages) s
   WHERE s.value ->> 'id' = d.stage
     AND ( (coalesce((s.value ->> 'is_won')::boolean,false)  AND d.status <> 'won')
        OR (coalesce((s.value ->> 'is_lost')::boolean,false) AND d.status <> 'lost')
        OR (NOT coalesce((s.value ->> 'is_won')::boolean,false)
            AND NOT coalesce((s.value ->> 'is_lost')::boolean,false)
            AND d.status IN ('won','lost')) );
  IF v_bad > 0 THEN
    RAISE NOTICE '% existing deal(s) disagree with their stage; the trigger will correct them on next write.', v_bad;
  END IF;
END
$do$;

CREATE OR REPLACE FUNCTION public.rma_deal_status_follows_stage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_is_won  boolean;
  v_is_lost boolean;
BEGIN
  IF NEW.pipeline_id IS NULL OR NEW.stage IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT coalesce((s.value ->> 'is_won')::boolean,  false),
         coalesce((s.value ->> 'is_lost')::boolean, false)
    INTO v_is_won, v_is_lost
    FROM public.pipelines p
    CROSS JOIN LATERAL jsonb_array_elements(p.stages) s
   WHERE p.id = NEW.pipeline_id
     AND s.value ->> 'id' = NEW.stage
   LIMIT 1;

  -- Stage not found in the pipeline: leave the row alone rather than invent a
  -- status. moveStage() already rejects an unknown stage.
  IF v_is_won IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_is_won THEN
    NEW.status      := 'won';
    NEW.won_at      := coalesce(NEW.won_at, now());
    NEW.lost_at     := NULL;
    NEW.lost_reason := NULL;
    NEW.probability := 100;
  ELSIF v_is_lost THEN
    NEW.status      := 'lost';
    NEW.lost_at     := coalesce(NEW.lost_at, now());
    NEW.won_at      := NULL;
    NEW.probability := 0;
  ELSE
    -- Back into play from a terminal stage: clear the terminal markers so the
    -- reports stop counting it as decided.
    IF NEW.status IN ('won', 'lost') THEN
      NEW.status      := 'open';
      NEW.won_at      := NULL;
      NEW.lost_at     := NULL;
      NEW.lost_reason := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_deals_status_follows_stage ON public.deals;
CREATE TRIGGER trg_deals_status_follows_stage
  BEFORE INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.rma_deal_status_follows_stage();

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_deals_status_follows_stage') THEN
    RAISE EXCEPTION 'Refusing to finish: the trigger was not created.';
  END IF;
  RAISE NOTICE 'BUG-033: deals.status now follows the stage on every write.';
END
$do$;
