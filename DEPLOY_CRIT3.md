# CRIT-3 Deployment Checklist — Lock Down Public Tracker

⚠️ **Run AFTER CRIT-2 is deployed.** This depends on RLS being in place to be meaningful.

---

## What changed

- **New Edge Function** `public-track` ([supabase/functions/public-track/index.ts](supabase/functions/public-track/index.ts)) handles all three tracker operations server-side.
- **Rate limit:** 15 requests/minute per IP (in-memory; survives within a single function instance).
- **Input validation:** RMA number max 64 chars, comment max 5000 chars, author name max 120 chars.
- **Whitelisted columns:** Only safe customer-facing fields are returned. The Edge Function never returns `assigned_technician`, `internal_notes`, or any other staff-only fields.
- **`db.rmaTracker` in [supabaseClient.js](src/api/supabaseClient.js)** now invokes the Edge Function instead of direct DB queries. `RMATracker.jsx` needs no changes.

---

## Step 1 — Deploy the Edge Function (2 min)

```powershell
supabase functions deploy public-track --no-verify-jwt
```

The `--no-verify-jwt` flag is **required** because the public tracker has no authenticated user. The function does NOT trust the caller — it uses service_role internally and validates input manually.

Verify in Supabase Dashboard → Edge Functions → `public-track` is **Active**.

---

## Step 2 — Test the public tracker (3 min)

1. Open an **incognito window** (no Supabase session).
2. Go to `https://your-app.com/tracker`
3. Enter a valid RMA number
4. Should show ticket details, status, comments
5. Try posting a comment as a customer → should appear

If the tracker doesn't load:
- Open DevTools → Network → look for the `public-track` function call → check the response
- Check Supabase Dashboard → Edge Functions → `public-track` → Logs

If you see `401 Unauthorized`: you forgot `--no-verify-jwt` on deploy. Redeploy with it.

---

## Step 3 — Verify anon role can't bypass (1 min)

In incognito devtools console (after CRIT-2 RLS is active):

```js
// This should now fail (RLS blocks anon, plus the REVOKE in the migration)
const { data, error } = await window.supabase.from('rma_tickets').select('*').limit(1)
console.log(error) // should be a permission error
```

If this returns data, RLS isn't enforced — go back to CRIT-2 and verify policies.

---

## Step 4 — Test rate limiting (2 min)

In incognito devtools console:

```js
// Hammer the lookup endpoint
for (let i = 0; i < 20; i++) {
  fetch('https://<your-project>.supabase.co/functions/v1/public-track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'lookup', rmaNumber: 'TEST-000' })
  }).then(r => console.log(i, r.status))
}
```

After 15 requests within a minute, you should see `429 Too many requests`.

---

## Step 5 — Storage bucket policies

The migration is in [supabase/migrations/20260527_storage_bucket_policies.sql](supabase/migrations/20260527_storage_bucket_policies.sql).

Apply via CLI:

```powershell
supabase db push
```

Or paste the file contents into Supabase Dashboard → SQL Editor → Run.

What it does:
- **`public_upload_small`** — anon can only upload to `rma-attachments` if the file is under 25 MB and is JPEG / PNG / GIF / WebP / PDF
- **`public_read`** — anon can read from `rma-attachments` (so attachment URLs in the tracker work)
- **`authenticated_full`** — authenticated staff have full access (covers internal uploads)

**Verify after applying:**
1. Open `/tracker` in an incognito window
2. Find a ticket and post a comment with a file attachment
3. The file should upload and the attachment link should load
4. Try uploading a `.exe` or a file over 25 MB — should be blocked with a storage error

---

## After this is done

✅ Mark CRIT-3 complete in [AUDIT_PROGRESS.md](AUDIT_PROGRESS.md)
✅ All P0 critical security findings (CRIT-1, CRIT-2, CRIT-3, CRIT-4) are now fixed
✅ The app is **safe to keep public**.
✅ Move on to P1 (H-1..H-9) at your own pace.
