# Quickstart: Validating CRM Sprint 1 (Foundation)

This sprint has no UI — every check below is a database/API-level verification. Run these in order; each builds on the previous one's confirmed state.

## Prerequisites

- Local or staging Supabase project matching production schema (run `supabase db pull` or equivalent if unsure it's current)
- `npm install` already run, `.env` populated with `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
- A test user account for each of: `admin`, `manager`, and a soon-to-be-created `sales_rep`

## Step 1 — Apply migrations in order

```bash
# Apply all 8 new migrations via the Supabase CLI or dashboard SQL editor, in this exact order:
# 20260618_crm_add_sales_rep_role.sql   <- MUST be first
# 20260619_crm_contacts.sql
# 20260620_crm_pipelines.sql
# 20260621_crm_leads.sql
# 20260622_crm_deals.sql
# 20260623_crm_activities.sql
# 20260624_crm_customers_extend.sql
# 20260625_crm_notification_events.sql
```

**Expected outcome**: All apply with zero errors. Re-running the same migration a second time also produces zero errors (idempotency check — SC-001).

## Step 2 — Verify the sales_rep role works (User Story 1)

```sql
-- In the Supabase SQL editor, as a superuser:
INSERT INTO user_roles (user_email, role) VALUES ('test-rep@qds.test', 'sales_rep');
-- Expected: succeeds (previously would violate chk_user_role)
```

Then, authenticated as that test user (via the app's normal login, or a service-role-impersonated session for testing):

```sql
SELECT * FROM customers LIMIT 1;
-- Expected: returns a row (previously: zero rows, RLS-blocked)

SELECT * FROM rma_tickets LIMIT 1;
-- Expected: zero rows (RLS correctly excludes sales_rep)

UPDATE customers SET notes = 'test' WHERE assigned_rep = auth.uid() LIMIT 1;
-- Expected: succeeds if this rep has an assigned account, no-op otherwise (RLS scoping)
```

**Expected outcome**: All three checks match the comments above — confirms SC-002.

## Step 3 — Verify the CRM API modules (User Story 2)

```js
// In a Vitest test or a scratch Node script with the project's Supabase client:
import { db } from './src/api/supabaseClient.js'

const lead = await db.leads.create({
  full_name: 'Test Lead',
  source: 'website',
  status: 'new',
})
console.assert(lead.id, 'lead was created')

const pipelines = await db.pipelines.list()
console.assert(pipelines.length === 2, 'both seeded pipelines exist')

const deal = await db.deals.create({
  title: 'Test Deal',
  customer_id: '<existing-test-customer-id>',
  pipeline_id: pipelines[0].id,
  stage: pipelines[0].stages[0].id,
})
console.assert(deal.stage === pipelines[0].stages[0].id, 'deal created in first stage')

await db.deals.moveStage(deal.id, 'not-a-real-stage-id')
// Expected: throws — FR-011 validation
```

**Expected outcome**: All assertions pass; the invalid `moveStage()` call throws rather than silently writing. Confirms the bulk of User Story 2's acceptance scenarios.

## Step 4 — Verify atomic conversion (User Story 3)

```js
const lead2 = await db.leads.create({ full_name: 'Convert Me', source: 'phone', status: 'qualified' })
const result = await db.leads.convert(lead2.id, { title: 'Converted Deal', pipelineId: pipelines[0].id })

const updatedLead = await db.leads.get(lead2.id)
console.assert(updatedLead.converted_at !== null, 'lead marked converted')
console.assert(updatedLead.converted_deal_id === result.deal.id, 'lead links to the new deal')
console.assert(updatedLead.converted_customer_id === result.customer.id, 'lead links to the new customer')

// Attempt a further status update on the converted lead:
await db.leads.update(lead2.id, { status: 'contacted' })
// Expected: throws (converted leads are immutable except for notes)
```

**Expected outcome**: Confirms SC-005 and the conversion-specific acceptance scenarios in User Story 3.

## Step 5 — Full regression check (SC-003, SC-004, SC-006)

```bash
npm test          # expect 173+ passing (net-new tests added for schemas/permissions, zero regressions)
npm run lint:ci    # expect zero errors/warnings
npm run build      # expect success
```

Manually smoke-test the 5 existing page folders (`RMATickets`, `Customers`, `Products`, `Inventory`, `UserManagement`) to confirm the `customers` table extension and RLS function changes haven't broken any existing RMA workflow — this is the highest-risk regression surface since `rma_is_staff()` and the `customers` table are both shared, heavily-used infrastructure.

## Done

Sprint 1 is validated when all 5 steps above produce their expected outcomes with no manual workarounds. Proceed to `/speckit-tasks` for the granular implementation task breakdown, then Sprint 2 (Leads UI) per CRM_UPGRADE_STUDY.md §9.3.
