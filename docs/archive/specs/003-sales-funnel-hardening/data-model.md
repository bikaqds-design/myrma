# Phase 1 Data Model: Sales Funnel Hardening

This feature adds **no new tables** and (preferably) **no new columns**. It formalizes the state machines, the line-classification derivation, and the invariants each lifecycle RPC must enforce. Schema work is RPCs + one trigger.

---

## Entities (existing — referenced, not created)

| Entity | Table | Role in this feature |
|---|---|---|
| Quotation | `quotations` | source of SO; `status` machine below |
| Sales Order | `sales_orders` | holds reservations; `status` machine below |
| Invoice | `crm_invoices` | `doc_status` + `payment_status`; delivery + AR |
| Credit Note | `credit_notes` (+ `credit_note_applications`) | reduces AR; restocks on `rma_return` |
| Payment | `payments` (+ `payment_applications`) | reduces AR |
| Serialized unit | `inventory_units` | `reservation_status` ∈ {available, reserved, delivered} |
| Fungible part | `parts` | `quantity`, `reserved_quantity` counters |
| Stock ledger | `stock_moves` | append-only audit of every reserve/deliver/release/restore |
| Sequence | `document_sequences` | gapless INV-/CN- via `nextval_for_type` |
| Lead / Deal / Pipeline | `leads` / `deals` / `pipelines` | bulk-edit guards |

---

## Line classification (derived, not stored) — FR-002

For any document line with `product_id = P`:

```
classify(P):
  if EXISTS (inventory_units WHERE product_id = P)        -> 'serialized'
  elif EXISTS (parts WHERE <part maps to product P>)      -> 'fungible'
  else                                                    -> 'service'   (non-stock)
```

- **serialized** → `reserve_units` / `deliver_units` / `release_units`
- **fungible** → `reserve_parts` / `deliver_parts` / `restore_parts`
- **service** → no inventory movement

Precedence: serialized beats fungible if both somehow match (units are the stronger identity). A line with `product_id = NULL` (free-form quotation line) is always **service** for reservation purposes and cannot reach an order (blocked at conversion, per existing rule + L3).

---

## State machines (target, enforced in RPCs)

### Quotation
```
draft ──send──▶ sent ──approve──▶ accepted ──convert──▶ converted (terminal)
  ▲               │                                  
  └──reopen───────┴──reject──▶ declined ──reopen──▶ draft
draft|sent|accepted ──cancel──▶ cancelled ──reopen──▶ draft
(scheduled) ──▶ expired
```
- **Invariant Q1**: only `draft|accepted` may convert; conversion is atomic with `status:=converted`.
- **Invariant Q2 (FR-006)**: a quotation already `converted` (or already referenced by a SO) cannot produce a second SO.

### Sales Order
```
draft ──send──▶ sent ──approve──▶ delivered* ──convert──▶ (invoice created)
  ▲               │
  └──reopen───────┴──reject──▶ declined ──reopen──▶ sent
not-invoiced(any of draft|sent|delivered) ──cancel──▶ cancelled   (releases reservations)
```
`delivered*` = approved state: **inventory reserved**, `confirmed_at`+`delivered_at` stamped. Actual stock decrement happens later at invoice post.
- **Invariant S1 (FR-001)**: `approve` reserves **every** line by its derived class; if any serialized/fungible line is short, the whole approval rolls back and status stays `sent`.
- **Invariant S2 (FR-003)**: `cancel` is allowed while **no non-cancelled invoice** references the SO; it releases all reservations (units→available, parts.reserved_quantity decremented).
- **Invariant S3 (FR-011)**: `approve`/`reject` require `rma_is_manager_or_above()`.
- **Invariant S4 (FR-007)**: `approve`/`cancel`/`convert` lock the SO row `FOR UPDATE`; concurrent callers serialize.

### Invoice
```
draft ──post──▶ posted ──(payments / credit notes)──▶ payment_status: unpaid→partial→paid
draft is "awaiting approval"; post is the approval action.
posted ──void(guarded)──▶ cancelled (payment_status:=reversed)
```
- **Invariant I1 (FR-005)**: `post` assigns `inv_code`, sets `posted`, and delivers every line by class — **all in one transaction**. No posted invoice without its stock movement.
- **Invariant I2 (FR-010)**: `void` is refused if any `payment_applications` or `credit_note_applications` reference the invoice; for a clean posted invoice, void reverses the delivery (restore delivered units/parts to available).
- **Invariant I3 (FR-007/011)**: `post`/`void` lock the row `FOR UPDATE` and require `rma_is_manager_or_above()`.
- **Invariant I4**: `payment_status` is always derived from `amount_paid` vs `total`, never set directly.

### Credit Note / Payment (AR application)
- **Invariant A1 (FR-005)**: issuing a CN linked to an invoice performs `issue` + `applyToInvoice` + invoice-balance bump atomically; a partial failure can never leave a CN "applied" while the invoice/aging disagree.
- **Invariant A2 (FR-005)**: recording a payment performs the payment insert + each allocation + each invoice-balance bump atomically.
- **Invariant A3**: ledger identity holds — customer balance `= Σ(posted invoice.total) − Σ(issued/applied CN.total) − Σ(active payment.amount)`; `v_customer_ledger` and the aging report agree with each invoice's own `amount_paid`.

### Lead / Deal (bulk guards)
- **Invariant L1 (FR-009)**: a lead with `converted_at` set is immutable except `notes` — enforced on **both** `update` and `bulkUpdate`, plus a DB trigger.
- **Invariant D1 (FR-008)**: `bulkMoveStage` only writes a stage valid for each deal's pipeline; moving to a non-terminal stage resets `status:=open`, clears `won_at`/`lost_at`; moving to a won/lost stage sets the matching terminal status.

---

## Inventory invariant (the heart of H1/H2)

At all times, for every product:
```
available(serialized) = COUNT(units WHERE reservation_status='available')
reserved(serialized)  = COUNT(units WHERE reservation_status='reserved')
available(fungible)   = parts.quantity − parts.reserved_quantity
```
- Reserve moves available→reserved (serialized) or increments `reserved_quantity` (fungible).
- Deliver (invoice post) moves reserved→delivered (serialized, decrements on-hand) or `quantity−=qty, reserved_quantity−=qty` (fungible).
- Release (SO cancel) moves reserved→available (serialized) or decrements `reserved_quantity` (fungible).
- **No transition may leave a reservation without a document that owns it** — i.e. every `reserved` unit/`reserved_quantity` traces to a non-cancelled SO (or posted invoice mid-deliver). H2 is the violation this closes.

Every reserve/deliver/release/restore writes a `stock_moves` row (existing behavior preserved).

---

## Migration impact

- **New RPCs** (idempotent `CREATE OR REPLACE`): `convert_quotation_to_so`, `approve_sales_order`, `reject_sales_order`, `cancel_sales_order`, `post_invoice` (replace), `void_invoice`, `issue_credit_note` (extend), `record_payment` (extend); plus internal helper `funnel_reserve_line` / `funnel_deliver_line` / `funnel_release_line` that switch on derived class.
- **New trigger**: `leads` BEFORE UPDATE → block non-`notes` changes when `converted_at IS NOT NULL`.
- **No column drops/renames.** Optional (deferred): a generated/denormalized line-class is explicitly **not** added (R1).
- **File move** (not a migration): reset script → `scripts/manual/`.
