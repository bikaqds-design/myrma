/**
 * WidgetShell.test.jsx — the card every dashboard widget lives in.
 *
 * This is where the four behaviours the rebuild added actually live: the size
 * a widget renders at, the link it opens, the reorder controls, and removal.
 * The dashboard itself needs a signed-in session against a live project to
 * look at, so this is what can be verified without one.
 *
 * i18n is stubbed to echo the key, so an assertion names the exact string a
 * control resolves to rather than matching prose that could change.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key) }),
}))

// Dashboard.jsx pulls in supabase, react-query and recharts at module scope.
// None of that is needed to render a card, so it is stubbed out.
vi.mock('../api/supabaseClient', () => ({ db: {}, supabase: { channel: () => ({ on: () => ({ on: () => ({ on: () => ({ subscribe: () => ({}) }) }) }) }), removeChannel: () => {} } }))
vi.mock('../contexts/AppearanceContext', () => ({ useAppearance: () => ({ darkMode: false }) }))

const { WidgetShell } = await import('../pages/Dashboard')
const { SIZE_CLASS, SIZE_MIN_HEIGHT } = await import('../lib/dashboardWidgets')

const tk = {
  surface: '#fff', surfaceInset: '#f7f7f9', border: '#e6e9ef', borderSoft: '#eee',
  text: '#111', textMuted: '#666', textFaint: '#999', accent: '#4338ca', bad: '#ef4444',
}
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key)

const widget = {
  id: 'sla_health',
  labelKey: 'dashboard.widgets.sla_health.label',
  href: '/reports',
  size: 'quarter',
}

function renderShell(overrides = {}) {
  const props = {
    w: widget,
    tk,
    t,
    index: 1,
    total: 3,
    editing: false,
    isDragging: false,
    bare: false,
    onOpen: vi.fn(),
    onMove: vi.fn(),
    onCycleSize: vi.fn(),
    onRemove: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDropOn: vi.fn(),
    ...overrides,
  }
  const utils = render(<WidgetShell {...props}><p>body</p></WidgetShell>)
  return { ...utils, props, card: utils.container.firstChild }
}

afterEach(cleanup)

describe('sizing', () => {
  // The whole point of the rebuild: size comes from the user's preference, not
  // from a col-span hardcoded next to each widget's markup.
  it.each(['quarter', 'half', 'full'])('renders the %s column class', (size) => {
    const { card } = renderShell({ w: { ...widget, size } })
    expect(card.className).toBe(SIZE_CLASS[size])
    expect(card.style.minHeight).toBe(`${SIZE_MIN_HEIGHT[size]}px`)
  })
})

describe('click-through', () => {
  it('opens its link when clicked', () => {
    const onOpen = vi.fn()
    const { card } = renderShell({ onOpen })
    card.click()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('is reachable from the keyboard', () => {
    const { card } = renderShell()
    expect(card.getAttribute('role')).toBe('button')
    expect(card.getAttribute('tabindex')).toBe('0')
    expect(card.getAttribute('aria-label')).toContain('dashboard.openWidget')
  })

  // A widget with nowhere to go must not pretend to be a button.
  it('is inert when the widget has no href', () => {
    const { card } = renderShell({ w: { ...widget, href: undefined } })
    expect(card.getAttribute('role')).toBeNull()
    expect(card.style.cursor).toBe('default')
  })

  // Otherwise every size change and reorder would also navigate away.
  it('does not navigate while editing', () => {
    const onOpen = vi.fn()
    const { card } = renderShell({ editing: true, onOpen })
    card.click()
    expect(onOpen).not.toHaveBeenCalled()
    expect(card.getAttribute('role')).toBeNull()
  })
})

describe('edit mode', () => {
  it('shows no controls when not editing', () => {
    renderShell()
    expect(screen.queryByLabelText('dashboard.moveEarlier')).not.toBeInTheDocument()
  })

  it('offers move, size and remove when editing', () => {
    renderShell({ editing: true })
    expect(screen.getByLabelText('dashboard.moveEarlier')).toBeInTheDocument()
    expect(screen.getByLabelText('dashboard.moveLater')).toBeInTheDocument()
    expect(screen.getByTitle('dashboard.changeSize')).toBeInTheDocument()
  })

  it('moves earlier and later by one', () => {
    const onMove = vi.fn()
    renderShell({ editing: true, onMove })
    screen.getByLabelText('dashboard.moveEarlier').click()
    expect(onMove).toHaveBeenCalledWith('sla_health', -1)
    screen.getByLabelText('dashboard.moveLater').click()
    expect(onMove).toHaveBeenCalledWith('sla_health', 1)
  })

  // Without this the first card could be moved off the front of the list.
  it('disables move-earlier on the first card and move-later on the last', () => {
    renderShell({ editing: true, index: 0, total: 3 })
    expect(screen.getByLabelText('dashboard.moveEarlier')).toBeDisabled()
    expect(screen.getByLabelText('dashboard.moveLater')).not.toBeDisabled()
    cleanup()
    renderShell({ editing: true, index: 2, total: 3 })
    expect(screen.getByLabelText('dashboard.moveEarlier')).not.toBeDisabled()
    expect(screen.getByLabelText('dashboard.moveLater')).toBeDisabled()
  })

  it('cycles the size and removes', () => {
    const onCycleSize = vi.fn()
    const onRemove = vi.fn()
    renderShell({ editing: true, onCycleSize, onRemove })
    screen.getByTitle('dashboard.changeSize').click()
    expect(onCycleSize).toHaveBeenCalledWith('sla_health')
    screen.getByTitle(/dashboard\.removeWidget/).click()
    expect(onRemove).toHaveBeenCalledWith('sla_health')
  })

  it('shows the current size on the size control', () => {
    renderShell({ editing: true, w: { ...widget, size: 'full' } })
    expect(screen.getByTitle('dashboard.changeSize')).toHaveTextContent('dashboard.size.full')
  })

  // The control bar sits on top of the card. Without stopPropagation every
  // button would fire the card's own click-through as well.
  it('keeps control clicks off the card', () => {
    const onOpen = vi.fn()
    const onCycleSize = vi.fn()
    renderShell({ editing: false, onOpen, onCycleSize })
    // not editing: no bar. Now with editing on, clicking a control must not open.
    cleanup()
    renderShell({ editing: true, onOpen, onCycleSize })
    screen.getByTitle('dashboard.changeSize').click()
    expect(onCycleSize).toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('is only draggable while editing', () => {
    const { card } = renderShell({ editing: false })
    expect(card.getAttribute('draggable')).toBe('false')
    cleanup()
    const { card: editCard } = renderShell({ editing: true })
    expect(editCard.getAttribute('draggable')).toBe('true')
  })
})

describe('presentation', () => {
  it('drops its padding when the widget draws its own edges', () => {
    const { card } = renderShell({ bare: true })
    expect(card.style.padding).toBe('0px')
    expect(card.style.overflow).toBe('hidden')
  })

  it('marks the card being dragged', () => {
    const { card } = renderShell({ editing: true, isDragging: true })
    expect(Number(card.style.opacity)).toBeLessThan(1)
  })

  it('renders the widget body', () => {
    const { card } = renderShell()
    expect(within(card).getByText('body')).toBeInTheDocument()
  })
})
