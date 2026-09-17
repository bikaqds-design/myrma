/**
 * warehouseUiFindings.test.jsx — the UI findings of the Warehouse R1 re-run (2026-09-17).
 *
 *  - Finding 2: the Branches / RMA drawers showed the row they were opened on,
 *    so a transfer's new numbers only appeared after closing and reopening.
 *  - Finding 3: Escape pressed to dismiss a product suggestion list closed the
 *    whole Create Ticket dialog and lost what was typed. Two paths did it: the
 *    RMA Tickets page's own Escape shortcut, and the dialog's.
 *
 * (Finding 4 — "Move to… lists the current location" — was withdrawn: that
 * option is rendered disabled.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import Modal from '../components/Modal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k }),
}))

afterEach(cleanup)

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('Modal lets a form keep itself open', () => {
  it('closes on Escape by default', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="T"><input aria-label="field" /></Modal>)
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when onEscapeKeyDown prevents it', () => {
    const onClose = vi.fn()
    const onEscapeKeyDown = vi.fn((e) => e.preventDefault())
    render(
      <Modal open onClose={onClose} onEscapeKeyDown={onEscapeKeyDown} title="T">
        <input aria-label="field" />
      </Modal>
    )
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Escape' })
    expect(onEscapeKeyDown).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the ticket form does not discard typed changes on Escape', () => {
  const form = read('src/pages/RMATickets/TicketForm.jsx')
  const page = read('src/pages/RMATickets/index.jsx')
  const search = read('src/pages/RMATickets/_shared.jsx')

  it('routes Escape and outside clicks through its own handlers', () => {
    expect(form).toContain('onEscapeKeyDown={handleEscapeKeyDown}')
    expect(form).toContain('onInteractOutside={handleInteractOutside}')
  })

  it('closes an open suggestion list before anything else, and asks before discarding', () => {
    const fn = form.slice(form.indexOf('function handleEscapeKeyDown'), form.indexOf('function handleInteractOutside'))
    expect(fn.indexOf('customerListOpen || productListOpen || otherListOpen')).toBeGreaterThan(-1)
    expect(fn.indexOf('setConfirmDiscard(true)')).toBeGreaterThan(fn.indexOf('customerListOpen || productListOpen'))
  })

  it('Cancel and the close button ask too', () => {
    expect(form).not.toMatch(/onClick=\{onClose\}\s*\n?\s*className="w-8 h-8/)
    expect(form).toMatch(/onClick=\{requestClose\}/)
  })

  it('the page shortcut leaves Escape to the open form', () => {
    const esc = page.slice(page.indexOf("if (e.key === 'Escape') {"))
    expect(esc.slice(0, 400)).toContain('if (showModal) return')
    expect(esc.slice(0, 400)).not.toContain('setShowModal(false)')
  })

  it('the product search box says when its list is open and closes it on Escape', () => {
    expect(search).toContain('aria-expanded={open && filtered.length > 0}')
    expect(search).toMatch(/e\.key === 'Escape' && open\) setOpen\(false\)/)
  })

  it('has the confirmation text in both languages', () => {
    for (const locale of ['en', 'ar']) {
      const tf = JSON.parse(read(`src/locales/${locale}.json`)).ticketForm
      for (const key of ['discardTitle', 'discardMessage', 'keepEditing', 'discardChanges']) {
        expect(tf[key], `${locale}.ticketForm.${key}`).toBeTruthy()
      }
    }
  })
})

describe('the Overview drawers show the row as it is now', () => {
  const overview = read('src/pages/Inventory/OverviewTab.jsx')

  it('looks the target up in the refreshed page, not the clicked snapshot', () => {
    expect(overview).toContain('paginated.find((r) => r.product_id === target.product_id) ?? target')
    expect(overview).toContain('productSummary={liveRow(branchesTarget)}')
    expect(overview).toContain('productSummary={liveRow(rmaTarget)}')
  })
})
