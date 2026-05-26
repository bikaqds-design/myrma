# CRIT-2 Deployment Checklist — Row Level Security

⚠️ **THIS WILL LOCK DOWN YOUR DATABASE.** Read every step before running.

🛡️ **Safety net:** The migration is idempotent. If it half-runs, re-running is safe. If something breaks, you can disable RLS on the affected table (see Rollback section at the bottom of the SQL file).

---

## Pre-flight: Before you run anything

1. **Confirm CRIT-1 is deployed.** RLS will block the browser service key from working, so if you still have the old service key in your `.env`, the app will start failing on admin operations. Make sure you've finished [DEPLOY_CRIT1.md](DEPLOY_CRIT1.md) first.

2. **Confirm `user_roles` is populated.** Open Supabase Dashboard → Table Editor → `user_roles`. Make sure:
   - Your super_admin row exists with `role = 'super_admin'`
   - Every other user who logs in has a row
   - **If a user has no row, they will be locked out after RLS turns on** — RLS policies require a role lookup, no role = no access.

3. **Take a backup.** Supabase Dashboard → Database → Backups → Create manual backup. If RLS breaks something, this is your safety net.

---

## Step 1 — Apply the migration (5 min)

```powershell
# From the repo root
supabase db push
```

If you prefer Dashboard:
1. Supabase Dashboard → SQL Editor → New query
2. Paste the contents of [supabase/migrations/20260526_enable_rls.sql](supabase/migrations/20260526_enable_rls.sql)
3. Run

Expected output: no errors. The file uses `IF EXISTS` and `DROP POLICY IF EXISTS` everywhere, so it's safe to re-run.

---

## Step 2 — Verify RLS is on (1 min)

In SQL Editor:

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public' AND tablename IN (
  'rma_tickets','customers','products','user_roles','notifications',
  'invoices','parts','inventory_units','email_settings','webhooks'
)
ORDER BY tablename;
```

Every row should show `rowsecurity = true`.

---

## Step 3 — List active policies (1 min)

```sql
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
```

You should see policies for every table the app touches.

---

## Step 4 — Test as each role 🧪 (15-20 min — DO NOT SKIP)

This is the critical step. Open an incognito window for each test to avoid cached sessions.

### As super_admin
- [ ] Log in
- [ ] Dashboard loads
- [ ] Can view tickets, customers, products, inventory, invoices
- [ ] Can create + edit + delete a test ticket
- [ ] Can open Control Panel
- [ ] Can reset another user's password
- [ ] Can create a new user

### As admin
- [ ] Log in
- [ ] Same as super_admin except: should NOT be able to demote a super_admin (UI may not even show that option — that's fine)

### As manager
- [ ] Log in
- [ ] Can view tickets, customers, products
- [ ] Can create + edit tickets, customers, products
- [ ] CANNOT delete tickets, customers, products (delete is admin+)
- [ ] CANNOT see Control Panel sidebar item
- [ ] CANNOT see User Management

### As technician
- [ ] Log in
- [ ] Can view tickets
- [ ] Can edit ONLY tickets where `assigned_technician = their email`
- [ ] Attempting to edit a ticket assigned to someone else → should fail (toast/error)
- [ ] Can add comments to tickets they have access to
- [ ] CANNOT create new customers or products

### As viewer
- [ ] Log in
- [ ] Can view tickets, customers, products (read-only)
- [ ] Cannot create/edit/delete anything
- [ ] Sidebar shows only relevant items

### Anon (no login)
- [ ] Open incognito → go to `/tracker`
- [ ] Currently still works via direct DB access (CRIT-3 will fix this)
- [ ] DO NOT do CRIT-3 yet — finish CRIT-2 testing first

---

## Step 5 — If a role gets locked out

**Symptom:** "viewer" reports they can't see any tickets, page shows empty.

**Diagnose in SQL Editor:**
```sql
-- As that user, the JWT email might not match user_roles
SELECT * FROM user_roles WHERE user_email = '<their_email>';
```

If no row exists → add one with the appropriate role.

If row exists but they still can't see data, run this as super_admin to confirm policies are applied correctly:
```sql
-- Should return their role string
SELECT auth.user_role();
-- (Won't work in SQL Editor since it doesn't have their JWT — use this from the client side via the app instead)
```

---

## Step 6 — If something is completely broken

The migration includes a commented-out rollback section at the bottom. To disable RLS on a single table:

```sql
ALTER TABLE public.rma_tickets DISABLE ROW LEVEL SECURITY;
```

This restores the previous behavior for that table only. Investigate, fix policy, re-enable.

To disable RLS on ALL tables (nuclear option — undoes the whole migration):
```sql
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
```

---

## After this is done

✅ Mark CRIT-2 complete in [AUDIT_PROGRESS.md](AUDIT_PROGRESS.md)
✅ Next: CRIT-3 (lock down `/tracker` route)

---

## Known limitations of this policy set (intentional, refine later)

- **Technicians can read all tickets, not just assigned.** The app filters by assigned client-side. To enforce server-side, change `staff_read` on `rma_tickets` to:
  ```sql
  USING (
    auth.is_manager_or_above()
    OR (auth.user_role() = 'technician' AND assigned_technician = auth.current_user_email())
    OR (auth.user_role() = 'viewer')
  )
  ```
  Defer this until you're sure no Dashboard widgets break.

- **No per-customer access scoping.** Every staff member can read every customer. Customer portal users (if added later) would need different policies.

- **`time_entries` for managers** — managers can see all entries (intended for payroll review).

- **`announcements`** are visible to all staff regardless of `target_roles` field. Client filters this. If you need server-side filtering, add it later.
