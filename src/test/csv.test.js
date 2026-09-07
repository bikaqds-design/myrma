/**
 * csv.test.js — BUG-044.
 *
 * Three separate hand-rolled CSV encoders escaped quotes and nothing else, so a
 * value beginning `=`, `+`, `-` or `@` executed as a formula when the export
 * was opened in Excel. The values are not ours: lead and customer names arrive
 * from sales reps, bulk imports and the public RMA tracker.
 */
import { describe, it, expect } from 'vitest'
import { csvCell, toCsv, isFormulaLike } from '../lib/csv'

describe('csvCell — formula neutralisation', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['=HYPERLINK("http://evil","click")', `"'=HYPERLINK(""http://evil"",""click"")"`],
    ['+1', "'+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    // A tab is not a CSV delimiter, so this needs the ' prefix but no quoting.
    ['\t=1+1', "'\t=1+1"],
  ])('neutralises %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected)
  })

  it('neutralises the classic command-execution payload', () => {
    // No comma, quote or newline in it, so it is prefixed but not quoted.
    expect(csvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0")
  })

  it('leaves ordinary text alone', () => {
    expect(csvCell('Acme Trading')).toBe('Acme Trading')
    expect(csvCell('')).toBe('')
    expect(csvCell(null)).toBe('')
  })
})

describe('csvCell — must not mangle real data', () => {
  it('does not prefix negative numbers, which would break financial sums', () => {
    expect(csvCell('-1234.50')).toBe('-1234.50')
    expect(csvCell(-42)).toBe('-42')
    expect(csvCell('-7')).toBe('-7')
  })

  it('still neutralises a minus-led value that is not a number', () => {
    expect(csvCell('-2+3+cmd|x')).toBe("'-2+3+cmd|x")
  })

  it('leaves numbers and booleans untouched', () => {
    expect(isFormulaLike(5)).toBe(false)
    expect(isFormulaLike(true)).toBe(false)
  })
})

describe('csvCell — RFC 4180 quoting still holds', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""')
  })

  it('quotes values containing a comma or newline', () => {
    expect(csvCell('Cairo, Egypt')).toBe('"Cairo, Egypt"')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })

  it('quotes a value containing a carriage return', () => {
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })
})

describe('toCsv', () => {
  it('encodes headers and rows with CRLF separators', () => {
    expect(toCsv(['Name', 'Total'], [['Acme', '10'], ['Beta', '20']])).toBe(
      'Name,Total\r\nAcme,10\r\nBeta,20',
    )
  })

  it('protects a malicious value anywhere in the grid', () => {
    const csv = toCsv(['Name'], [['=1+1']])
    expect(csv).toContain("'=1+1")
    expect(csv).not.toMatch(/(^|,)=1\+1/m)
  })

  it('escapes a comma in a field so later columns do not shift', () => {
    // The Audit Log exporter did not escape user_email or action_type at all.
    const csv = toCsv(['User', 'Action'], [['a,b@x.com', 'login']])
    expect(csv).toBe('User,Action\r\n"a,b@x.com",login')
  })
})
