# Pre-launch readiness review

Started 2026-08-18. Audited against the **live database**, not this repo —
because the two are known to disagree.

## Why not read the SQL files

Two things established that the migration history is not a complete description
of the database:

- `custom_roles` exists in production with no `CREATE TABLE` in any migration.
- `ticket_resolutions` has no policy in any migration, yet returns rows to an
  authenticated user and none to an anonymous one — so a policy exists live that
  is not in this repo.

That is also how I nearly got the RLS diagnosis wrong twice earlier: reading the
first definition of something rather than the last, or reading a file that was
never applied. Everything below was measured by asking the database.

---

## Finding 1 — two tables accepted anonymous writes

Probed all 49 app tables with the anon key and no session. **47 refused with
42501.** Two did not:

| Table | Anonymous access found |
|---|---|
| `kb_articles` | **INSERT, UPDATE and DELETE all succeeded** |
| `notification_logs` | INSERT reached a constraint rather than a refusal; DELETE returned 204 against 192 rows |

`kb_articles` is the serious one. `/kb` renders `KnowledgeBasePublic` **before
any auth check**, listing every article with `is_published = true`. An anonymous
visitor could therefore publish arbitrary content onto a public page on the
company's domain, or edit and delete the real articles.

Demonstrated rather than inferred: a `POST` with `{title, slug, body}` created a
row, a `PATCH` on it returned 204, and a `DELETE` returned 204. The probe row was
removed and the table is back to 0 rows.

**Nothing was exposed in the event** — `kb_articles` holds no rows today. The
hole would have opened the moment somebody wrote the first help article.

`notification_logs` is less exposed but not harmless: the notification audit
trail, 192 rows, deletable by anyone with the public anon key.

Fixed in `20260784`: published-only public read on `kb_articles` with admin-only
writes, and staff-read / manager-update on `notification_logs` with no insert or
delete policy at all. The notification worker and webhook write through the
service role, which bypasses RLS, so delivery is unaffected.

### Made repeatable

`scripts/probe-anon-access.mjs` runs the same sweep and exits non-zero if
anything is readable or writable anonymously, so it can gate a release. Writes
are probed with an empty object: no NOT NULL table can accept one, so nothing is
ever created, while the error code still separates an RLS refusal from a
constraint.

## Confirmed sound

- **No table leaks data anonymously.** 25 answer an anonymous read with zero
  rows — RLS filtering correctly — and 24 refuse at the grant level.
- **RLS coverage**: of 53 tables the app touches, 4 are views (which inherit via
  `security_invoker` since 20260778) and every remaining table has policies,
  either named directly or applied through a `DO`-loop array. An earlier count
  of "16 tables with no policy" was a broken grep that could not see the loops.

---

## Still to cover

This is part one, and it only covers the security surface.

- **Empty states.** What the app looks like with 0 deals rather than 56. Every
  page was built and verified against a full fixture set.
- **The first-user path.** A brand-new user with no `user_roles` row: what do
  they see, and can an admin recover them.
- **Backup and restore.** The feature exists in the Control Panel; it has never
  been exercised in this session.
- **Error paths.** What a failed write looks like to a user — several handlers
  log and swallow.
- **Role-by-role write probing.** The anonymous sweep is done; the same probe
  per authenticated role would need a session per role, so it belongs in SQL.
