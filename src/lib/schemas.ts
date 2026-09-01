/**
 * schemas.ts — Zod validation schemas for all user-facing forms.
 *
 * Import the schema and use with react-hook-form:
 *   import { loginSchema } from '../lib/schemas'
 *   const { register, handleSubmit, formState } = useForm({
 *     resolver: zodResolver(loginSchema)
 *   })
 *
 * Or validate manually before a submit handler:
 *   const result = customerSchema.safeParse(formData)
 *   if (!result.success) {
 *     toast.error(getFirstError(result))
 *     return
 *   }
 */
import { z } from 'zod'
import {
  ROLES,
  ROLE_LIST,
  TICKET_STATUS_LIST,
  PRIORITY_LIST,
  LEAD_STATUS_LIST,
  LEAD_SOURCE_LIST,
  DEAL_STATUS_LIST,
  ACTIVITY_TYPE_LIST,
  QUOTATION_STATUS_LIST,
  SALES_ORDER_STATUS_LIST,
  INVOICE_DOC_STATUS_LIST,
  INVOICE_PAYMENT_STATUS_LIST,
  CREDIT_NOTE_STATUS_LIST,
  CREDIT_NOTE_TYPE_LIST,
  type Role,
  type TicketStatus,
  type Priority,
  type LeadStatus,
  type LeadSource,
  type DealStatus,
  type ActivityType,
  type QuotationStatus,
  type SalesOrderStatus,
  type InvoiceDocStatus,
  type InvoicePaymentStatus,
  type CreditNoteStatus,
  type CreditNoteType,
} from './constants.js'

// ── Auth ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export const forgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address'),
})

// Shared password strength rule. Both password flows must enforce the same policy,
// so they reference this rather than restating it — keep it that way.
const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine(
    (p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p),
    'Password must include uppercase, lowercase, and a number'
  )

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: strongPassword,
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  // GoTrue rejects this server-side with a `same_password` error regardless of the
  // require-current-password setting; catching it here is faster and clearer.
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'New password must be different from your current password',
    path: ['newPassword'],
  })

// ── Customers ─────────────────────────────────────────────────────────────────

export const customerSchema = z
  .object({
    customer_type: z.enum(['B2B', 'B2C']),
    customer_status: z.string().min(1, 'Status is required'),
    contact_person: z.string().min(1, 'Contact person is required').max(200),
    mobile: z.string().min(1, 'Mobile number is required').max(50),
    company_name: z.string().max(200).optional().nullable(),
    account_manager: z.string().max(200).optional().nullable(),
    landline: z.string().max(50).optional().nullable(),
    email: z.union([z.string().email('Enter a valid email'), z.literal(''), z.null()]).optional(),
    address: z.string().max(500).optional().nullable(),
    cr_number: z.string().max(100).optional().nullable(),
    tax_id: z.string().max(100).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.customer_type === 'B2B' && !data.company_name?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Company name is required for B2B customers',
        path: ['company_name'],
      })
    }
  })

// ── RMA Tickets ───────────────────────────────────────────────────────────────

const ticketProductSchema = z.object({
  product_name: z.string().max(300).optional().nullable(),
  serial_number: z.string().max(100).optional().nullable(),
  product_status: z.string().max(100).optional().nullable(),
  warranty_status: z.string().max(100).optional().nullable(),
  issue_description: z.string().max(2000).optional().nullable(),
})

export const ticketSchema = z.object({
  customer_name: z.string().min(1, 'Customer name is required').max(200),
  customer_email: z
    .union([z.string().email('Enter a valid email'), z.literal(''), z.null()])
    .optional(),
  customer_phone: z.string().max(50).optional().nullable(),
  ticket_status: z.enum(TICKET_STATUS_LIST as [TicketStatus, ...TicketStatus[]]),
  priority: z.enum(PRIORITY_LIST as [Priority, ...Priority[]]),
  assigned_technician: z.string().optional().nullable(),
  general_description: z.string().max(5000).optional().nullable(),
  internal_notes: z.string().max(5000).optional().nullable(),
  accessories_received: z.string().max(2000).optional().nullable(),
  due_date: z.string().optional().nullable(),
  carrier: z.string().max(100).optional().nullable(),
  tracking_number: z.string().max(100).optional().nullable(),
  shipping_label_url: z
    .union([z.string().url('Enter a valid URL'), z.literal(''), z.null()])
    .optional(),
  products: z.array(ticketProductSchema).optional(),
  attachments: z.array(z.any()).optional(),
})

// ── Products ──────────────────────────────────────────────────────────────────

export const productSchema = z.object({
  brand_id: z.string().uuid('Select a brand').min(1, 'Brand is required'),
  sku: z.string().min(1, 'SKU is required').max(100),
  product_name: z.string().min(1, 'Product name is required').max(300),
  product_type: z.enum(['hardware', 'software', 'accessory', 'service']),
  status: z.enum(['active', 'inactive', 'discontinued']),
  warranty_months: z.number().int().min(0).max(600).optional(),
  product_description: z.string().max(2000).optional().nullable(),
  product_link: z.union([z.string().url('Enter a valid URL'), z.literal(''), z.null()]).optional(),
  category_id: z.string().optional().nullable(),
  subcategory_id: z.string().optional().nullable(),
})

// ── User management ───────────────────────────────────────────────────────────

export const addUserSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role: z.enum(ROLE_LIST as [Role, ...Role[]]),
})

// Used by the password-recovery page only. Deliberately has no `currentPassword`
// field: that flow runs on a Supabase recovery session, which GoTrue exempts from
// the require-current-password setting, and the user has no way to know their old
// password there. See changePasswordSchema for the signed-in change-password flow.
export const resetPasswordSchema = z
  .object({
    newPassword: strongPassword,
    confirmPassword: z.string().min(1, 'Please confirm the password'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

// ── Parts inventory ───────────────────────────────────────────────────────────

export const partSchema = z.object({
  part_name: z.string().min(1, 'Part name is required').max(300),
  part_number: z.string().max(100).optional().nullable(),
  quantity: z.number().int().min(0, 'Quantity must be 0 or more'),
  unit_cost: z.number().min(0).optional().nullable(),
  supplier: z.string().max(200).optional().nullable(),
  reorder_level: z.number().int().min(0).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

// ── Invoices ──────────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
  description: z.string().min(1, 'Description is required').max(500),
  quantity: z.number().int().min(1),
  unit_price: z.number().min(0),
})

export const invoiceSchema = z.object({
  type: z.enum(['invoice', 'quote']),
  invoice_number: z.string().min(1, 'Invoice number is required').max(100),
  customer_name: z.string().min(1, 'Customer name is required').max(200),
  customer_email: z
    .union([z.string().email('Enter a valid email'), z.literal(''), z.null()])
    .optional(),
  rma_number_ref: z.string().max(100).optional().nullable(),
  ticket_id: z.string().optional().nullable(),
  lineItems: z.array(lineItemSchema).min(1, 'At least one line item is required'),
  labour_hours: z.number().min(0).optional().nullable(),
  labour_rate: z.number().min(0).optional().nullable(),
  tax_pct: z.number().min(0).max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  due_date: z.string().optional().nullable(),
  status: z.enum(['draft', 'sent', 'paid', 'pending', 'overdue']),
})

// ── Inventory units (manual create/update) ────────────────────────────────────

export const inventoryUnitSchema = z.object({
  product_name: z.string().min(1, 'Product name is required').max(300),
  serial_number: z.string().max(100).optional().nullable(),
  warranty_status: z.string().max(100).optional().nullable(),
  status: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  warehouse_id: z.string().uuid().optional().nullable(),
})

// ── Warehouses ────────────────────────────────────────────────────────────────

export const warehouseSchema = z.object({
  name: z.string().min(1, 'Warehouse name is required').max(200),
  code: z.string().max(50).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  is_active: z.boolean().optional(),
})

// ── Manufacturer batches ──────────────────────────────────────────────────────

export const batchUpdateSchema = z.object({
  sent_date: z.string().optional().nullable(),
  tracking_number: z.string().max(100).optional().nullable(),
  resolution_type: z.string().max(100).optional().nullable(),
  resolution_date: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

// ── CRM: contacts ─────────────────────────────────────────────────────────────

export const contactSchema = z.object({
  customer_id: z.string().uuid('Select a customer'),
  full_name: z.string().min(1, 'Full name is required').max(200),
  title: z.string().max(200).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  email: z.union([z.string().email('Enter a valid email'), z.literal(''), z.null()]).optional(),
  is_primary: z.boolean().optional(),
  notes: z.string().max(2000).optional().nullable(),
})

// ── CRM: leads ────────────────────────────────────────────────────────────────

// company_name and phone are intentionally optional here — the UI shows
// soft warnings but the schema must not hard-reject missing values
// (a lead can be captured with just a name, per Sprint 2 design decision).
export const leadSchema = z.object({
  full_name: z.string().min(1, 'Full name is required').max(200),
  company_name: z.string().max(200).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  email: z.union([z.string().email('Enter a valid email'), z.literal(''), z.null()]).optional(),
  source: z.enum(LEAD_SOURCE_LIST as [LeadSource, ...LeadSource[]]),
  status: z.enum(LEAD_STATUS_LIST as [LeadStatus, ...LeadStatus[]]).optional(),
  assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

// ── CRM: deals ────────────────────────────────────────────────────────────────
// stage membership (does this stage id actually exist in the deal's
// pipeline.stages array?) can't be checked here — it requires a DB lookup of
// the referenced pipeline. That check lives in deals.create()/moveStage() at
// the API layer (FR-011, see research.md §4). This schema only validates
// stage is a non-empty string.

const dealProductLineSchema = z.object({
  product_id: z.string().uuid(),
  product_name: z.string().min(1).max(300),
  qty: z.number().int().min(1),
  unit_price: z.number().min(0),
})

export const dealSchema = z
  .object({
    title: z.string().min(1, 'Title is required').max(300),
    customer_id: z.string().uuid('Select a customer'),
    contact_id: z.string().uuid().optional().nullable(),
    pipeline_id: z.string().uuid('Select a pipeline'),
    stage: z.string().min(1, 'Stage is required'),
    value: z.number().min(0).optional().nullable(),
    probability: z.number().int().min(0).max(100).optional(),
    expected_close_date: z.string().optional().nullable(),
    assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
    product_lines: z.array(dealProductLineSchema).optional(),
    status: z.enum(DEAL_STATUS_LIST as [DealStatus, ...DealStatus[]]).optional(),
    lost_reason: z.string().max(500).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.status === 'lost' && !data.lost_reason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A reason is required when marking a deal as lost',
        path: ['lost_reason'],
      })
    }
  })

// ── Sales Documents: shared line schemas ─────────────────────────────────────

// Quotation lines allow free-form products (product_id nullable).
// product_name is always required — for free-form lines it IS the product.
export const quotationLineSchema = z.object({
  product_id: z.string().uuid().optional().nullable(),
  product_name: z.string().min(1, 'Product name is required').max(300),
  description: z.string().max(500).optional().nullable(),
  qty: z.number().int().min(1, 'Quantity must be at least 1'),
  unit_price: z.number().min(0, 'Price must be 0 or more'),
  discount_pct: z.number().min(0).max(100).optional().nullable(),
  tax_pct: z.number().min(0).max(100).optional().nullable(),
})

// Sales Order and Invoice lines require a real DB product.
// Validated at the convert step — any free-form quotation line must be
// promoted to a real product before an SO can be created.
export const salesOrderLineSchema = z.object({
  product_id: z.string().uuid('Product must be selected from the catalog'),
  product_name: z.string().min(1).max(300),
  description: z.string().max(500).optional().nullable(),
  qty: z.number().int().min(1, 'Quantity must be at least 1'),
  unit_price: z.number().min(0, 'Price must be 0 or more'),
  discount_pct: z.number().min(0).max(100).optional().nullable(),
  tax_pct: z.number().min(0).max(100).optional().nullable(),
})

export const invoiceLineSchema = salesOrderLineSchema

// Credit note lines allow partial quantity credits; restock flag is per-line.
export const creditNoteLineSchema = z.object({
  product_id: z.string().uuid().optional().nullable(),
  product_name: z.string().min(1, 'Product name is required').max(300),
  qty: z.number().int().min(1, 'Quantity must be at least 1'),
  unit_price: z.number().min(0),
  restock: z.boolean().default(false),
  warehouse_id: z.string().uuid().optional().nullable(),
})

// ── Sales Documents: quotation ────────────────────────────────────────────────

export const quotationSchema = z.object({
  customer_id: z.string().uuid('Select a customer'),
  deal_id: z.string().uuid().optional().nullable(),
  assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  reference_po: z.string().max(100).optional().nullable(),
  validity_until: z.string().optional().nullable(),
  payment_terms: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  status: z
    .enum(QUOTATION_STATUS_LIST as [QuotationStatus, ...QuotationStatus[]])
    .optional(),
  line_items: z.array(quotationLineSchema).min(1, 'At least one line item is required'),
})

// ── Sales Documents: sales order ─────────────────────────────────────────────

export const salesOrderSchema = z.object({
  customer_id: z.string().uuid('Select a customer'),
  quotation_id: z.string().uuid().optional().nullable(),
  assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  reference_po: z.string().max(100).optional().nullable(),
  delivery_date: z.string().optional().nullable(),
  payment_terms: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  status: z
    .enum(SALES_ORDER_STATUS_LIST as [SalesOrderStatus, ...SalesOrderStatus[]])
    .optional(),
  line_items: z.array(salesOrderLineSchema).min(1, 'At least one line item is required'),
})

// ── Sales Documents: CRM invoice ─────────────────────────────────────────────
// Uses two separate status fields (doc_status + payment_status) — never collapse
// these into one field. payment_status is derived from recorded payments vs total
// and should not be set directly by UI forms; it's included here for completeness.

export const crmInvoiceSchema = z.object({
  customer_id: z.string().uuid('Select a customer'),
  so_id: z.string().uuid().optional().nullable(),
  assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  reference_po: z.string().max(100).optional().nullable(),
  due_date: z.string().optional().nullable(),
  payment_terms: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  doc_status: z
    .enum(INVOICE_DOC_STATUS_LIST as [InvoiceDocStatus, ...InvoiceDocStatus[]])
    .optional(),
  payment_status: z
    .enum(INVOICE_PAYMENT_STATUS_LIST as [InvoicePaymentStatus, ...InvoicePaymentStatus[]])
    .optional(),
  line_items: z.array(invoiceLineSchema).min(1, 'At least one line item is required'),
})

// ── Sales Documents: credit note ─────────────────────────────────────────────

export const creditNoteSchema = z.object({
  customer_id: z.string().uuid('Select a customer'),
  type: z.enum(CREDIT_NOTE_TYPE_LIST as [CreditNoteType, ...CreditNoteType[]]),
  source_invoice_id: z.string().uuid().optional().nullable(),
  ticket_id: z.string().uuid().optional().nullable(),
  assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  reason: z.string().min(1, 'Reason is required').max(500),
  notes: z.string().max(2000).optional().nullable(),
  status: z
    .enum(CREDIT_NOTE_STATUS_LIST as [CreditNoteStatus, ...CreditNoteStatus[]])
    .optional(),
  line_items: z.array(creditNoteLineSchema).min(1, 'At least one line item is required'),
})

// ── CRM: activities ───────────────────────────────────────────────────────────

export const activitySchema = z.object({
  related_type: z.enum(['lead', 'deal', 'customer', 'contact']),
  related_id: z.string().uuid('Select a record'),
  type: z.enum(ACTIVITY_TYPE_LIST as [ActivityType, ...ActivityType[]]),
  title: z.string().min(1, 'Title is required').max(300),
  due_date: z.string().optional().nullable(),
  assigned_rep: z.union([z.string().email(), z.literal('')]).optional().nullable(),
  outcome_notes: z.string().max(2000).optional().nullable(),
})

// ── Derived types ─────────────────────────────────────────────────────────────

export type LoginFormData = z.infer<typeof loginSchema>
export type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>
export type ChangePasswordFormData = z.infer<typeof changePasswordSchema>
export type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>
export type CustomerFormData = z.infer<typeof customerSchema>
export type TicketFormData = z.infer<typeof ticketSchema>
export type ProductFormData = z.infer<typeof productSchema>
export type AddUserFormData = z.infer<typeof addUserSchema>
export type PartFormData = z.infer<typeof partSchema>
export type InvoiceFormData = z.infer<typeof invoiceSchema>
export type InventoryUnitFormData = z.infer<typeof inventoryUnitSchema>
export type WarehouseFormData = z.infer<typeof warehouseSchema>
export type ContactFormData = z.infer<typeof contactSchema>
export type LeadFormData = z.infer<typeof leadSchema>
export type DealFormData = z.infer<typeof dealSchema>
export type ActivityFormData = z.infer<typeof activitySchema>
export type QuotationFormData = z.infer<typeof quotationSchema>
export type SalesOrderFormData = z.infer<typeof salesOrderSchema>
export type CrmInvoiceFormData = z.infer<typeof crmInvoiceSchema>
export type CreditNoteFormData = z.infer<typeof creditNoteSchema>
export type QuotationLineData = z.infer<typeof quotationLineSchema>
export type SalesOrderLineData = z.infer<typeof salesOrderLineSchema>
export type CreditNoteLineData = z.infer<typeof creditNoteLineSchema>

// ── Shared helpers ────────────────────────────────────────────────────────────

type SafeParseResult = z.SafeParseReturnType<unknown, unknown>

/**
 * getFirstError(result) — extract the first error message from a
 * zod SafeParseReturnType for use in toast.error() calls.
 */
export function getFirstError(safeParseResult: SafeParseResult): string | null {
  if (safeParseResult.success) return null
  const flat = safeParseResult.error.flatten()
  const fieldMsgs = Object.values(flat.fieldErrors).flat() as string[]
  if (fieldMsgs.length) return fieldMsgs[0]
  if (flat.formErrors.length) return flat.formErrors[0]
  return 'Validation failed'
}

/**
 * getFieldErrors(result) — return a flat { fieldName: firstMessage } map
 * for wiring into per-field error display.
 */
export function getFieldErrors(safeParseResult: SafeParseResult): Record<string, string> {
  if (safeParseResult.success) return {}
  return Object.fromEntries(
    Object.entries(safeParseResult.error.flatten().fieldErrors).map(([k, msgs]) => [
      k,
      (msgs as string[])?.[0] ?? '',
    ])
  )
}
