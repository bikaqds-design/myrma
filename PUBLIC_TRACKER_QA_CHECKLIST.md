# Public Tracker QA — `/tracker`

The only unauthenticated surface in the app. `src/pages/RMATracker.jsx` (868
lines) plus the `public-track` edge function, which is the sole thing standing
between an anonymous caller and the tables.

Run date: 2026-08-12.

---

## A. Access and exposure

| # | Check | Result |
|---|-------|--------|
| 1 | Loads with no auth; no app chrome or nav leaks in | ✅ served before the auth gate, standalone layout |
| 2 | Lookup by a valid RMA number | ✅ returns status, progress, items, comments |
| 3 | Unknown RMA number | ✅ `{ ticket: null }` — no error detail, no enumeration signal |
| 4 | Ticket response is column-whitelisted | ✅ 10 columns; no email, mobile, technician or cost |
| 5 | Comment response is column-whitelisted | ❌→✅ **BUG #34** — returned `select('*')`, all 11 columns including `user_email` |
| 6 | Staff identity not exposed | ❌→✅ **BUG #34** — the page printed `bika.qds@gmail.com` above every reply |
| 7 | RMA number cannot be guessed by pattern | ❌→✅ **BUG #35** — `ilike` honoured `%` and `_`, so `RMA-21052026%` matched |
| 8 | Rate limiting present | ✅ 429 with `resetIn`, bucketed per caller |
| 9 | Input length capped | ✅ `rmaNumber` > 64 and comment > 5000 rejected |

## B. Behaviour

| # | Check | Result |
|---|-------|--------|
| 10 | Progress bar reflects the ticket status | ✅ and legacy `New` is normalised to `Open` for the bar |
| 11 | Items list shows product, serial, warranty | ✅ |
| 12 | Comment thread renders, replies nest | ✅ `parent_comment_id` drives threading |
| 13 | Customer can post a comment | ✅ writes with `is_customer_comment` |
| 14 | Attachments render | ✅ |
| 15 | Case-insensitive lookup still works | ✅ `rma-21052026-0001` matches after the escaping fix |

---

## Bugs found — 2, both security, both fixed in code

### BUG #34 — the tracker published staff email addresses

Two layers, both live:

1. The comments query used `select('*')`, returning every column of every
   non-internal comment — including `user_email`.
2. Worse, and visible on the page: `TicketDrawer` stores the staff member's
   email *as* `author_name` (`authorName: userEmail`), and the tracker renders
   `author_name` above each reply. A customer tracking a repair saw
   `bika.qds@gmail.com` beside every response. 14 public comments in the live
   data carry an address.

The drawer's "Internal (staff only)" toggle defaults to **off**, so an ordinary
staff reply is public by default — this was the normal path, not an edge case.

**Fixed in two places, deliberately.** The edge function now selects named
columns and collapses `author_name` to "Support Team" for team comments; the
drawer stores `nameFromEmail(userEmail)` going forward. Masking at the boundary
matters because a client-side fix alone would protect new comments and leave the
14 existing ones exposed. The customer's own name is untouched — it is theirs,
and the thread is unreadable without it.

### BUG #35 — RMA numbers could be enumerated by pattern

The lookup passed user input straight into `.ilike()`. `ilike` is there for
case-insensitivity, but it also honours `%` and `_`:

```
RMA-21052026%      → MATCHED RMA-21052026-0001 / Maximum Hardware
RMA-21052026-000_  → MATCHED
RMA-2105202_-0001  → MATCHED
```

The RMA number is the only secret protecting this endpoint, so a date prefix
collapsed the guessing space from a full number to a handful of days. Rate
limiting slows that down; it does not stop it.

Fixed by escaping LIKE metacharacters before the query. Verified against
PostgREST with the same query shape: exact numbers still match case-insensitively
(`rma-21052026-0001` → 1 match) and every wildcard form now matches nothing.

---

## Deployment required

Both fixes are in `supabase/functions/public-track/index.ts`, which runs on
Supabase, not in the bundle. **They are inert until deployed:**

```
npx supabase functions deploy public-track
```

I could not run it — the CLI is not authenticated here, and logging in is a
credential step. Until it is deployed, the tracker still returns `user_email`,
still prints staff addresses, and still accepts wildcards.

The `TicketDrawer` half ships with the app and is already live, so new staff
comments store a display name from now on.
