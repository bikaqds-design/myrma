/**
 * schemas.test.js — Unit tests for src/lib/schemas.ts
 *
 * Covers: loginSchema, forgotPasswordSchema, customerSchema,
 *         ticketSchema, getFirstError, getFieldErrors
 */
import { describe, it, expect, test } from 'vitest'
import {
  loginSchema,
  forgotPasswordSchema,
  changePasswordSchema,
  customerSchema,
  ticketSchema,
  productSchema,
  addUserSchema,
  contactSchema,
  leadSchema,
  dealSchema,
  activitySchema,
  getFirstError,
  getFieldErrors,
} from '../lib/schemas'

const UUID_A = '00000000-0000-0000-0000-000000000001'
const UUID_B = '00000000-0000-0000-0000-000000000002'

// ── loginSchema ──────────────────────────────────────────────────────────────

describe('loginSchema', () => {
  it('accepts valid credentials', () => {
    const result = loginSchema.safeParse({ email: 'admin@example.com', password: 'secret' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'secret' })
    expect(result.success).toBe(false)
    const errs = getFieldErrors(result)
    expect(errs.email).toMatch(/valid email/i)
  })

  it('rejects empty password', () => {
    const result = loginSchema.safeParse({ email: 'a@b.com', password: '' })
    expect(result.success).toBe(false)
    const errs = getFieldErrors(result)
    expect(errs.password).toMatch(/required/i)
  })

  it('rejects missing fields', () => {
    const result = loginSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ── forgotPasswordSchema ─────────────────────────────────────────────────────

describe('forgotPasswordSchema', () => {
  it('accepts valid email', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'user@test.com' }).success).toBe(true)
  })

  it('rejects non-email string', () => {
    const result = forgotPasswordSchema.safeParse({ email: 'nope' })
    expect(result.success).toBe(false)
  })
})

// ── changePasswordSchema ─────────────────────────────────────────────────────

describe('changePasswordSchema', () => {
  it('accepts matching passwords with min length', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old-pass',
      newPassword: 'newpass1',
      confirmPassword: 'newpass1',
    })
    expect(result.success).toBe(true)
  })

  it('rejects mismatched passwords', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old-pass',
      newPassword: 'newpass1',
      confirmPassword: 'different',
    })
    expect(result.success).toBe(false)
    const errs = getFieldErrors(result)
    expect(errs.confirmPassword).toMatch(/do not match/i)
  })

  it('rejects short new password', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'old',
      newPassword: 'short',
      confirmPassword: 'short',
    })
    expect(result.success).toBe(false)
  })
})

// ── customerSchema ───────────────────────────────────────────────────────────

describe('customerSchema', () => {
  const validB2C = {
    customer_type: 'B2C',
    customer_status: 'active',
    contact_person: 'Alice Smith',
    mobile: '+1234567890',
  }

  const validB2B = {
    ...validB2C,
    customer_type: 'B2B',
    company_name: 'Acme Corp',
  }

  it('accepts a valid B2C customer', () => {
    expect(customerSchema.safeParse(validB2C).success).toBe(true)
  })

  it('accepts a valid B2B customer with company_name', () => {
    expect(customerSchema.safeParse(validB2B).success).toBe(true)
  })

  it('rejects B2B customer with no company_name', () => {
    const result = customerSchema.safeParse({ ...validB2C, customer_type: 'B2B', company_name: '' })
    expect(result.success).toBe(false)
    const msg = getFirstError(result)
    expect(msg).toMatch(/company name.*required/i)
  })

  it('rejects missing contact_person', () => {
    const result = customerSchema.safeParse({ ...validB2C, contact_person: '' })
    expect(result.success).toBe(false)
    const errs = getFieldErrors(result)
    expect(errs.contact_person).toMatch(/required/i)
  })

  it('rejects missing mobile', () => {
    const result = customerSchema.safeParse({ ...validB2C, mobile: '' })
    expect(result.success).toBe(false)
    const errs = getFieldErrors(result)
    expect(errs.mobile).toMatch(/required/i)
  })

  it('rejects invalid email format when provided', () => {
    const result = customerSchema.safeParse({ ...validB2C, email: 'not-an-email' })
    expect(result.success).toBe(false)
  })

  it('accepts empty-string email (optional)', () => {
    expect(customerSchema.safeParse({ ...validB2C, email: '' }).success).toBe(true)
  })

  it('accepts null email (optional)', () => {
    expect(customerSchema.safeParse({ ...validB2C, email: null }).success).toBe(true)
  })
})

// ── ticketSchema ──────────────────────────────────────────────────────────────

describe('ticketSchema', () => {
  const valid = {
    customer_name: 'Bob Jones',
    ticket_status: 'Open',
    priority: 'High',
  }

  it('accepts valid ticket fields', () => {
    expect(ticketSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects empty customer_name', () => {
    const result = ticketSchema.safeParse({ ...valid, customer_name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid ticket_status', () => {
    const result = ticketSchema.safeParse({ ...valid, ticket_status: 'Resolved' })
    expect(result.success).toBe(false)
  })

  it('rejects invalid priority', () => {
    const result = ticketSchema.safeParse({ ...valid, priority: 'Urgent' })
    expect(result.success).toBe(false)
  })

  test.each(['Open', 'In Progress', 'Pending', 'On Hold', 'Completed', 'Closed', 'Cancelled'])(
    'accepts ticket_status "%s"',
    (s) => {
      expect(ticketSchema.safeParse({ ...valid, ticket_status: s }).success).toBe(true)
    }
  )

  test.each(['Critical', 'High', 'Medium', 'Low'])(
    'accepts priority "%s"',
    (p) => {
      expect(ticketSchema.safeParse({ ...valid, priority: p }).success).toBe(true)
    }
  )
})

// ── productSchema ──────────────────────────────────────────────────────────────

describe('productSchema', () => {
  const valid = {
    brand_id: '00000000-0000-0000-0000-000000000001',
    sku: 'PRD-001',
    product_name: 'Widget',
    product_type: 'hardware',
    status: 'active',
  }

  it('accepts a valid product', () => {
    expect(productSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects missing sku', () => {
    expect(productSchema.safeParse({ ...valid, sku: '' }).success).toBe(false)
  })

  it('rejects invalid product_type', () => {
    expect(productSchema.safeParse({ ...valid, product_type: 'furniture' }).success).toBe(false)
  })

  it('rejects invalid status', () => {
    expect(productSchema.safeParse({ ...valid, status: 'retired' }).success).toBe(false)
  })

  it('rejects invalid product_link URL', () => {
    expect(productSchema.safeParse({ ...valid, product_link: 'not-a-url' }).success).toBe(false)
  })

  it('accepts empty string product_link', () => {
    expect(productSchema.safeParse({ ...valid, product_link: '' }).success).toBe(true)
  })
})

// ── addUserSchema ─────────────────────────────────────────────────────────────

describe('addUserSchema', () => {
  it('accepts valid user', () => {
    expect(addUserSchema.safeParse({ email: 'user@co.com', role: 'manager' }).success).toBe(true)
  })

  it('rejects invalid role', () => {
    expect(addUserSchema.safeParse({ email: 'user@co.com', role: 'guest' }).success).toBe(false)
  })

  test.each(['super_admin', 'admin', 'manager', 'technician', 'viewer'])(
    'accepts role "%s"',
    (role) => {
      expect(addUserSchema.safeParse({ email: 'x@x.com', role }).success).toBe(true)
    }
  )
})

// ── contactSchema ────────────────────────────────────────────────────────────

describe('contactSchema', () => {
  const valid = { customer_id: UUID_A, full_name: 'Jane Doe' }

  it('accepts a valid contact', () => {
    expect(contactSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects missing full_name', () => {
    expect(contactSchema.safeParse({ ...valid, full_name: '' }).success).toBe(false)
  })

  it('rejects non-uuid customer_id', () => {
    expect(contactSchema.safeParse({ ...valid, customer_id: 'not-a-uuid' }).success).toBe(false)
  })

  it('rejects invalid email format when provided', () => {
    expect(contactSchema.safeParse({ ...valid, email: 'nope' }).success).toBe(false)
  })

  it('accepts empty-string email (optional)', () => {
    expect(contactSchema.safeParse({ ...valid, email: '' }).success).toBe(true)
  })
})

// ── leadSchema ───────────────────────────────────────────────────────────────

describe('leadSchema', () => {
  const valid = { full_name: 'Convert Me', source: 'phone' }

  it('accepts a valid lead', () => {
    expect(leadSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects missing full_name', () => {
    expect(leadSchema.safeParse({ ...valid, full_name: '' }).success).toBe(false)
  })

  it('rejects invalid source', () => {
    expect(leadSchema.safeParse({ ...valid, source: 'carrier-pigeon' }).success).toBe(false)
  })

  it('rejects invalid status', () => {
    expect(leadSchema.safeParse({ ...valid, status: 'ghosted' }).success).toBe(false)
  })

  it('accepts a lead with neither phone nor email (soft validation only)', () => {
    expect(leadSchema.safeParse(valid).success).toBe(true)
  })

  test.each(['walk-in', 'phone', 'referral', 'exhibition', 'website', 'whatsapp'])(
    'accepts source "%s"',
    (source) => {
      expect(leadSchema.safeParse({ ...valid, source }).success).toBe(true)
    }
  )

  test.each(['new', 'contacted', 'qualified', 'converted', 'disqualified'])(
    'accepts status "%s"',
    (status) => {
      expect(leadSchema.safeParse({ ...valid, status }).success).toBe(true)
    }
  )
})

// ── dealSchema ───────────────────────────────────────────────────────────────

describe('dealSchema', () => {
  const valid = {
    title: 'New Deal',
    customer_id: UUID_A,
    pipeline_id: UUID_B,
    stage: 'new_lead',
  }

  it('accepts a valid open deal', () => {
    expect(dealSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects missing title', () => {
    expect(dealSchema.safeParse({ ...valid, title: '' }).success).toBe(false)
  })

  it('rejects missing stage', () => {
    expect(dealSchema.safeParse({ ...valid, stage: '' }).success).toBe(false)
  })

  it('rejects non-uuid pipeline_id', () => {
    expect(dealSchema.safeParse({ ...valid, pipeline_id: 'nope' }).success).toBe(false)
  })

  it('rejects status "lost" with no lost_reason', () => {
    const result = dealSchema.safeParse({ ...valid, status: 'lost' })
    expect(result.success).toBe(false)
    const msg = getFirstError(result)
    expect(msg).toMatch(/reason.*required/i)
  })

  it('accepts status "lost" with a lost_reason', () => {
    expect(
      dealSchema.safeParse({ ...valid, status: 'lost', lost_reason: 'Went with a competitor' })
        .success
    ).toBe(true)
  })

  it('accepts status "won" with no lost_reason', () => {
    expect(dealSchema.safeParse({ ...valid, status: 'won' }).success).toBe(true)
  })

  it('rejects probability out of 0-100 range', () => {
    expect(dealSchema.safeParse({ ...valid, probability: 150 }).success).toBe(false)
  })
})

// ── activitySchema ───────────────────────────────────────────────────────────

describe('activitySchema', () => {
  const valid = {
    related_type: 'deal',
    related_id: UUID_A,
    type: 'call',
    title: 'Follow-up call',
  }

  it('accepts a valid activity', () => {
    expect(activitySchema.safeParse(valid).success).toBe(true)
  })

  it('rejects missing title', () => {
    expect(activitySchema.safeParse({ ...valid, title: '' }).success).toBe(false)
  })

  it('rejects invalid related_type', () => {
    expect(activitySchema.safeParse({ ...valid, related_type: 'ticket' }).success).toBe(false)
  })

  it('rejects invalid type', () => {
    expect(activitySchema.safeParse({ ...valid, type: 'carrier-pigeon' }).success).toBe(false)
  })

  test.each(['lead', 'deal', 'customer', 'contact'])(
    'accepts related_type "%s"',
    (related_type) => {
      expect(activitySchema.safeParse({ ...valid, related_type }).success).toBe(true)
    }
  )

  test.each(['call', 'meeting', 'whatsapp', 'email', 'note', 'task'])(
    'accepts type "%s"',
    (type) => {
      expect(activitySchema.safeParse({ ...valid, type }).success).toBe(true)
    }
  )
})

// ── helpers ───────────────────────────────────────────────────────────────────

describe('getFirstError', () => {
  it('returns null on success', () => {
    const result = loginSchema.safeParse({ email: 'a@b.com', password: 'pass' })
    expect(getFirstError(result)).toBe(null)
  })

  it('returns a string error message on failure', () => {
    const result = loginSchema.safeParse({ email: 'bad', password: '' })
    const msg = getFirstError(result)
    expect(typeof msg).toBe('string')
    expect(msg.length).toBeGreaterThan(0)
  })
})

describe('getFieldErrors', () => {
  it('returns empty object on success', () => {
    const result = loginSchema.safeParse({ email: 'a@b.com', password: 'pass' })
    expect(getFieldErrors(result)).toEqual({})
  })

  it('returns field-keyed error messages on failure', () => {
    const result = loginSchema.safeParse({ email: 'bad', password: '' })
    const errs = getFieldErrors(result)
    expect(typeof errs).toBe('object')
    expect(errs.email).toBeTruthy()
    expect(errs.password).toBeTruthy()
  })
})
