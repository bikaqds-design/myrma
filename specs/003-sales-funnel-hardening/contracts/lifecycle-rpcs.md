# Contract: Lifecycle Transition RPCs

The funnel's transition API. Each is a `SECURITY DEFINER` PL/pgSQL function, idempotent to define (`CREATE OR REPLACE`), locking the target document row `FOR UPDATE`, doing all writes in one transaction, and raising a clear exception on any refused transition (surfaced to the user as a toast). TS API methods become thin callers.

Convention: `p_actor_email text` is the current user's email (the "who" convention — never a uuid). All RPCs `SET search_path = public`.

---

## Inventory dispatch helpers (internal) — FR-001/002

```
funnel_reserve_line(p_doc_type text, p_doc_id uuid, p_product_id uuid, p_qty numeric, p_actor_email text) RETURNS void
funnel_deliver_line(p_doc_type text, p_doc_id uuid, p_product_id uuid, p_qty numeric, p_actor_email text) RETURNS void
funnel_release_line(p_doc_type text, p_doc_id uuid, p_product_id uuid, p_qty numeric, p_actor_email text) RETURNS void
```
Behavior: classify `p_product_id` (serialized → units RPC; fungible → parts RPC; service → no-op). Reserve raises `P0001 'Insufficient stock: need N, only M available for <product>'` only for serialized/fungible shortfalls — **never** for service lines.

---

## convert_quotation_to_so — FR-005/006/007

```
convert_quotation_to_so(p_quotation_id uuid, p_actor_email text) RETURNS uuid   -- new SO id
```
- Lock quotation `FOR UPDATE`.
- Refuse if `status ∈ {cancelled, declined, converted}` → `'Cannot convert a <status> quotation'`.
- Refuse if any line has `product_id IS NULL` → `'N line(s) have no product — promote them first'`.
- Refuse if a `sales_orders` row already references this quotation → `'Quotation already converted'` (idempotency, FR-006).
- Insert SO (`status='draft'`, copy lines/totals, `so_code` via `generate_doc_code('SO')`), set `quotations.status='converted'` — **same tx**.
- Returns new SO id.

## approve_sales_order — FR-001/003/005/007/011

```
approve_sales_order(p_so_id uuid, p_actor_email text) RETURNS sales_orders
```
- Require `rma_is_manager_or_above()` → else `'Not authorized to approve sales orders'`.
- Lock SO `FOR UPDATE`; refuse unless `status='sent'` → `'Sales order must be submitted for approval first (current: <status>)'`.
- For **every** line: `funnel_reserve_line('sales_order', …)`. Any shortfall raises and rolls back the whole approval (status stays `sent`).
- Set `status='delivered'`, stamp `confirmed_at=now`, `delivered_at=now`. Return the row.

## reject_sales_order — FR-011

```
reject_sales_order(p_so_id uuid, p_actor_email text) RETURNS sales_orders
```
- Require `rma_is_manager_or_above()`.
- Lock `FOR UPDATE`; set `status='declined'`. (No inventory effect.)

## cancel_sales_order — FR-003/007

```
cancel_sales_order(p_so_id uuid, p_actor_email text) RETURNS sales_orders
```
- Lock SO `FOR UPDATE`.
- Refuse if a non-cancelled `crm_invoices` row references this SO → `'Cannot cancel — an invoice exists; void/credit it instead'`.
- For every line: `funnel_release_line('sales_order', …)` (releases units/parts; no-op for service).
- Set `status='cancelled'`. Return the row. **Closes H2** — works from `draft|sent|delivered`.

## post_invoice (replaces existing) — FR-005/007/011

```
post_invoice(p_invoice_id uuid, p_actor_email text) RETURNS text   -- assigned inv_code
```
- Require `rma_is_manager_or_above()`.
- Lock invoice `FOR UPDATE`; refuse unless `doc_status='draft'` → `'Invoice already <status>'`.
- Assign `inv_code := nextval_for_type('invoice')`, set `doc_status='posted'`, `posted_at=now`.
- For every line: `funnel_deliver_line('invoice', …)` (delivers reserved units/parts; service no-op) — **same tx** (Invariant I1). On any failure the code assignment and status change roll back together (no burned sequence number, no posted-without-stock).
- Return `inv_code`.

## void_invoice — FR-010/007/011

```
void_invoice(p_invoice_id uuid, p_reason text, p_actor_email text) RETURNS crm_invoices
```
- Require `rma_is_manager_or_above()`; require non-empty `p_reason`.
- Lock `FOR UPDATE`; refuse unless `doc_status='posted'`.
- Refuse if EXISTS `payment_applications` OR `credit_note_applications` for this invoice → `'Reverse payments/credit notes before voiding'` (Invariant I2).
- Reverse delivery for every line (restore delivered units→available / parts quantity), set `doc_status='cancelled'`, `payment_status='reversed'`, `void_reason=p_reason`. Same tx.

## issue_credit_note (extended) — FR-005/007

```
issue_credit_note(p_cn_id uuid, p_actor_email text) RETURNS text   -- cn_code
```
- Lock CN `FOR UPDATE`; refuse unless `status='draft'`.
- Assign `cn_code`, set `status='issued'`, `remaining_balance=total`, `issued_at=now`.
- If `source_invoice_id` is set: insert the `credit_note_applications` row for `min(remaining_balance, invoice_remaining)` **and** bump `crm_invoices.amount_paid`/`payment_status` — all in this tx (Invariant A1). (Restock for `rma_return` stays the existing separate two-step unit-resolution flow.)
- Return `cn_code`.

## record_payment (extended) — FR-005/007

```
record_payment(p_customer_id uuid, p_amount numeric, p_method text, p_reference text,
               p_payment_date date, p_notes text, p_allocations jsonb, p_actor_email text) RETURNS uuid  -- payment id
```
- Insert the payment row (`payment_code` via `nextval_for_type('payment')`, `unapplied_amount=p_amount`).
- For each allocation in `p_allocations` (array `[{invoice_id, amount}]`): insert `payment_applications` row **and** bump that invoice's `amount_paid`/`payment_status` — all in this tx (Invariant A2). `unapplied_amount` settles via the existing trigger.
- Refuse if any allocation exceeds the payment's remaining unapplied or the invoice's remaining balance.
- Return payment id.

---

## TS wrapper shape (all modules)

```ts
// before: multiple awaited supabase.* calls
// after:
async approveSalesOrder(soId: string, actorEmail: string): Promise<SalesOrderRow> {
  const { data, error } = await supabase.rpc('approve_sales_order', { p_so_id: soId, p_actor_email: actorEmail })
  if (error) throw error          // error.message carries the RPC's RAISE text → toast
  return data as SalesOrderRow
}
```
The Activities-page approval dispatch and `SalesDocumentDetail` handlers keep their current call sites; only the underlying method bodies change.
