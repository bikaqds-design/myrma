import { chromium } from 'playwright'
import fs from 'fs'

const BASE = 'http://localhost:5173'
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile:  { width: 390,  height: 844 },
}
const ROUTES = [
  ['auth',   '/',        'login'],
  ['public', '/tracker', 'tracker'],
  ['public', '/kb',      'knowledge-base'],
]

const browser = await chromium.launch()
const results = []

for (const [mod, route, name] of ROUTES) {
  for (const locale of ['en', 'ar']) {
    for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
      if (locale === 'ar' && vpName === 'mobile') continue // keep the matrix to LTR/RTL desktop + LTR mobile
      const ctx = await browser.newContext({ viewport: vp, locale })
      const page = await ctx.newPage()
      // Set the language the app actually reads before any app code runs.
      // safeStorage JSON-stringifies, so the stored value must be a JSON string.
      // Writing the bare word made JSON.parse throw and the app fell back to 'en'.
      await ctx.addInitScript(l => {
        try { localStorage.setItem('mrma_language', JSON.stringify(l)) } catch {}
      }, locale)
      const errors = []
      page.on('pageerror', e => errors.push(String(e.message).slice(0, 120)))
      try {
        await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 25000 })
      } catch { /* fall through and shoot whatever rendered */ }
      await page.waitForTimeout(2500)
      const dir = await page.evaluate(() => document.documentElement.getAttribute('dir') || '(none)')
      const file = `design/audit/screens/${mod}/${name}--${locale}--${vpName}.png`
      await page.screenshot({ path: file, fullPage: true })
      results.push({ route, locale, vpName, dir, errors: errors.length, file })
      await ctx.close()
    }
  }
}
await browser.close()
console.log(JSON.stringify(results, null, 1))
