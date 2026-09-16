# Contract: Governance & Bulk-Edit Guards

Covers FR-008 (deal bulk stage), FR-009 (lead bulk immutability), FR-012 (convert validation), FR-013 (UI dead control). These are smaller, mostly API-layer + one trigger; not all are RPCs.

---

## Lead converted-immutability trigger — FR-009 (Invariant L1)

```sql
-- BEFORE UPDATE ON public.leads
CREATE FUNCTION public.guard_converted_lead() RETURNS trigger AS $$
BEGIN
  IF OLD.converted_at IS NOT NULL THEN
    -- allow only notes (and the convert RPC's own status write, which runs as the RPC) to change
    IF NEW.* IS DISTINCT FROM OLD.* EXCEPT for notes  -- (expressed field-by-field in impl)
       THEN RAISE EXCEPTION 'Converted leads are immutable except for notes';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
```
- Enforces immutability regardless of caller (single `update`, `bulkUpdate`, or a future path).
- The TS `leads.bulkUpdate` also gains the same guard for a friendly pre-flight error (defense in depth); the trigger is the backstop.
- **Note**: the `crm_convert_lead` RPC sets `status='converted'` *as part of* converting (when `converted_at` is being set in the same statement) — the trigger only fires on rows where `OLD.converted_at` is already non-null, so it does not block the conversion itself.

## Deal bulk stage-move validation — FR-008 (Invariant D1)

API-layer change in `deals.bulkMoveStage(ids, stageId)`:
- Load the distinct pipelines of the selected deals; verify `stageId` exists in **each**; if any lacks it → throw `'Stage not valid for all selected deals'` (no partial write).
- Determine the target stage's `is_won`/`is_lost`:
  - terminal won → set `status='won'`, `won_at=now`, clear `lost_*`.
  - terminal lost → requires a reason (reject bulk-move into `lost`; lost needs a reason per single-path rule) → throw `'Use Mark Lost for the lost stage'`.
  - non-terminal → set `status='open'`, clear `won_at`/`lost_at`.
- Single `update … in (ids)` per status-group, or per-deal when groups differ.

## Lead convert customer validation — FR-012 (L1)

In `crm_convert_lead` (RPC, extend): when `p_existing_customer_id` is provided, verify the customer exists (`SELECT 1 FROM customers WHERE id = p_existing_customer_id`) → else `RAISE EXCEPTION 'Target customer not found'`. (Visibility is already governed by the caller's RLS context for reads; existence is the missing check.)

## UI: remove dead controls — FR-013 (L2/L4)

`src/pages/SalesDocuments/SalesDocumentDetail.jsx`:
- Remove the **Cancel** button branch that renders for SO `status='delivered'` (the new `cancel_sales_order` *does* allow cancel-when-not-invoiced, so instead: keep Cancel for a not-invoiced `delivered` SO and let the RPC enforce the invoice guard — the button is no longer dead, it's correct). Net: the control stays, but its enabled condition matches what the RPC permits, and its failure path shows the RPC's reason (FR-014).
- Delete the unused `canApprove` constant (L4 dead code) or wire it if a gate is wanted on this page (the real gate is the Activities page + the RPC role check).

## Refusal surfacing — FR-014

All RPC exceptions carry their `RAISE EXCEPTION` message in `error.message`. The existing `runAction`/catch pattern already does `toast.error(err?.message || fallback)`, so no refused transition is silent. Verify each call site passes the message through (some currently swallow to a generic `common.error` — change those to surface `err.message`).
