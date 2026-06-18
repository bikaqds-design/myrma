/**
 * TemplateEngine.test.js — Unit tests for src/lib/messaging/TemplateEngine.ts
 *
 * Covers: {{key}} substitution, {{#key}}...{{/key}} conditional blocks,
 * variable extraction, and date formatting.
 */
import { describe, it, expect } from 'vitest'
import { TemplateEngine } from '../lib/messaging/TemplateEngine'

// ── render — substitution ──────────────────────────────────────────────────

describe('TemplateEngine.render — substitution', () => {
  it('replaces a single {{key}} placeholder', () => {
    expect(TemplateEngine.render('Hello {{name}}', { name: 'Sam' })).toBe('Hello Sam')
  })

  it('replaces multiple distinct placeholders', () => {
    expect(
      TemplateEngine.render('{{rma_number}} for {{customer_name}}', {
        rma_number: 'RMA-001',
        customer_name: 'Acme',
      })
    ).toBe('RMA-001 for Acme')
  })

  it('replaces repeated occurrences of the same key', () => {
    expect(TemplateEngine.render('{{x}} and {{x}}', { x: 'A' })).toBe('A and A')
  })

  it('strips unreplaced placeholders with no matching variable', () => {
    expect(TemplateEngine.render('Hi {{missing}}!', {})).toBe('Hi !')
  })

  it('treats a null/undefined value as empty string', () => {
    expect(TemplateEngine.render('Hi {{name}}!', { name: undefined })).toBe('Hi !')
  })

  it('trims leading/trailing whitespace from the rendered output', () => {
    expect(TemplateEngine.render('  {{name}}  ', { name: 'Sam' })).toBe('Sam')
  })
})

// ── render — conditional blocks ────────────────────────────────────────────

describe('TemplateEngine.render — conditional blocks', () => {
  it('shows block content when the variable is non-empty', () => {
    expect(
      TemplateEngine.render('{{#note}}Note: {{note}}{{/note}}', { note: 'urgent' })
    ).toBe('Note: urgent')
  })

  it('omits block content when the variable is an empty string', () => {
    expect(TemplateEngine.render('{{#note}}Note: {{note}}{{/note}}', { note: '' })).toBe('')
  })

  it('omits block content when the variable is whitespace-only', () => {
    expect(TemplateEngine.render('{{#note}}Note: {{note}}{{/note}}', { note: '   ' })).toBe('')
  })

  it('omits block content when the variable is missing entirely', () => {
    expect(TemplateEngine.render('{{#note}}Note: {{note}}{{/note}}', {})).toBe('')
  })

  it('renders content before and after the conditional block', () => {
    expect(
      TemplateEngine.render('Start {{#x}}middle{{/x}} End', { x: 'yes' })
    ).toBe('Start middle End')
  })
})

// ── extractVariableNames ───────────────────────────────────────────────────

describe('TemplateEngine.extractVariableNames', () => {
  it('extracts a simple placeholder name', () => {
    expect(TemplateEngine.extractVariableNames('{{name}}')).toEqual(['name'])
  })

  it('extracts both the conditional key and the inner key once each', () => {
    const names = TemplateEngine.extractVariableNames('{{#note}}{{note}}{{/note}}')
    expect(names).toEqual(['note'])
  })

  it('deduplicates repeated variable names', () => {
    expect(TemplateEngine.extractVariableNames('{{x}} {{x}} {{y}}')).toEqual(['x', 'y'])
  })

  it('returns an empty array when there are no placeholders', () => {
    expect(TemplateEngine.extractVariableNames('plain text')).toEqual([])
  })
})

// ── resolveVariables ────────────────────────────────────────────────────────

describe('TemplateEngine.resolveVariables', () => {
  it('resolves a flat key from the payload', () => {
    const resolved = TemplateEngine.resolveVariables(
      [{ key: 'rma', source: 'rma_number', label: 'RMA' }],
      { rma_number: 'RMA-001' }
    )
    expect(resolved.rma).toBe('RMA-001')
  })

  it('resolves a dot-path key through a nested object', () => {
    const resolved = TemplateEngine.resolveVariables(
      [{ key: 'rma', source: 'ticket.rma_number', label: 'RMA' }],
      { ticket: { rma_number: 'RMA-002' } }
    )
    expect(resolved.rma).toBe('RMA-002')
  })

  it('resolves to an empty string when the path does not exist', () => {
    const resolved = TemplateEngine.resolveVariables(
      [{ key: 'rma', source: 'ticket.rma_number', label: 'RMA' }],
      {}
    )
    expect(resolved.rma).toBe('')
  })

  it('coerces non-string values to strings', () => {
    const resolved = TemplateEngine.resolveVariables(
      [{ key: 'count', source: 'count', label: 'Count' }],
      { count: 5 }
    )
    expect(resolved.count).toBe('5')
  })
})

// ── formatDates ──────────────────────────────────────────────────────────────

describe('TemplateEngine.formatDates', () => {
  it('formats a known date key to a human-readable string', () => {
    const out = TemplateEngine.formatDates({ created_date: '2026-06-17' })
    const expected = new Date('2026-06-17').toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    expect(out.created_date).toBe(expected)
  })

  it('leaves non-date keys untouched', () => {
    const out = TemplateEngine.formatDates({ customer_name: 'Acme' })
    expect(out.customer_name).toBe('Acme')
  })

  it('does not throw on an unparsable date string', () => {
    expect(() => TemplateEngine.formatDates({ created_date: 'not-a-date' })).not.toThrow()
  })

  it('does not mutate keys absent from the variables map', () => {
    const out = TemplateEngine.formatDates({})
    expect(out).toEqual({})
  })
})
