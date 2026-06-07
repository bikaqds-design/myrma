import { useSearchParams } from 'react-router-dom'

export function useURLTab(paramName, defaultValue, pushHistory = false) {
  const [searchParams, setSearchParams] = useSearchParams()
  const value = searchParams.get(paramName) ?? defaultValue

  const setValueAndURL = (newVal) => {
    const params = new URLSearchParams(searchParams)
    if (newVal === null || newVal === undefined || newVal === '') {
      params.delete(paramName)
    } else {
      params.set(paramName, String(newVal))
    }
    setSearchParams(params, { replace: !pushHistory })
  }

  return [value, setValueAndURL]
}
