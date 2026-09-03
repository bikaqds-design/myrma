# Search and filter audit

Every search box and filter control in the app, checked against the running
application rather than against the source. Audited 2026-09-03.

Thirty-seven files carry a search box. Two real findings, one latent, and three
things that looked wrong in the source and turned out to be correct.

---

## What is actually wrong

### UX-SEARCH-001 — Search and filters are not in the URL (Medium)

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

**Effort: M.** The pattern is one hook applied per list page; the state already
exists in each page's `useState`, it simply is not mirrored to the URL.

### UX-SEARCH-002 — No way to clear a search (Low)

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
| UX-SEARCH-002 | No clear control; `type="text"` not `type="search"` | Low | S |
| UX-SEARCH-003 | Arabic text not normalised for search — latent, no Arabic data yet | Low | S |

Three further candidates were dropped after measurement: debouncing (already
correct), search performance (33 ms), and field coverage (honours its
placeholder).

That brings this audit to **eight findings retracted or dropped after measuring
the running app.** The rule has held every time: read the source to know where to
look, then measure before believing it.
