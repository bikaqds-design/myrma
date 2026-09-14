/**
 * Colour contrast for company branding.
 *
 * The primary colour is whatever an administrator picked in Branding Settings,
 * and public pages paint white button text on it. A light pick fails WCAG AA:
 * QDS Egypt's #BF6E72 gives white text 3.69:1 against the 4.5:1 that normal-size
 * text needs. Rather than change the brand or swap the text colour, the button
 * darkens the fill only as far as it takes to pass (#BF6E72 becomes #AA6265),
 * and leaves a colour that already passes exactly as picked.
 *
 * Hover must not undo it. The buttons used `hover:opacity-90`, which fades the
 * fill toward the white page: #AA6265 drops back to 3.78:1. Hover now darkens
 * the fill a further 10% instead (5.37:1), keeping the text white.
 */

const WHITE = [255, 255, 255]

/** '#rgb' or '#rrggbb' → [r, g, b], or null for anything else. */
function parseHex(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim())
  if (!m) return null
  const hex = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
}

function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

/** WCAG 2 relative luminance. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two '#rgb'/'#rrggbb' colours, or null if either is unparseable. */
export function contrastRatio(a, b) {
  const x = parseHex(a)
  const y = parseHex(b)
  if (!x || !y) return null
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * `color` mixed toward black by `amount` (0–1). A value that is not a hex colour
 * is returned unchanged.
 */
export function darken(color, amount) {
  const rgb = parseHex(color)
  if (!rgb) return color
  return toHex(rgb.map((v) => v * (1 - amount)))
}

/**
 * The fill to put under white text: `color` itself when white already reaches
 * `minRatio` on it, otherwise `color` darkened in 1% steps toward black until it
 * does. Black gives white 21:1, so the loop always ends. A value that is not a
 * hex colour is returned unchanged — there is nothing to measure.
 */
export function fillForWhiteText(color, minRatio = 4.5) {
  const rgb = parseHex(color)
  if (!rgb) return color
  for (let step = 0; step <= 100; step++) {
    const candidate = darken(color, step / 100)
    if (contrastRatio(candidate, toHex(WHITE)) >= minRatio) {
      return step === 0 ? color : candidate
    }
  }
  return '#000000'
}
