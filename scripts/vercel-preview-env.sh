#!/usr/bin/env bash
# Point `next` preview deployments at the staging Supabase project.
#
# WHY
#
# The Vercel project `myrma` serves production from `main` and a preview from
# every other branch, including `next`. Preview builds inherit the Preview-scope
# environment variables, which are the production Supabase credentials — so an
# upgrade preview would read and write the production database. These are the
# same variable names scoped to Preview AND limited to the `next` branch, which
# Vercel prefers over the unbranched Preview value.
#
# The Vercel MCP server has no environment-variable tool, so this runs the CLI.
#
# PREREQUISITE
#
# A Vercel access token (vercel.com → Account Settings → Tokens; scope it to the
# team, expiry as short as is practical). Put it in .env.staging, which is
# git-ignored:
#
#   VERCEL_TOKEN=...
#
# USAGE
#
#   bash scripts/vercel-preview-env.sh
#
# Re-running fails on variables that already exist; remove them first with
#   npx vercel env rm VITE_SUPABASE_URL preview next --yes --token "$VERCEL_TOKEN"
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env.staging ] && set -a && . ./.env.staging && set +a

: "${VERCEL_TOKEN:?Set VERCEL_TOKEN in .env.staging (see the header of this script)}"

SCOPE="bikaqds-7881s-projects"
PROJECT="myrma"
BRANCH="next"

STAGING_URL="https://jiuuylvqsuzzxpptjcnm.supabase.co"
STAGING_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImppdXV5bHZxc3V6enhwcHRqY25tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4ODg2NTYsImV4cCI6MjEwNTQ2NDY1Nn0.171Fk0WyKFLSr1xuAg8U4iR6i4XNxaTOqurOEEw5PNA"

vc() { npx --yes vercel@latest "$@" --token "$VERCEL_TOKEN" --scope "$SCOPE"; }

echo "Linking the repository to the Vercel project $PROJECT …"
vc link --yes --project "$PROJECT"

echo "Setting Preview ($BRANCH) environment variables …"
printf '%s' "$STAGING_URL"      | vc env add VITE_SUPABASE_URL      preview "$BRANCH"
printf '%s' "$STAGING_ANON_KEY" | vc env add VITE_SUPABASE_ANON_KEY preview "$BRANCH"

echo
echo "Current variables:"
vc env ls preview "$BRANCH"

echo
echo "Done. Redeploy the branch so the new values are baked in (Vite reads them at build time):"
echo "  git commit --allow-empty -m 'chore: rebuild next preview with staging env' && git push"
