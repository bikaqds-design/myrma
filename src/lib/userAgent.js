/**
 * A readable device name from a User-Agent string. (Audit finding BUG-049.)
 *
 * The sessions list exists so someone can recognise their own devices and spot
 * one they do not recognise. A raw User-Agent does not support that judgement —
 * every modern browser claims to be Mozilla, Safari and Chrome at once — so it
 * is reduced to the two things a person actually recognises: which browser and
 * which platform.
 *
 * Deliberately a small ordered table rather than a UA-parsing dependency. The
 * consequence of getting a device name slightly wrong is a slightly worse
 * label; it is not worth a library that needs updating every browser release.
 *
 * Order matters in both lists — Edge's UA contains "Chrome", Chrome's contains
 * "Safari", and Android's contains "Linux — so the more specific token has to
 * be tested first.
 */

const BROWSERS = [
  [/\bEdgA?\//i, 'Edge'],
  [/\bOPR\/|\bOpera\//i, 'Opera'],
  [/\bSamsungBrowser\//i, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//i, 'Firefox'],
  [/\bCriOS\//i, 'Chrome'],
  [/\bChrome\//i, 'Chrome'],
  [/\bSafari\//i, 'Safari'],
]

const PLATFORMS = [
  [/\biPhone\b/i, 'iPhone'],
  [/\biPad\b/i, 'iPad'],
  [/\bAndroid\b/i, 'Android'],
  [/\bWindows NT\b/i, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'macOS'],
  [/\bCrOS\b/i, 'ChromeOS'],
  [/\bLinux\b/i, 'Linux'],
]

function firstMatch(table, ua) {
  for (const [re, label] of table) if (re.test(ua)) return label
  return null
}

/**
 * "Chrome on Windows", or whichever half could be identified, or null when
 * neither could. Callers show their own fallback text for null rather than
 * printing "Unknown on Unknown", which tells the reader nothing and looks broken.
 */
export function describeUserAgent(value) {
  const ua = typeof value === 'string' ? value : ''
  if (!ua.trim()) return null
  const browser = firstMatch(BROWSERS, ua)
  const platform = firstMatch(PLATFORMS, ua)
  if (browser && platform) return `${browser} on ${platform}`
  return browser || platform
}
