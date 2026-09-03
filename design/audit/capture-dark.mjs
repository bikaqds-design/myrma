/**
 * Dark-mode capture for the UI/UX audit.
 *
 * Dark mode is class-based (`html.dark`) and driven by the `mrma_appearance`
 * setting, so it is forced through localStorage rather than by clicking the
 * toggle — clicking would need every route to be reachable first.
 *
 * Also collects, per route, the elements that paint a light background while
 * the page is dark. Those are the ones that show as white blocks.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const REF = URL.match(/https:\/\/([a-z0-9]+)\./)[1]
const BASE = 'http://localhost:5173'

const ROUTES = [
  ['dashboard', '/'], ['sales-funnel', '/leads'], ['sales-funnel', '/pipeline'],
  ['activities', '/activities'], ['sales-docs', '/sales'], ['accounting', '/accounting'],
  ['purchases', '/purchasing'], ['rma', '/rma-tickets'], ['inventory', '/inventory'],
  ['products', '/products'], ['customers', '/customers'], ['reports', '/reports'],
  ['calendar', '/calendar'], ['knowledge', '/knowledge-center'],
  ['admin', '/control-panel'], ['settings', '/account'],
]

const sb = createClient(URL, ANON)
const { data, error } = await sb.auth.signInWithPassword({
  email: 'zz-dark@qdsegypt.com', password: 'AuditShot#2026aA',
})
if (error) throw error

const browser = await chromium.launch()
const report = []

for (const [mod, route] of ROUTES) {
  for (const [locale, vp] of [['en', { width: 1440, height: 900 }], ['ar', { width: 1440, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport: vp, locale })
    await ctx.addInitScript(([k, s, l, email]) => {
      localStorage.setItem(k, s)
      localStorage.setItem('mrma_language', JSON.stringify(l))
      localStorage.setItem('mrma_appearance', JSON.stringify({ darkMode: true }))
      localStorage.setItem('mrma_onboarding_v1_' + email, 'true')
    }, [`sb-${REF}-auth-token`, JSON.stringify(data.session), locale, 'zz-dark@qdsegypt.com'])

    const page = await ctx.newPage()
    // AppearanceContext fetches appearance_settings from rma_config on mount and
    // overwrites localStorage with it. That row is GLOBAL and currently has
    // darkMode:false, so an injected preference is wiped before first paint.
    // Return an empty set for that table only, so the effect finds no row and
    // leaves the injected setting alone. Nothing in production is modified.
    await page.route('**/rest/v1/rma_config*', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    )
    try { await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 }) } catch {}
    await page.waitForTimeout(3500)

    const info = await page.evaluate(() => {
      const isDark = document.documentElement.classList.contains('dark')
      const light = []
      const seen = new Map()
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width < 40 || r.height < 16) continue
        const cs = getComputedStyle(el)
        const m = cs.backgroundColor.match(/rgba?\((\d+), (\d+), (\d+)/)
        if (!m) continue
        const [r0, g0, b0] = [+m[1], +m[2], +m[3]]
        if (cs.backgroundColor.includes('rgba(0, 0, 0, 0)')) continue
        // A near-white surface on a dark page.
        if (r0 > 230 && g0 > 230 && b0 > 230 && r.width * r.height > 4000) {
          const key = el.className?.toString().slice(0, 60) || el.tagName
          seen.set(key, (seen.get(key) || 0) + 1)
        }
      }
      for (const [k, n] of seen) light.push({ cls: k, count: n })
      return {
        isDark,
        htmlDir: document.documentElement.getAttribute('dir'),
        lightSurfaces: light.sort((a, b) => b.count - a.count).slice(0, 6),
        lightSurfaceTotal: light.reduce((n, x) => n + x.count, 0),
      }
    })

    const dir = `design/audit/screens-dark/${mod}`
    fs.mkdirSync(dir, { recursive: true })
    const name = route.replace(/\//g, '') || 'dashboard'
    const file = `${dir}/${name}--${locale}--dark.png`
    await page.screenshot({ path: file, fullPage: true })
    report.push({ mod, route, locale, ...info, file })
    await ctx.close()
  }
}
await browser.close()
fs.writeFileSync('design/audit/dark-report.json', JSON.stringify(report, null, 1))
const bad = report.filter(r => r.lightSurfaceTotal > 0)
console.log(`captured ${report.length} dark screenshots`)
console.log(`routes showing light surfaces while dark: ${bad.length} of ${report.length}`)
for (const r of bad.slice(0, 10)) {
  console.log(`  ${r.route} [${r.locale}] -> ${r.lightSurfaceTotal} light surface(s)`)
}
