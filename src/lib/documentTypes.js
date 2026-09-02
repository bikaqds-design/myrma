/**
 * The kinds of document a product can carry.
 *
 * Its own module because both a component and a page need it, and a module that
 * exports a component and a constant together breaks fast refresh.
 *
 * Must match the doc_type CHECK constraint in 20260801 — a value here that the
 * constraint rejects fails on save as a database error rather than a form
 * message.
 */
export const DOC_TYPES = ['datasheet', 'manual', 'warranty', 'certificate', 'drawing', 'other']
