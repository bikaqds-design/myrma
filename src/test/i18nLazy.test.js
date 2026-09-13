import { describe, it, expect, beforeEach, vi } from 'vitest'
import enJson from '../locales/en.json'
import arJson from '../locales/ar.json'

// BUG-078: Arabic is no longer in the main bundle. These pin the behaviour the
// app depends on, so an i18next upgrade that changes it fails here and not in
// front of an Arabic-speaking user.
const KEY = 'customers.oddMobileTitle'
const EN = enJson.customers.oddMobileTitle
const AR = arJson.customers.oddMobileTitle

async function freshI18n(savedLanguage) {
  vi.resetModules()
  localStorage.clear()
  if (savedLanguage) localStorage.setItem('mrma_language', JSON.stringify(savedLanguage))
  const mod = await import('../lib/i18n.js')
  await mod.i18nReady
  return mod
}

describe('lazy language loading', () => {
  beforeEach(() => localStorage.clear())

  it('starts in English without fetching Arabic', async () => {
    const { default: i18n } = await freshI18n()
    expect(i18n.language).toBe('en')
    expect(i18n.t(KEY)).toBe(EN)
    expect(i18n.hasResourceBundle('ar', 'translation')).toBe(false)
  })

  // The flash-of-English guard: by the time i18nReady resolves, a saved Arabic
  // preference must already be translated, because main.jsx renders then.
  it('has Arabic ready before first render when Arabic was saved', async () => {
    const { default: i18n } = await freshI18n('ar')
    expect(i18n.language).toBe('ar')
    expect(i18n.t(KEY)).toBe(AR)
  })

  it('loads Arabic on demand and only then switches', async () => {
    const { default: i18n } = await freshI18n()
    await i18n.changeLanguage('ar')
    expect(i18n.hasResourceBundle('ar', 'translation')).toBe(true)
    expect(i18n.t(KEY)).toBe(AR)
  })

  it('keeps English intact after Arabic arrives (fallback still resolves)', async () => {
    const { default: i18n } = await freshI18n()
    await i18n.changeLanguage('ar')
    await i18n.changeLanguage('en')
    expect(i18n.t(KEY)).toBe(EN)
  })

  it('falls back to English for an unsupported saved language', async () => {
    const { default: i18n } = await freshI18n('fr')
    expect(i18n.language).toBe('en')
    expect(i18n.t(KEY)).toBe(EN)
  })
})
