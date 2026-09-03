/**
 * WCAG AA contrast audit in dark mode.
 *
 * Measures computed foreground/background pairs on rendered text and reports
 * anything below the AA threshold (4.5:1 normal, 3:1 for large text).
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const URL = process.env.VITE_SUPABASE_URL, ANON = process.env.VITE_SUPABASE_ANON_KEY
const REF = URL.match(/https:\/\/([a-z0-9]+)\./)[1]
const ROUTES = ['/', '/leads', '/pipeline', '/activities', '/sales', '/accounting',
  '/purchasing', '/rma-tickets', '/inventory', '/products', '/customers', '/reports',
  '/calendar', '/knowledge-center', '/control-panel', '/account']

const sb = createClient(URL, ANON)
const { data, error } = await sb.auth.signInWithPassword({
  email: 'zz-os@qdsegypt.com', password: 'AuditShot#2026aA' })
if (error) throw error

const AUDIT = () => {
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const parse = (s) => { const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null }
  const bgOf = (el) => {
    let n = el
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor)
      if (c && c[3] > 0.5) return c
      n = n.parentElement
    }
    return [255, 255, 255, 1]
  }
  const out = new Map()
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 0) continue
    const txt = (el.textContent || '').trim()
    if (txt.length < 2) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue
    const fg = parse(cs.color); if (!fg) continue
    const bg = bgOf(el)
    const L1 = lum(fg), L2 = lum(bg)
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const size = parseFloat(cs.fontSize)
    const bold = parseInt(cs.fontWeight, 10) >= 700
    const large = size >= 24 || (bold && size >= 18.66)
    const need = large ? 3 : 4.5
    if (ratio < need) {
      const key = `${cs.color}|${size}px|${txt.slice(0, 28)}`
      if (!out.has(key)) out.set(key, { ratio: +ratio.toFixed(2), need, color: cs.color, size, text: txt.slice(0, 40) })
    }
  }
  return [...out.values()].sort((a, b) => a.ratio - b.ratio)
}

const browser = await chromium.launch()
const all = []
for (const route of ROUTES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(([k, s, email, dark]) => {
    localStorage.setItem(k, s)
    localStorage.setItem('mrma_appearance', JSON.stringify({ darkMode: dark }))
    localStorage.setItem('mrma_onboarding_v1_' + email, 'true')
  }, [`sb-${REF}-auth-token`, JSON.stringify(data.session), 'zz-dark@qdsegypt.com', process.env.DARK !== '0'])
  const page = await ctx.newPage()
  await page.route('**/rest/v1/rma_config*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  try { await page.goto('http://localhost:5173' + route, { waitUntil: 'networkidle', timeout: 30000 }) } catch {}
  // 3s was not enough for data-heavy routes: the Knowledge Center's file list
  // had not rendered, so its failing rows were measured as absent and the run
  // reported zero. A contrast audit that under-reports is worse than none.
  await page.waitForTimeout(7000)
  let fails = []
  try { fails = await page.evaluate(AUDIT) } catch {}
  all.push({ route, failures: fails.length, worst: fails.slice(0, 4) })
  await ctx.close()
}
await browser.close()
fs.writeFileSync(process.env.OUT || 'design/audit/dark-contrast.json', JSON.stringify(all, null, 1))
const total = all.reduce((n, r) => n + r.failures, 0)
console.log(`AA contrast failures (dark=${process.env.DARK !== '0'}): ${total} distinct across ${ROUTES.length} routes`)
for (const r of all.sort((a, b) => b.failures - a.failures).slice(0, 8)) {
  console.log(`  ${r.route.padEnd(18)} ${r.failures}`)
  for (const w of r.worst.slice(0, 2)) console.log(`      ${w.ratio}:1 (needs ${w.need}) ${w.color} ${w.size}px "${w.text}"`)
}
