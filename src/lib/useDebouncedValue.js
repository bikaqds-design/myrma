import { useEffect, useState } from 'react'

/**
 * `value`, once it has stopped changing for `delay` ms.
 *
 * For search boxes that query the database: typing "acme" should send one
 * request, not four. The input stays bound to the live value, so what the user
 * types appears at once; only the query waits.
 */
export function useDebouncedValue(value, delay = 300) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return settled
}

export default useDebouncedValue
