import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// BUG-056: scripts are allowed by hash, not by 'unsafe-inline'. A hash is exact
// to the byte, so editing the inline script in index.html without updating
// vercel.json would silently block it in production — dark mode would stop
// applying before first paint, and nothing else would say why.
const root = resolve(__dirname, '../..')
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'))

const csp = vercel.headers
  .flatMap((h) => h.headers)
  .find((h) => h.key === 'Content-Security-Policy').value
const scriptSrc = csp
  .split(';')
  .map((d) => d.trim())
  .find((d) => d.startsWith('script-src '))

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) =>
  // Served with LF line endings; normalise in case the checkout has CRLF.
  m[1].replace(/\r\n/g, '\n')
)

describe('Content-Security-Policy script-src', () => {
  it('allows no inline script or eval wholesale', () => {
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  it('has a matching hash for every inline script in index.html', () => {
    expect(inlineScripts.length).toBeGreaterThan(0)
    for (const body of inlineScripts) {
      const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
      expect(scriptSrc, 'edit the hash in vercel.json to match index.html').toContain(hash)
    }
  })
})
