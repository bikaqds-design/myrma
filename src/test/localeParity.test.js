import { describe, it, expect } from 'vitest'
import en from '../locales/en.json'
import ar from '../locales/ar.json'

/**
 * Locale parity. (Audit finding BUG-042.)
 *
 * The audit found `ar.json` missing keys that `en.json` had, which is the
 * failure that actually shows: i18next falls back to the English string, so an
 * Arabic user gets an English sentence in the middle of an RTL page and nobody
 * notices until they read it.
 *
 * Arabic having keys English does not is NOT drift, and a naive set comparison
 * would fail on correct translations. Arabic uses six CLDR plural categories
 * (zero, one, two, few, many, other) against English's two, so a single
 * `foo_other` in English correctly becomes `foo_zero`, `foo_two`, `foo_few`,
 * `foo_many` and the rest in Arabic. Every one of the 207 Arabic-only keys at
 * the time of writing is one of those. The test therefore allows an Arabic key
 * that is a plural variant of a key English has, and only fails on a genuine
 * orphan — a key belonging to no English string at all, which is what a rename
 * leaves behind.
 */

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function flatten(obj, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, path))
    } else {
      out[path] = value
    }
  }
  return out
}

const enKeys = flatten(en)
const arKeys = flatten(ar)

/** The key an Arabic plural form belongs to, in either English spelling. */
function englishCounterparts(key) {
  const base = key.replace(PLURAL_SUFFIX, '')
  return [base, `${base}_other`, `${base}_one`]
}

describe('locale parity (BUG-042)', () => {
  it('translates every English key into Arabic', () => {
    const missing = Object.keys(enKeys).filter((k) => !(k in arKeys))
    // Named, not counted: a failure should say which string will render in
    // English on an Arabic screen.
    expect(missing).toEqual([])
  })

  it('leaves no orphaned Arabic key behind a rename', () => {
    const orphans = Object.keys(arKeys).filter((k) => {
      if (k in enKeys) return false
      if (!PLURAL_SUFFIX.test(k)) return true
      return !englishCounterparts(k).some((c) => c in enKeys)
    })
    expect(orphans).toEqual([])
  })

  it('accepts the Arabic plural categories English does not have', () => {
    // Guards the rule above: if this stops finding any, the exemption has gone
    // stale and the orphan test has quietly become a plain set comparison.
    const pluralOnly = Object.keys(arKeys).filter(
      (k) => !(k in enKeys) && PLURAL_SUFFIX.test(k)
    )
    expect(pluralOnly.length).toBeGreaterThan(0)
  })

  it('never leaves an Arabic string blank where English has one', () => {
    // A few keys are blank on purpose in BOTH files — `phone.empty` is the
    // "nothing to say yet" message, `cp.pipelineStages.colActions` is the
    // header over an icon column. Those are fine. A key with English text and
    // an empty Arabic value is not: it renders as nothing at all.
    const blankInArabic = Object.entries(enKeys)
      .filter(([key, value]) =>
        typeof value === 'string' && value.trim() !== '' &&
        typeof arKeys[key] === 'string' && arKeys[key].trim() === '')
      .map(([key]) => key)
    expect(blankInArabic).toEqual([])
  })

  it('keeps the same interpolation placeholders in both languages', () => {
    // A translation that invents a placeholder renders nothing for it; one
    // that drops a real one loses the value from the sentence.
    //
    // The exception is `{{count}}` inside a plural form. Arabic's `_one` and
    // `_two` categories mean exactly one and exactly two, and idiomatic Arabic
    // names the thing rather than repeating the numeral — "تذكرة واحدة", not
    // "1 تذكرة". Dropping count there is a correct translation, so requiring it
    // would force translators to write unnatural Arabic to keep a test green.
    const vars = (s) => [...s.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1])
    const mismatched = []
    for (const [key, enValue] of Object.entries(enKeys)) {
      const arValue = arKeys[key]
      if (typeof enValue !== 'string' || typeof arValue !== 'string') continue
      const isPlural = PLURAL_SUFFIX.test(key)
      const expected = new Set(vars(enValue))
      const actual = new Set(vars(arValue))
      const invented = [...actual].filter((v) => !expected.has(v))
      const dropped = [...expected].filter(
        (v) => !actual.has(v) && !(isPlural && v === 'count')
      )
      if (invented.length || dropped.length) {
        mismatched.push(`${key} (dropped: ${dropped.join('|') || '-'}, invented: ${invented.join('|') || '-'})`)
      }
    }
    expect(mismatched).toEqual([])
  })
})
