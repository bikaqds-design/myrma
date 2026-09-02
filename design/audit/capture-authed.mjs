/**
 * Authenticated screenshot capture for the UI/UX audit.
 *
 * Signs in through the Supabase client in Node and injects the resulting session
 * into the browser's localStorage, rather than driving the login form. That keeps
 * the capture independent of login-page markup and avoids typing credentials into
 * a UI.
 *
 * Fixtures are disposable accounts created for this run and deleted afterwards.
 */
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const URL = process.env.VITE_SUPABASE_URL
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const REF = URL.match(/https:\/\/([a-z0-9]+)\./)[1]
const STORAGE_KEY = `sb-${REF}-auth-token`
const BASE = 'http://localhost:5173'
const PW = 'AuditShot#2026aA'

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }

const ALL_ROUTES = [
  ['dashboard', '/'], ['sales-funnel', '/leads'], ['sales-funnel', '/pipeline'],
  ['activities', '/activities'], ['sales-docs', '/sales'], ['accounting', '/accounting'],
  ['purchases', '/purchasing'], ['rma', '/rma-tickets'], ['inventory', '/inventory'],
  ['products', '/products'], ['customers', '/customers'], ['reports', '/reports'],
  ['calendar', '/calendar'], ['knowledge', '/knowledge-center'],
  ['admin', '/control-panel'], ['settings', '/account'],
]
// Non-admin roles get a small set, enough to show permission degradation.
const ROLE_SAMPLE = [['dashboard', '/'], ['purchases', '/purchasing'], ['admin', '/control-panel']]

async function sessionFor(email) {
  const sb = createClient(URL, ANON)
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PW })
  if (error) throw new Error(`${email}: ${error.message}`)
  return data.session
}

const browser = await chromium.launch()
const results = []

for (const role of ['admin', 'manager', 'technician', 'sales_rep', 'viewer']) {
  const email = `zz-audit-${role}@qdsegypt.com`
  let session
  try { session = await sessionFor(email) }
  catch (e) { results.push({ role, error: e.message }); continue }

  const routes = role === 'admin' ? ALL_ROUTES : ROLE_SAMPLE
  const matrix = role === 'admin'
    ? [['en', 'desktop'], ['ar', 'desktop'], ['en', 'mobile']]
    : [['en', 'desktop']]

  for (const [mod, route] of routes) {
    for (const [locale, vpName] of matrix) {
      const ctx = await browser.newContext({ viewport: VIEWPORTS[vpName], locale })
      await ctx.addInitScript(([k, s, l]) => {
        try {
          localStorage.setItem(k, s)
          localStorage.setItem('mrma_language', JSON.stringify(l))
        } catch {}
      }, [STORAGE_KEY, JSON.stringify(session), locale])

      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(String(e.message).slice(0, 100)))
      try { await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 }) } catch {}
      await page.waitForTimeout(3500)

      // A failed navigation leaves an about:blank page with no body, so every
      // read here has to tolerate that rather than throwing mid-run.
      let info = { dir: null, denied: null, navItems: 0, blank: true }
      try {
        info = await page.evaluate(() => {
          const b = document.body
          if (!b) return { dir: null, denied: null, navItems: 0, blank: true }
          return {
            dir: document.documentElement.getAttribute('dir'),
            denied: /access denied|no permission|sign in/i.test(b.innerText.slice(0, 400)),
            navItems: document.querySelectorAll('nav button, aside button').length,
            blank: b.innerText.trim().length < 40,
          }
        })
      } catch {}

      const dir = `design/audit/screens/${mod}`
      fs.mkdirSync(dir, { recursive: true })
      const name = route.replace(/\//g, '') || 'dashboard'
      const file = `${dir}/${name}--${role}--${locale}--${vpName}.png`
      await page.screenshot({ path: file, fullPage: true })
      results.push({ role, route, locale, vpName, ...info, errors: errors.length, file })
      await ctx.close()
    }
  }
}
await browser.close()
fs.writeFileSync('design/audit/capture-log.json', JSON.stringify(results, null, 1))
const bad = results.filter(r => r.error || r.errors > 0 || r.denied)
console.log(`captured ${results.filter(r => r.file).length} screenshots`)
console.log(`rows with page errors / denials / failures: ${bad.length}`)
console.log(JSON.stringify(bad.slice(0, 12), null, 1))
