# Phase 1 Contracts: CRM API Domain Modules

This project has no public REST API — its "interface contract" is the TypeScript method signature each `src/api/db/*.ts` module exposes via the `db` barrel (`src/api/supabaseClient.js` → `src/api/db/index.ts`). Sprint 2+ UI pages will call these exact signatures. This document is the contract Sprint 1 implementation must satisfy and Sprint 2+ may rely on without re-checking the implementation.

All modules follow the existing pattern: plain async functions on an exported `const`, Row types as named interfaces, errors thrown (not swallowed) except where the existing `TableResult<T>` optional-table-guard pattern applies (none of these 5 tables are optional/deployment-conditional, so `TableResult<T>` is **not** used here — these are core, always-present CRM tables once Sprint 1 ships, unlike `announcements` or `warehouses`).

## `src/api/db/contacts.ts`

```ts
export interface ContactRow {
  id: string
  customer_id: string
  full_name: string
  title: string | null
  phone: string | null
  email: string | null
  is_primary: boolean
  notes: string | null
  created_at: string
  created_by: string | null
}

export const contacts: {
  list(customerId: string): Promise<ContactRow[]>
  create(contact: Omit<ContactRow, 'id' | 'created_at'>): Promise<ContactRow>
  update(id: string, contact: Partial<ContactRow>): Promise<ContactRow>
  delete(id: string): Promise<void>
}
```

`create()`/`update()` with `is_primary: true` must first clear any existing primary contact for the same `customer_id` (single-primary-per-account invariant — see data-model.md).

## `src/api/db/pipelines.ts`

```ts
export interface PipelineStage {
  id: string
  name: string
  order: number
  probability_default: number
  is_won: boolean
  is_lost: boolean
}

export interface PipelineRow {
  id: string
  name: string
  stages: PipelineStage[]   // JSONB array — never an object, see research.md §3
  is_active: boolean
  created_at: string
}

export const pipelines: {
  list(): Promise<PipelineRow[]>
  get(id: string): Promise<PipelineRow>
  update(id: string, pipeline: Partial<PipelineRow>): Promise<PipelineRow>  // admin-only at the RLS layer
}
```

## `src/api/db/leads.ts`

```ts
export interface LeadRow {
  id: string
  full_name: string
  company_name: string | null
  phone: string | null
  email: string | null
  source: string            // LEAD_SOURCE
  status: string             // LEAD_STATUS
  assigned_rep: string | null
  notes: string | null
  converted_at: string | null
  converted_customer_id: string | null
  converted_deal_id: string | null
  created_at: string
  created_by: string | null
  updated_at: string | null
}

export const leads: {
  list(filters?: { status?: string; assignedRep?: string }): Promise<LeadRow[]>
  get(id: string): Promise<LeadRow>
  create(lead: Omit<LeadRow, 'id' | 'created_at' | 'converted_at' | 'converted_customer_id' | 'converted_deal_id'>): Promise<LeadRow>
  update(id: string, lead: Partial<LeadRow>): Promise<LeadRow>
  /**
   * Atomic conversion — calls a SECURITY DEFINER Postgres function (see research.md §1).
   * If `existingCustomerId` is omitted, a new customers row is created from the lead's
   * full_name/company_name/phone/email. Returns the new/matched customer and the new deal.
   */
  convert(
    leadId: string,
    dealInput: { title: string; pipelineId: string; value?: number },
    existingCustomerId?: string
  ): Promise<{ customer: { id: string }; deal: { id: string } }>
}
```

**Reject rule**: `update()` must throw if called on a lead where `converted_at IS NOT NULL` and the update touches anything other than `notes` (see data-model.md state transitions).

## `src/api/db/deals.ts`

```ts
export interface DealProductLine {
  product_id: string
  product_name: string
  qty: number
  unit_price: number
}

export interface DealRow {
  id: string
  title: string
  customer_id: string
  contact_id: string | null
  pipeline_id: string
  stage: string
  value: number | null
  probability: number
  expected_close_date: string | null
  assigned_rep: string | null
  product_lines: DealProductLine[]   // JSONB array — never an object
  status: 'open' | 'won' | 'lost'
  lost_reason: string | null
  won_at: string | null
  lost_at: string | null
  notes: string | null
  created_at: string
  created_by: string | null
  updated_at: string | null
}

export const deals: {
  list(filters?: { pipelineId?: string; status?: string; assignedRep?: string }): Promise<DealRow[]>
  get(id: string): Promise<DealRow>
  create(deal: Omit<DealRow, 'id' | 'created_at' | 'won_at' | 'lost_at' | 'status'>): Promise<DealRow>
  update(id: string, deal: Partial<DealRow>): Promise<DealRow>
  /** Throws if `stage` is not present in this deal's pipeline's stages array (FR-011). */
  moveStage(id: string, stage: string): Promise<DealRow>
  markWon(id: string): Promise<DealRow>
  /** `reason` is required — see data-model.md validation rules. */
  markLost(id: string, reason: string): Promise<DealRow>
}
```

## `src/api/db/activities.ts`

```ts
export interface ActivityRow {
  id: string
  related_type: 'lead' | 'deal' | 'customer' | 'contact'
  related_id: string
  type: string               // ACTIVITY_TYPE
  title: string
  due_date: string | null
  completed_at: string | null
  assigned_rep: string | null
  outcome_notes: string | null
  created_at: string
  created_by: string | null
}

export const activities: {
  list(relatedType: ActivityRow['related_type'], relatedId: string): Promise<ActivityRow[]>
  create(activity: Omit<ActivityRow, 'id' | 'created_at' | 'completed_at'>): Promise<ActivityRow>
  complete(id: string, outcomeNotes?: string): Promise<ActivityRow>
  /** due_date < now() AND completed_at IS NULL, across all related records the caller can see (RLS-scoped). */
  listOverdue(): Promise<ActivityRow[]>
}
```

## `src/api/db/index.ts` additions

```ts
export { contacts } from './contacts.js'
export { pipelines } from './pipelines.js'
export { leads } from './leads.js'
export { deals } from './deals.js'
export { activities } from './activities.js'

export type { ContactRow } from './contacts.js'
export type { PipelineRow, PipelineStage } from './pipelines.js'
export type { LeadRow } from './leads.js'
export type { DealRow, DealProductLine } from './deals.js'
export type { ActivityRow } from './activities.js'
```

Matches the existing aggregation pattern exactly — no new export style introduced.
