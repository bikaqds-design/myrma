/**
 * documentPageTitle.test.jsx — the top bar on a document page and the confirm
 * dialog's tone. Found testing deliveries in a browser (2026-09-25): a sales or
 * purchasing document page showed its raw address ("Sales/Sales_order/3cad54f8…")
 * as the title, and confirming a shipment used the red delete dialog.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import { readFileSync } from 'node:fs'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }))
const { default: ConfirmDialog } = await import('../components/ConfirmDialog.jsx')
afterEach(cleanup)

describe('document page title', () => {
  const app = readFileSync('src/App.jsx', 'utf8')
  it('a sales or purchasing document page is titled by its kind, not its address', () => {
    expect(app).toContain("if (pathname.startsWith('/sales/')) return t('nav.salesDocument')")
    expect(app).toContain("if (pathname.startsWith('/purchasing/')) return t('nav.purchasing')")
    // the vendor page keeps its own title: its check comes first
    expect(app.indexOf("pathname.startsWith('/purchasing/vendor/')")).toBeLessThan(app.indexOf("pathname.startsWith('/purchasing/')) return"))
  })
})

describe('ConfirmDialog tone', () => {
  it('is a labelled dialog, red by default', () => {
    render(<ConfirmDialog open title="Delete it?" message="Gone for good." onConfirm={() => {}} onCancel={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Delete it?' })
    expect(dialog.querySelector('.bg-red-100')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'common.delete' }).className).toContain('bg-red-600')
  })

  it('uses the accent colour for a normal step', () => {
    render(<ConfirmDialog open tone="primary" title="Ship it?" message="Stock leaves." confirmLabel="Confirm" onConfirm={() => {}} onCancel={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Ship it?' })
    expect(dialog.querySelector('.bg-red-100')).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toContain('bg-[#4338ca]')
  })
})
