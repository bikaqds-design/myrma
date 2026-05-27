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
import { ROLES } from './constants.js'

// ── Auth ─────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email:    z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export const forgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address'),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword:     z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string().min(1, 'Please confirm your new password'),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path:    ['confirmPassword'],
})

// ── Customers ─────────────────────────────────────────────────────────────────

export const customerSchema = z.object({
  customer_type:   z.enum(['B2B', 'B2C']),
  customer_status: z.string().min(1, 'Status is required'),
  contact_person:  z.string().min(1, 'Contact person is required').max(200),
  mobile:          z.string().min(1, 'Mobile number is required').max(50),
  company_name:    z.string().max(200).optional().nullable(),
  account_manager: z.string().max(200).optional().nullable(),
  landline:        z.string().max(50).optional().nullable(),
  email:           z.union([z.string().email('Enter a valid email'), z.literal(''), z.null()]).optional(),
  address:         z.string().max(500).optional().nullable(),
  cr_number:       z.string().max(100).optional().nullable(),
  tax_id:          z.string().max(100).optional().nullable(),
  notes:           z.string().max(2000).optional().nullable(),
}).superRefine((data, ctx) => {
  if (data.customer_type === 'B2B' && !data.company_name?.trim()) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      message: 'Company name is required for B2B customers',
      path:    ['company_name'],
    })
  }
})

// ── RMA Tickets ───────────────────────────────────────────────────────────────

export const ticketSchema = z.object({
  customer_name:       z.string().min(1, 'Customer name is required').max(200),
  customer_email:      z.union([z.string().email('Enter a valid email'), z.literal(''), z.null()]).optional(),
  customer_phone:      z.string().max(50).optional().nullable(),
  ticket_status:       z.enum(['Open', 'In Progress', 'Pending', 'On Hold', 'Closed', 'Cancelled']),
  priority:            z.enum(['Critical', 'High', 'Medium', 'Low']),
  assigned_technician: z.string().optional().nullable(),
  description:         z.string().max(5000).optional().nullable(),
  internal_notes:      z.string().max(5000).optional().nullable(),
  due_date:            z.string().optional().nullable(),
})

// ── Products ──────────────────────────────────────────────────────────────────

export const productSchema = z.object({
  brand_id:            z.string().uuid('Select a brand').min(1, 'Brand is required'),
  sku:                 z.string().min(1, 'SKU is required').max(100),
  product_name:        z.string().min(1, 'Product name is required').max(300),
  product_type:        z.enum(['hardware', 'software', 'accessory', 'service']),
  status:              z.enum(['active', 'inactive', 'discontinued']),
  warranty_months:     z.number().int().min(0).max(600).optional(),
  product_description: z.string().max(2000).optional().nullable(),
  product_link:        z.union([z.string().url('Enter a valid URL'), z.literal(''), z.null()]).optional(),
  category_id:         z.string().optional().nullable(),
  subcategory_id:      z.string().optional().nullable(),
})

// ── User management ───────────────────────────────────────────────────────────

export const addUserSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  role:  z.enum([ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.VIEWER]),
})

export const resetPasswordSchema = z.object({
  newPassword:     z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string().min(1, 'Please confirm the password'),
}).refine(d => d.newPassword === d.confirmPassword, {
  message: 'Passwords do not match',
  path:    ['confirmPassword'],
})

// ── Derived types ─────────────────────────────────────────────────────────────

export type LoginFormData          = z.infer<typeof loginSchema>
export type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>
export type ChangePasswordFormData = z.infer<typeof changePasswordSchema>
export type CustomerFormData       = z.infer<typeof customerSchema>
export type TicketFormData         = z.infer<typeof ticketSchema>
export type ProductFormData        = z.infer<typeof productSchema>
export type AddUserFormData        = z.infer<typeof addUserSchema>

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
    Object.entries(safeParseResult.error.flatten().fieldErrors)
      .map(([k, msgs]) => [k, (msgs as string[])?.[0] ?? '']),
  )
}
