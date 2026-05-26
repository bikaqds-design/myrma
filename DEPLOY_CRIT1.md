# CRIT-1 Deployment Checklist — Service Key Removal

⚠️ **DO THESE STEPS IN ORDER.** Skipping or reordering will break super_admin password reset / new user creation.

---

## Step 1 — Deploy the Edge Function (5 min)

The Edge Function `admin-reset-password` already exists in [supabase/functions/admin-reset-password/index.ts](supabase/functions/admin-reset-password/index.ts) but may not be deployed.

```powershell
# From the repo root
supabase functions deploy admin-reset-password
```

Expected output: `Deployed Function admin-reset-password on project <your-project-ref>`

**Verify deployment** in Supabase Dashboard → Edge Functions → should see `admin-reset-password` with status "Active".

---

## Step 2 — Test the Edge Function BEFORE removing browser service key (5 min)

The browser service key still works at this point. Verify the Edge Function path works before removing the fallback.

1. Open the app, log in as **super_admin**
2. Go to Control Panel → User Management
3. Try resetting another user's password
4. Should succeed and the user should be able to log in with the new password
5. Try creating a new user
6. Should succeed and the new user should be able to log in

If both work → proceed to Step 3.
If either fails → check Supabase Dashboard → Edge Functions → admin-reset-password → Logs for the error. Common issues:
- Missing `SUPABASE_SERVICE_ROLE_KEY` env (auto-injected by Supabase; should always be present)
- Caller is not actually super_admin in `user_roles` table

---

## Step 3 — Rotate the service key (2 min)

🔴 **CRITICAL — do this even if the browser key was never publicly exposed.** It will be in browser caches, build artifacts, and possibly Git history.

1. Supabase Dashboard → Settings → API → Project API keys
2. Click **Reset** next to `service_role`
3. Confirm — this generates a new key

The Edge Function automatically picks up the new key (Supabase injects it as env var). Test once more that admin password reset still works.

---

## Step 4 — Remove the key from `.env` and Vercel (3 min)

### Local `.env`
Open `.env` and **delete this line**:
```
VITE_SUPABASE_SERVICE_KEY=...
```

### Vercel
1. Vercel Dashboard → your project → Settings → Environment Variables
2. Find `VITE_SUPABASE_SERVICE_KEY`
3. Delete it
4. Trigger a redeploy (push a commit or use "Redeploy" button)

---

## Step 5 — Verify the bundle no longer contains the key (1 min)

After Vercel redeploys:

```powershell
# Run a local production build
npm run build

# Grep the bundle for any leftover references
Select-String -Path "dist/**/*.js" -Pattern "VITE_SUPABASE_SERVICE_KEY|service_role"
```

Expected: **zero matches**. If any match appears, stop and investigate.

You can also open production app → DevTools → Sources → search for "service_role" — should find nothing.

---

## Step 6 — Final live test (5 min)

Log in to production as super_admin and verify:
- ✅ Reset another user's password works
- ✅ Create new user works
- ✅ All other operations (browsing tickets, etc.) still work
- ✅ Check browser console — no errors

---

## Rollback plan (if something breaks after Step 4)

If admin operations fail after removing the key:

1. **Don't panic.** No data is lost.
2. Add the (already-rotated) new service key back to Vercel temporarily as `VITE_SUPABASE_SERVICE_KEY`.
3. Investigate why the Edge Function isn't reachable (check Edge Function logs, network tab).
4. Once fixed, redo Step 4.

The client code in [supabaseClient.js](src/api/supabaseClient.js) no longer reads `VITE_SUPABASE_SERVICE_KEY`, so adding it back won't restore old behavior — you'd also need to revert the commit. That's an intentional safety design.

---

## After this is done

✅ Mark CRIT-1 complete in [AUDIT_PROGRESS.md](AUDIT_PROGRESS.md)
✅ Next: CRIT-2 (Row Level Security rollout)
