# Upgrade environment (`next` line)

How the SaaS upgrade work is isolated from the current version, and the manual
steps only the account owner can do. Companion to `docs/SAAS_UPGRADE_PLAN.md`.

## The split

| | Current version | Upgrade line |
|---|---|---|
| Branch | `main` (frozen) | `next`, with one branch + PR per backlog item |
| Supabase | `myrma-production` (`ohkynosgscfygtjxbpxq`) — untouched | `mycrm-staging` (`jiuuylvqsuzzxpptjcnm`), eu-west-1, created 2026-09-20 |
| Vercel | project `myrma`, production deployments from `main` | preview deployments of `next` in the same project, with branch-scoped environment variables |
| CI integration tier | — | runs against **staging**, so it may break things and may write |
| `Migration drift` workflow | still reads **production**'s ledger | unchanged |

Staging URL: `https://jiuuylvqsuzzxpptjcnm.supabase.co`
Staging anon key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppdXV5bHZxc3V6enhwcHRqY25tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4ODg2NTYsImV4cCI6MjEwNTQ2NDY1Nn0.171Fk0WyKFLSr1xuAg8U4iR6i4XNxaTOqurOEEw5PNA`
(Anon keys are public by design — they ship in the browser bundle.)

## Owner steps

These need dashboard access, so they cannot be scripted from here.

### 1. Staging database password

Supabase dashboard → **mycrm-staging** → Project Settings → Database →
**Reset database password**. Copy the connection string (URI form) and save it
locally as `.env.staging` (git-ignored):

```
SUPABASE_DB_URL=postgresql://postgres:<password>@db.jiuuylvqsuzzxpptjcnm.supabase.co:5432/postgres
```

Then build the schema:

```bash
node scripts/provision-project.mjs --dry-run
node scripts/provision-project.mjs
```

Expect about 62 tables, 89 functions, 199 policies and 6 views. The script
refuses to touch a database that already has tables unless `--force` is passed,
so it cannot be aimed at production by accident.

### 2. GitHub secrets

Repository → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Value |
|---|---|
| `STAGING_SUPABASE_URL` | `https://jiuuylvqsuzzxpptjcnm.supabase.co` |
| `STAGING_SUPABASE_ANON_KEY` | the staging anon key above |

Leave `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` alone — the `Migration drift`
workflow still needs them pointed at production.

**Order matters:** provision staging (step 1) before these secrets exist, or the
integration tier runs against an empty database and fails for the wrong reason.

### 3. Vercel preview environment for `next`

> **Until this is done, `next` preview deployments read and write the production
> database.** Vercel already built previews for the first two `next` commits
> using the Preview-scope variables, which are the production credentials. Do
> not use those preview URLs yet.

Two ways, same result — `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` with
the staging values, scoped to **Preview** and limited to the `next` branch.
Production values for `main` stay as they are.

**By script** (preferred, it also records what was set):

1. vercel.com → Account Settings → Tokens → create a token scoped to the team.
2. Put it in `.env.staging` (git-ignored) as `VERCEL_TOKEN=…`.
3. `bash scripts/vercel-preview-env.sh`

**By hand:** Vercel → project **myrma** → Settings → Environment Variables → add
each variable, tick **Preview** only, and choose branch `next`.

Vite reads these at build time, so push a commit (or redeploy) afterwards for
them to take effect.

A second Vercel project was considered and rejected: the API reuses the project
already linked to the repository (it answered *"Reused project myrma"*), and
branch-scoped preview variables give the same isolation with nothing extra to
pay for or maintain.

## Rules for this line

- `main` is frozen. Nothing merges into it until the upgrade is ready.
- Every backlog item is its own branch off `next`, with a PR into `next`.
- Migrations are applied to **staging** first, always. Production is touched
  only with the owner's explicit OK, as `CLAUDE.md` already requires.
- Once the line-tables refactor lands, the baseline is regenerated
  (`supabase/manual/GENERATE_baseline_schema.sql`) and the historical migrations
  are archived, so a new tenant project is one file rather than a replay of 206.
