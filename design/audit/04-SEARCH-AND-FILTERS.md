# Search and filter audit

Every search box and filter control in the app, checked against the running
application rather than against the source. Audited 2026-09-03.

Thirty-seven files carry a search box. Two real findings, one latent, and three
things that looked wrong in the source and turned out to be correct.

---

## What is actually wrong

### ✅ UX-SEARCH-001 — Search and filters are not in the URL (Medium) — CLOSED

**Verified by doing it:** typed `computer` into the Customers search, refreshed,
and the search box came back empty with the URL unchanged at
`http://localhost:5173/customers`. **0 of 37 files use `useSearchParams`.**

Consequences, all of them ordinary daily friction:

- A filtered view cannot be sent to a colleague. "Look at the overdue ones" has
  to be described rather than linked.
- A refresh silently discards the filter, which on a page with several active
  filters is real lost work.
- Browser back does not undo a filter, so the only way out is to clear each
  control by hand.
- A bookmark cannot capture a working view.

The brief asks for exactly this: *"filters reflected in the URL so views are
shareable and survive refresh."*

**Fixed on all seven standalone list routes:** Customers, RMA Tickets, Products,
Leads, Activities, Purchasing and Sales Documents. Each verified from a cold
link.

| route | link | result |
|---|---|---|
| Customers | `?q=computer&page=2` | box restored, "Showing 26–50 of 56" |
| RMA Tickets | `?status=Open` | exactly the 5 Open tickets |
| Products | `?q=steel` | "Showing 1–15 of 15" |
| Leads | `?q=a` | "Showing 1–21 of 21" |
| Activities | `?q=call` | "Showing 1–2 of 2" |
| Purchasing | `?q=po` | "Showing 1–5 of 5" (9 unfiltered) |
| Sales Documents | `?q=q` | "Showing 1–25 of 30" |

Deliberately **not** in the URL: `itemsPerPage`, which is a personal preference
already persisted per user, and `jumpToPage`, which is transient input. Leads'
three multi-select filters are still local — they hold `Set`s and need list
encoding.

The tabbed screens — the Inventory tabs, User Management, Knowledge Center —
are not converted. They share one route, so a bare `q=` would carry a search
across tab switches. They need tab-scoped parameter names.

`src/lib/useUrlState.js` is a drop-in replacement for `useState` that keeps the
value in the query string:

```js
const [q, setQ] = useState('')          // becomes
const [q, setQ] = useUrlState('q', '')
```

Verified in the running app: `?q=computer&page=2` on Customers restores the
search box and lands on "Showing 26–50 of 56"; changing the search then resets to
page 1 and drops `page` from the URL. On RMA Tickets, `?status=Open` returns
exactly the 5 Open tickets the database holds, and typing in the search box now
writes `q=` into the URL.

RMA Tickets turned out to already read `status` and `overdue` from
`window.location.search` on mount — a one-way link, so someone could be *sent* to
a filtered view but could not produce one. The param names are unchanged, so the
existing inbound links still work.

**Two bugs were found by testing rather than by review:**

*React Router does not queue functional updates.* `setSearchParams` applies each
call against the last committed location, so two setters in one handler — the
ordinary case, since changing a filter also resets the page — both start from the
same snapshot and the second discards the first. Writes now accumulate in a
module-level pending object and flush once per tick. A test that clicked the two
setters separately passed against the broken version, because React re-renders
between events; only firing both in one handler exposed it.

*A third instance of the same bug, found by the rollout.* Purchasing clears its
search when the tab changes, because a code matching a purchase order matches no
vendor. That effect also fires on mount, so it wiped the search arriving from a
shared link before anyone saw it — `?q=po` opened as an unfiltered list. Guarded
with the same hook. The pattern is worth naming: **any effect that resets state
"when X changes" also fires on mount, and mount is exactly when URL state
arrives.**

*StrictMode defeats a mount flag.* The first attempt at "reset the page only
after mount" used a `useRef` flag. React double-invokes effects in development,
so the first invocation consumed the flag and the second reset the page anyway —
meaning a shared link would have dropped its page number locally but worked in
production. The reset now compares the actual filter values.

**Trade-off, stated plainly:** updates use `replace` rather than `push`, so Back
does not step through filter changes. The alternative leaves one history entry
per keystroke, which is worse. The shareable-link and survives-refresh wins are
unaffected.

### UX-SEARCH-002 — No way to clear a search (Low)

> **Closed 2026-09-17.** List search boxes now use the shared `src/components/SearchInput.jsx`: `type="search"`, a translated clear button shown only while there is text, focus kept in the field after clearing (the native WebKit cancel button is hidden so there is one control, not two). Customer/product pickers, the `/tracker` RMA-number lookup and the WhatsApp log (on hold) are deliberately not converted. `src/test/SearchInput.test.jsx` fails if a page adds a raw `<input>` with a search placeholder.

The Customers search, with `computer` typed in it, offers **no clear control at
all** — measured in the running app, zero buttons matching clear/reset/× were
visible. The field is `type="text"`, so the browser's own clear affordance is
absent too: only **2** of ~32 search inputs use `type="search"`.

Clearing therefore means selecting the text and deleting it. Eight files offer a
"clear filters" control of some kind, so the pattern exists — it just is not
applied to the search box itself.

`type="search"` also gets the search-optimised keyboard on mobile, which matters
for a PWA used on phones in the field.

---

## Latent — will bite, but does not today

### UX-SEARCH-003 — Arabic text is not normalised for search (Low)

Client-side search does `value.toLowerCase().includes(query.toLowerCase())`.
Arabic has no letter case, so `toLowerCase` does nothing for it, and the search
is a raw substring match. That means:

- `احمد` will not find `أحمد` (hamza on the alef)
- `فاطمه` will not find `فاطمة` (teh marbuta)
- `مصطفي` will not find `مصطفى` (alef maqsura)

Those are not typos; they are ordinary spelling variation that Arabic speakers
produce constantly, and the usual fix is to normalise both sides before matching.

**But it does not bite today, and I checked rather than assumed.** There is no
Arabic text anywhere in the business data:

| field | Arabic rows | total |
|---|---:|---:|
| `customers.contact_person` | 0 | 888 |
| `customers.company_name` | 0 | 888 |
| `customers.address` | 0 | 888 |
| `products.product_name` | 0 | 406 |
| `leads.company_name` | 0 | 33 |

Every record is Latin. So this is filed as latent: the day someone types an
Arabic customer name, searching for it will start failing in ways that look
random. Worth fixing before that, not urgently.

---

## What looked wrong in the source and is not

### Debouncing — retracted

I recorded "no debouncing anywhere" from `grep -rl debounce` returning zero
files. That was a false negative from grepping for a word rather than a
behaviour.

**The global search is debounced**, in `CommandPalette.jsx`:

```js
searchTimeout.current = setTimeout(() => search(query), 220)
```

with a `clearTimeout` on every change and a two-character minimum before it
queries at all. A correct implementation that simply does not use the word.

**And the page searches do not need it.** Measured on the Customers page with
888 records loaded, typing `computer` one character at a time:

| keystroke | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| ms | 27 | 36 | 33 | 38 | 34 | 38 | 33 | 33 |

27–38 ms, comfortably below the ~100 ms where typing starts to feel laggy. They
filter already-loaded rows, so there is no network cost per keystroke either.

### Search field coverage — correct

The Customers placeholder promises "name, company, mobile, code". Tested each
against a record read from the database: all four return exactly the right row.
A placeholder that promises fields it does not search would be a real defect;
this one keeps its word.

### An earlier measurement of mine that was wrong

My first latency run reported 4,012 ms, 6,011 ms and 11,981 ms per keystroke.
Those numbers were real but measured the wrong thing: I had grabbed the global
header search rather than the page one, so the timings included the debounced
network round trip, on a page that had not finished loading. The page search,
measured correctly, is 33 ms.

---

## Summary

| ID | Finding | Severity | Effort |
|---|---|---|---|
| UX-SEARCH-001 | Search and filters are not in the URL | Medium | M |
| ✅ UX-SEARCH-002 | ~~No clear control; `type="text"` not `type="search"`~~ **CLOSED** 2026-09-17 | Low | — |
| UX-SEARCH-003 | Arabic text not normalised for search — latent, no Arabic data yet | Low | S |

Three further candidates were dropped after measurement: debouncing (already
correct), search performance (33 ms), and field coverage (honours its
placeholder).

That brings this audit to **eight findings retracted or dropped after measuring
the running app.** The rule has held every time: read the source to know where to
look, then measure before believing it.
