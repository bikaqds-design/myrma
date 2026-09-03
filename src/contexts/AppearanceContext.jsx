import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { db } from '../api/supabaseClient'
import { supabase } from '../api/client'
import { safeStorage } from '../lib/safeStorage'
import i18n from '../lib/i18n.js'
import toast from 'react-hot-toast'
import { captureException } from '../lib/sentry'

const DEFAULT = {
  darkMode: false,
  fontFamily: 'inter',
  tableDensity: 'comfortable',
  sidebarCompact: false,
  loginBg: '#eef2ff',
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '24h',
  faviconUrl: '',
  tabTitle: 'myCRM',
  // No dashboardWidgets default here any more. It was a hardcoded ten-id array
  // used as the Dashboard's fallback, and because nothing ever wrote to it, it
  // silently capped every account at the ten widgets that existed when it was
  // typed — hiding the entire CRM section. Widget visibility is a per-user
  // preference resolved in lib/dashboardWidgets against the live catalog.
}

const FONT_STACKS = {
  hanken: "'Hanken Grotesk', system-ui, -apple-system, sans-serif",
  inter: "'Inter', system-ui, -apple-system, sans-serif",
  roboto: "'Roboto', system-ui, sans-serif",
  opensans: "'Open Sans', system-ui, sans-serif",
  poppins: "'Poppins', system-ui, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
}

const GOOGLE_FONTS = {
  hanken: 'Hanken+Grotesk:wght@400;500;600;700;800',
  inter: 'Inter:wght@400;500;600;700',
  roboto: 'Roboto:wght@400;500;700',
  opensans: 'Open+Sans:wght@400;500;600;700',
  poppins: 'Poppins:wght@400;500;600;700',
}

/**
 * Which appearance keys belong to the person, and which to the company.
 *
 * These all lived in one global `rma_config` row keyed only by config_key, so
 * one user turning on dark mode turned it on for everyone, along with their
 * font and date format (UX-DARK-001). On a multi-user CRM that is a defect: a
 * technician changing their theme silently changed the finance team's.
 *
 * The split is by what the setting actually is, not by who is allowed to change
 * it. A favicon and a login background are the company's identity and belong in
 * one place. Dark mode and table density are how one person prefers to read.
 *
 * The global row is kept as the ORG DEFAULT rather than emptied, and personal
 * values layer on top. That means nothing changes for anyone on first load, no
 * backfill is required, and an admin setting the house date format still sets
 * it for everyone who has not chosen their own.
 */
const PERSONAL_KEYS = ['darkMode', 'fontFamily', 'tableDensity', 'sidebarCompact', 'dateFormat', 'timeFormat']
const isPersonal = (k) => PERSONAL_KEYS.includes(k)

const pick = (obj, keys) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)))

const CAIRO_FONT_STACK = "'Cairo', system-ui, sans-serif"

const AppearanceContext = createContext({
  ...DEFAULT,
  language: 'en',
  updateAppearance: () => {},
  setLanguage: () => {},
  formatDate: (d) => d || '',
  formatDateTime: (d) => d || '',
})

export function AppearanceProvider({ children }) {
  const [settings, setSettings] = useState(() => ({
    ...DEFAULT,
    ...safeStorage.get('mrma_appearance', {}),
  }))

  const [language, setLanguageState] = useState(() => safeStorage.get('mrma_language', 'en'))

  // Org defaults first, then this person's overrides on top. Resolution order is
  // DEFAULT -> company -> personal, so a preference someone has actually chosen
  // always wins, and everyone else inherits the house setting.
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      let org = {}
      try {
        const result = await db.rmaConfig.getAll()
        if (!result.missing) {
          const row = result.data.find((r) => r.config_key === 'appearance_settings')
          if (row?.config_value) org = row.config_value
        }
      } catch { /* keep the defaults */ }

      let personal = {}
      try {
        const { data } = await supabase.auth.getSession()
        const email = data?.session?.user?.email
        if (email) {
          const res = await db.userPreferences.get(email)
          // A missing table means the deployment predates per-user preferences;
          // the org values alone are then correct, not an error.
          if (!res.missing && res.prefs) personal = pick(res.prefs.appearance || {}, PERSONAL_KEYS)
        }
      } catch { /* fall back to the org settings */ }

      if (cancelled) return
      const merged = { ...DEFAULT, ...org, ...personal }
      setSettings(merged)
      safeStorage.set('mrma_appearance', merged)
    }

    load()
    // Re-resolve on sign-in, so switching account does not leave the previous
    // person's theme in place.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') load()
    })
    return () => {
      cancelled = true
      sub?.subscription?.unsubscribe()
    }
  }, [])

  useEffect(() => {
    applySettings(settings)
    safeStorage.set('mrma_appearance', settings)
  }, [settings])

  const applySettings = (s) => {
    const html = document.documentElement
    html.classList.toggle('dark', !!s.darkMode)
    html.setAttribute('data-density', s.tableDensity || 'comfortable')
    document.body.style.fontFamily = FONT_STACKS[s.fontFamily] || FONT_STACKS.inter
    document.title = s.tabTitle || 'myCRM'
    if (s.fontFamily && s.fontFamily !== 'system' && GOOGLE_FONTS[s.fontFamily]) {
      const id = `gfont-${s.fontFamily}`
      // Remove any previously injected Google Font links other than the current one
      document.querySelectorAll('link[id^="gfont-"]').forEach((el) => {
        if (el.id !== id) el.remove()
      })
      if (!document.getElementById(id)) {
        const link = document.createElement('link')
        link.id = id
        link.rel = 'stylesheet'
        link.href = `https://fonts.googleapis.com/css2?family=${GOOGLE_FONTS[s.fontFamily]}&display=swap`
        document.head.appendChild(link)
      }
    } else {
      // Switched to system font — clean up any leftover gfont links
      document.querySelectorAll('link[id^="gfont-"]').forEach((el) => el.remove())
    }
    if (s.faviconUrl) {
      let favicon = document.querySelector("link[rel*='icon']")
      if (!favicon) {
        favicon = document.createElement('link')
        favicon.rel = 'icon'
        document.head.appendChild(favicon)
      }
      favicon.href = s.faviconUrl
    }
  }

  // Apply RTL direction and Arabic font when language changes
  useEffect(() => {
    const html = document.documentElement
    const isRTL = language === 'ar'
    html.setAttribute('dir', isRTL ? 'rtl' : 'ltr')
    html.setAttribute('lang', language)
    if (isRTL) {
      const id = 'gfont-cairo'
      if (!document.getElementById(id)) {
        const link = document.createElement('link')
        link.id = id
        link.rel = 'stylesheet'
        link.href = 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800&display=swap'
        document.head.appendChild(link)
      }
      document.body.style.fontFamily = CAIRO_FONT_STACK
    } else {
      document.body.style.fontFamily = FONT_STACKS[settings.fontFamily] || FONT_STACKS.inter
    }
  }, [language, settings.fontFamily])

  const setLanguage = useCallback((lang) => {
    safeStorage.set('mrma_language', lang)
    i18n.changeLanguage(lang)
    setLanguageState(lang)
  }, [])

  // The local update is optimistic so the interface responds immediately. When
  // the write failed, the empty catch meant the change simply reverted on the
  // next load with nothing said — the user reasonably concluded the setting
  // "doesn't stick" rather than that saving had failed.
  //
  // Returns whether it persisted, so a caller can react; reports either way.
  const updateAppearance = async (partial, userEmail) => {
    const merged = { ...settings, ...partial }
    setSettings(merged)

    // Personal keys go to this user's own row; company keys stay global. A change
    // touching both writes both.
    const personal = pick(partial, PERSONAL_KEYS)
    const org = Object.fromEntries(Object.entries(partial).filter(([k]) => !isPersonal(k)))

    try {
      if (Object.keys(personal).length && userEmail) {
        const existing = await db.userPreferences.get(userEmail)
        const prefs = existing.missing ? {} : existing.prefs || {}
        await db.userPreferences.set(userEmail, {
          ...prefs,
          appearance: { ...(prefs.appearance || {}), ...personal },
        })
      }
      if (Object.keys(org).length) {
        // Merge into the stored org row rather than writing the merged view,
        // which would push this person's theme into the company defaults.
        const result = await db.rmaConfig.getAll()
        const row = result.missing
          ? null
          : result.data.find((r) => r.config_key === 'appearance_settings')
        await db.rmaConfig.set('appearance_settings', { ...(row?.config_value || {}), ...org }, userEmail)
      }
      return true
    } catch (error) {
      captureException(error, { context: 'AppearanceContext/updateAppearance' })
      toast(i18n.t('appearance.saveFailed'), { icon: '⚠️' })
      return false
    }
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    if (isNaN(d)) return String(dateStr)
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const yyyy = d.getFullYear()
    switch (settings.dateFormat) {
      case 'MM/DD/YYYY':
        return `${mm}/${dd}/${yyyy}`
      case 'YYYY-MM-DD':
        return `${yyyy}-${mm}-${dd}`
      case 'DD-MM-YYYY':
        return `${dd}-${mm}-${yyyy}`
      default:
        return `${dd}/${mm}/${yyyy}`
    }
  }

  const formatDateTime = (dateStr) => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    if (isNaN(d)) return String(dateStr)
    const datePart = formatDate(dateStr)
    let h = d.getHours()
    const m = String(d.getMinutes()).padStart(2, '0')
    if (settings.timeFormat === '12h') {
      const ampm = h >= 12 ? 'PM' : 'AM'
      h = h % 12 || 12
      return `${datePart} ${h}:${m} ${ampm}`
    }
    return `${datePart} ${String(h).padStart(2, '0')}:${m}`
  }

  return (
    <AppearanceContext.Provider
      value={{ ...settings, language, updateAppearance, setLanguage, formatDate, formatDateTime }}
    >
      {children}
    </AppearanceContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAppearance = () => useContext(AppearanceContext)
