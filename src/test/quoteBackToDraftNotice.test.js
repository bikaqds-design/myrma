// @vitest-environment node
/**
 * quoteBackToDraftNotice.test.js — since 20260893 a quote awaiting approval
 * goes back to draft (and its approval request is withdrawn) when its offer
 * changes. Both screens that edit a quote must tell the user, in both
 * languages.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'))
const ar = JSON.parse(readFileSync('src/locales/ar.json', 'utf8'))

describe('the back-to-draft notice', () => {
  it('exists in English and Arabic', () => {
    expect(en.salesDocuments.qtBackToDraft).toMatch(/back in draft/)
    expect(ar.salesDocuments.qtBackToDraft).toBeTruthy()
    expect(ar.salesDocuments.qtBackToDraft).not.toBe(en.salesDocuments.qtBackToDraft)
  })

  for (const file of ['src/pages/Pipeline/DealDetail.jsx', 'src/pages/SalesDocuments/SalesDocumentForm.jsx']) {
    it(`${file} shows it when a sent quote comes back as a draft`, () => {
      const src = readFileSync(file, 'utf8')
      expect(src).toMatch(/status === 'sent' && saved\?\.status === 'draft'/)
      expect(src).toContain("toast(t('salesDocuments.qtBackToDraft')")
    })
  }
})
