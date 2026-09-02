// @vitest-environment node
/**
 * edgeFunctionSyntax.test.js — the Edge Function has to parse before it ships.
 *
 * A deploy failed with "The module's source code could not be parsed" because
 * an edit put a literal newline inside a SINGLE-quoted string, which JS does
 * not allow — while five identical-looking newlines inside TEMPLATE literals
 * were perfectly legal. The difference is invisible when reading the file, and
 * a deploy is the slowest and most annoying place to discover it.
 *
 * Runs in the node environment on purpose: esbuild refuses to start under
 * jsdom, whose TextEncoder does not produce a real Uint8Array.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const FUNCTIONS = ['supabase/functions/kb-chat/index.ts']

describe('Edge Functions parse', () => {
  it.each(FUNCTIONS)('%s is valid TypeScript', async (path) => {
    const esbuild = await import('esbuild')
    await expect(
      esbuild.build({
        entryPoints: [path],
        bundle: false,
        write: false,
        loader: { '.ts': 'ts' },
        format: 'esm',
      })
    ).resolves.toBeTruthy()
  })

  // Named rather than raw, so a newline can never again land somewhere it is
  // illegal and look fine.
  it.each(FUNCTIONS)('%s writes newlines through a named constant', (path) => {
    expect(readFileSync(path, 'utf8')).toContain('const NL = String.fromCharCode(10)')
  })

  it.each(FUNCTIONS)('%s has no unterminated single-quoted string', (path) => {
    const offenders = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => {
        // Block-comment lines carry apostrophes ("the question's terms") that
        // are prose, not code.
        if (/^\s*(\*|\/\*)/.test(l)) return false
        // URLs first: splitting on '//' before removing them chops
        // https:// in half and reports every import as unbalanced.
        const code = l.replace(/https?:\/\//g, '').split('//')[0]
        return (code.match(/'/g) || []).length % 2 === 1
      })
    expect(offenders, `unterminated string on: ${offenders.join(' | ')}`).toEqual([])
  })
})
