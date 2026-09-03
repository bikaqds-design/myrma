/**
 * Reports the UI guard-rail violations (UX-GLOBAL-001 / 004) and the ratchet.
 *
 * These rules are warnings, not errors, because the codebase starts with a
 * large existing count. `lint:ci` caps the total, so the number can fall and
 * never rise. When it reaches zero the rules become errors.
 */
import fs from 'fs'

const RATCHET = 2395
const report = JSON.parse(fs.readFileSync('eslint-ui.json', 'utf8'))
const hits = report.flatMap(f =>
  f.messages
    .filter(m => m.ruleId === 'no-restricted-syntax')
    .map(m => ({ file: f.filePath, line: m.line, message: m.message }))
)
const hex = hits.filter(h => h.message.includes('design token')).length
const text = hits.filter(h => h.message.includes('Hardcoded user-visible')).length
const physical = hits.length - hex - text

console.log(`UI guard violations: ${hits.length}  (physical: ${physical}, raw hex: ${hex}, hardcoded text: ${text})`)
console.log(`Ratchet in lint:ci:  ${RATCHET}`)
if (hits.length > RATCHET) {
  console.error(`\nThis is ABOVE the ratchet. Lower lint:ci only when the count drops.`)
  process.exit(1)
}
if (hits.length < RATCHET) {
  console.log(`\n${RATCHET - hits.length} below the ratchet — lower lint:ci to ${hits.length}.`)
}
