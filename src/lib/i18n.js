import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { safeStorage } from './safeStorage.js'
import en from '../locales/en.json'

// English is bundled; every other language is fetched the first time it is
// needed. (Audit finding BUG-078.)
//
// Both translation files used to be imported here, so every visitor downloaded
// both languages — 483 KB of JSON, about 40% of the 1.13 MB main chunk — and
// used one. English stays in the bundle because it is the fallback: a key
// missing from another language resolves to it synchronously.
//
// A language that is not bundled comes through the backend below, which i18next
// consults on its own. That is what keeps every call site unchanged:
// `changeLanguage('ar')` waits for the file to arrive before it switches, rather
// than switching first and showing untranslated keys.
const LOADERS = {
  ar: () => import('../locales/ar.json'),
}

export const SUPPORTED_LANGUAGES = ['en', ...Object.keys(LOADERS)]

const lazyBackend = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    const load = LOADERS[language]
    // English is already in the store; with partialBundledLanguages an empty
    // result merges into it rather than replacing it.
    if (!load) return callback(null, {})
    load().then(
      (mod) => callback(null, mod.default ?? mod),
      // An unreachable chunk (offline, or a stale tab after a deploy) falls back
      // to English instead of leaving raw keys on screen.
      (err) => callback(err, null)
    )
  },
}

const saved = safeStorage.get('mrma_language', 'en')

/**
 * Resolves once the saved language is usable. main.jsx renders after this, so an
 * Arabic user never sees a flash of English and a left-to-right layout flipping
 * to right-to-left. For English it resolves at once — nothing is fetched.
 */
export const i18nReady = i18n
  .use(lazyBackend)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    lng: SUPPORTED_LANGUAGES.includes(saved) ? saved : 'en',
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: { escapeValue: false },
  })

export default i18n
