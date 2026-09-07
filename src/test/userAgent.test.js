import { describe, it, expect } from 'vitest'
import { describeUserAgent } from '../lib/userAgent'

describe('describeUserAgent (BUG-049)', () => {
  it('names Chrome on Windows without being fooled by the Safari token', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    )).toBe('Chrome on Windows')
  })

  it('names Edge rather than Chrome, whose token it also carries', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
    )).toBe('Edge on Windows')
  })

  it('names Safari on an iPhone', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
    )).toBe('Safari on iPhone')
  })

  it('names Android rather than Linux, whose token it also carries', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
    )).toBe('Chrome on Android')
  })

  it('names Firefox on macOS', () => {
    expect(describeUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0'
    )).toBe('Firefox on macOS')
  })

  it('returns the half it can identify when only one is recognisable', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows')
    expect(describeUserAgent('curl/8.5.0 Firefox/1.0')).toBe('Firefox')
  })

  it('returns null rather than a fake label when nothing is recognisable', () => {
    // The caller shows its own wording; "Unknown on Unknown" would read as a bug.
    expect(describeUserAgent('curl/8.5.0')).toBeNull()
    expect(describeUserAgent('')).toBeNull()
    expect(describeUserAgent(null)).toBeNull()
    expect(describeUserAgent(undefined)).toBeNull()
  })
})
