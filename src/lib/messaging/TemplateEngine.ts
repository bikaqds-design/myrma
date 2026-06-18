import type { TemplateVariable } from './types.js'

export class TemplateEngine {
  /**
   * Render a template string, replacing {{key}} placeholders with values.
   * Supports conditional blocks: {{#key}}...{{/key}} — rendered only when
   * variables[key] is non-empty.
   */
  static render(template: string, variables: Record<string, string>): string {
    let rendered = template

    // Conditional blocks: {{#key}}content{{/key}}
    rendered = rendered.replace(
      /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_match: string, varName: string, content: string) => {
        const value = variables[varName]
        return value && value.trim() ? content : ''
      }
    )

    // Simple variable substitution: {{key}}
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g')
      rendered = rendered.replace(regex, value ?? '')
    }

    // Strip any remaining unreplaced placeholders
    rendered = rendered.replace(/\{\{[^}]+\}\}/g, '')

    return rendered.trim()
  }

  /** Extract all variable names referenced in a template string. */
  static extractVariableNames(template: string): string[] {
    const matches = template.match(/\{\{#?(\w+)\}?\}/g) ?? []
    return [
      ...new Set(
        matches
          .map((m) => m.replace(/[{}#/]/g, ''))
          .filter((n) => n.length > 0)
      ),
    ]
  }

  /**
   * Resolve template variables from a flat payload object.
   * `source` is a dot-path, e.g. "ticket.rma_number" → payload.ticket.rma_number.
   * For a flat payload, "rma_number" → payload.rma_number.
   */
  static resolveVariables(
    defs: TemplateVariable[],
    payload: Record<string, unknown>
  ): Record<string, string> {
    const resolved: Record<string, string> = {}

    for (const def of defs) {
      const value = def.source
        .split('.')
        .reduce((obj: unknown, key: string) => {
          if (obj !== null && typeof obj === 'object') {
            return (obj as Record<string, unknown>)[key]
          }
          return undefined
        }, payload as unknown)

      resolved[def.key] = value != null ? String(value) : ''
    }

    return resolved
  }

  /** Format dates in the resolved variables map to a human-readable form. */
  static formatDates(
    variables: Record<string, string>,
    dateKeys: string[] = ['created_date', 'due_date', 'estimated_date', 'payment_date']
  ): Record<string, string> {
    const out = { ...variables }
    for (const key of dateKeys) {
      if (out[key]) {
        try {
          out[key] = new Date(out[key]).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })
        } catch {
          // leave as-is if date parsing fails
        }
      }
    }
    return out
  }

}
