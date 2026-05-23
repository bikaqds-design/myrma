import { useState, useEffect } from 'react'

export function useURLTab(paramName, defaultValue, pushHistory = false) {
  const [value, setValue] = useState(() => {
    const p = new URLSearchParams(window.location.search)
    const v = p.get(paramName)
    return v !== null ? v : defaultValue
  })

  const setValueAndURL = (newVal) => {
    const params = new URLSearchParams(window.location.search)
    if (newVal === null || newVal === undefined || newVal === '') {
      params.delete(paramName)
    } else {
      params.set(paramName, String(newVal))
    }
    const qs = params.toString()
    const newURL = window.location.pathname + (qs ? `?${qs}` : '')
    if (pushHistory) {
      window.history.pushState({ [paramName]: newVal }, '', newURL)
    } else {
      window.history.replaceState({ [paramName]: newVal }, '', newURL)
    }
    setValue(newVal)
  }

  useEffect(() => {
    if (!pushHistory) return
    const handler = () => {
      const p = new URLSearchParams(window.location.search)
      const v = p.get(paramName)
      setValue(v !== null ? v : defaultValue)
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [paramName, defaultValue, pushHistory])

  return [value, setValueAndURL]
}
