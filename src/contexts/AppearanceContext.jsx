import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { db } from '../api/supabaseClient'
import { safeStorage } from '../lib/safeStorage'
import i18n from '../lib/i18n.js'

const DEFAULT = {
  darkMode: false,
  fontFamily: 'inter',
  tableDensity: 'comfortable',
  sidebarCompact: false,
  loginBg: '#eef2ff',
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '24h',
  faviconUrl: '',
  tabTitle: 'myRMA',
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

  useEffect(() => {
    db.rmaConfig
      .getAll()
      .then((result) => {
        if (result.missing) return
        const row = result.data.find((r) => r.config_key === 'appearance_settings')
        if (row?.config_value) {
          const merged = { ...DEFAULT, ...row.config_value }
          setSettings(merged)
          safeStorage.set('mrma_appearance', merged)
        }
      })
      .catch(() => {})
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
    document.title = s.tabTitle || 'myRMA'
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

  const updateAppearance = async (partial, userEmail) => {
    const merged = { ...settings, ...partial }
    setSettings(merged)
    try {
      await db.rmaConfig.set('appearance_settings', merged, userEmail)
    } catch {}
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
