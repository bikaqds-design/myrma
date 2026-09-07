-- RMA numbers are assigned by the database, not guessed by the browser.
-- (Audit finding BUG-035.)
--
-- ── What was wrong ───────────────────────────────────────────────────────────
--
-- `generateRmaNumber(existingTickets)` took the maximum serial among today's
-- tickets *in the list the browser happens to hold* and added one:
--
--   const nextSerial = todaySerials.length > 0 ? Math.max(...todaySerials) + 1 : 1
--
-- Two people creating a ticket at the same time compute the same number.
-- `rma_tickets.rma_number` is UNIQUE, so the second save fails — surfacing to
-- the user as "Failed to save ticket: duplicate key…" after they have filled in
-- the whole form. The list it counts from is also capped at 5,000 rows, so once
-- the table passes that cap the maximum stops being the real maximum.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
--
-- A BEFORE INSERT trigger assigns the number, always, ignoring whatever the
-- client sent. The format is unchanged — `RMA-DDMMYYYY-NNNN`, a serial that
-- restarts each day — because it is printed on work orders and QR codes.
--
-- Races are settled with a transaction-scoped advisory lock keyed on the date
-- string. Two concurrent inserts on the same day queue behind it, so each reads
-- a maximum that already includes the other. The lock is released when the
-- transaction ends, and it is per-day, so tickets created on different days
-- never contend.
--
-- A sequence would not fit here: the serial restarts daily, and
-- `document_sequences` resets yearly. Locking on the day and taking max+1 keeps
-- the existing numbering exactly as it is.
--
-- ── Why the browser still generates one ──────────────────────────────────────
--
-- The form uploads attachments before the row exists, under a folder named
-- after the RMA number, so it needs *a* string up front. That provisional value
-- is now only a folder name; the authoritative number comes back on the
-- inserted row and the client uses that for everything the user sees. Keying
-- attachments by ticket id instead is BUG-026's job, not this one's.

-- ═══ Guard: preconditions ════════════════════════════════════════════════════

DO $do$
DECLARE
  v_dupes integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid='public.rma_tickets'::regclass
                    AND attname='rma_number' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Refusing to apply: rma_tickets.rma_number does not exist.';
  END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT rma_number FROM public.rma_tickets GROUP BY rma_number HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION
      'Refusing to apply: % duplicate rma_number value(s) already exist. Nothing has been changed.', v_dupes;
  END IF;
END
$do$;

-- ═══ The assigner ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rma_assign_ticket_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_date   text;
  v_prefix text;
  v_next   integer;
BEGIN
  -- Local calendar date, matching what the browser used to produce. The
  -- session timezone is the database's, which is the one convention the
  -- overdue cron already uses (see BUG-038 for the wider timezone question).
  v_date   := to_char(now(), 'DDMMYYYY');
  v_prefix := 'RMA-' || v_date || '-';

  -- Serialise same-day inserts. Transaction-scoped, so it is released on
  -- commit or rollback without any explicit unlock.
  PERFORM pg_advisory_xact_lock(hashtext('rma_ticket_number_' || v_date));

  SELECT coalesce(max(substring(t.rma_number from '[0-9]+$')::integer), 0) + 1
    INTO v_next
    FROM public.rma_tickets t
   WHERE t.rma_number LIKE v_prefix || '%'
     AND t.rma_number ~ ('^' || v_prefix || '[0-9]+$');

  -- Assigned unconditionally: whatever the client sent is a provisional folder
  -- name, not an identifier it gets to choose.
  NEW.rma_number := v_prefix || lpad(v_next::text, 4, '0');

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_rma_tickets_assign_number ON public.rma_tickets;
CREATE TRIGGER trg_rma_tickets_assign_number
  BEFORE INSERT ON public.rma_tickets
  FOR EACH ROW EXECUTE FUNCTION public.rma_assign_ticket_number();

-- ═══ Guard ═══════════════════════════════════════════════════════════════════

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_rma_tickets_assign_number') THEN
    RAISE EXCEPTION 'Refusing to finish: the assigner trigger was not created.';
  END IF;
  RAISE NOTICE 'BUG-035: rma_number is now assigned by the database on insert.';
END
$do$;

-- ─── Verification ────────────────────────────────────────────────────────────
-- Rolled-back probe: two inserts that both claim the same number end up with
-- consecutive ones; an insert claiming a number from another day is corrected;
-- the daily serial restarts.
--
-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER trg_rma_tickets_assign_number ON public.rma_tickets;
-- which returns number generation to the browser and the duplicate-key failures
-- with it.
