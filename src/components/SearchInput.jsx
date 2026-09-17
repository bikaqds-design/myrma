import React, { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../lib/utils'

/**
 * The list search box: magnifier, `type="search"`, and a clear (✕) button while
 * there is text. (UI audit UX-SEARCH-002 — search boxes had no way to clear
 * them, and only 2 of ~32 were `type="search"`, so the mobile search keyboard
 * and the browser's own clear control were both missing.)
 *
 * The browser's native clear button is hidden in index.css so there is exactly
 * one, drawn the same way in every browser and placed for RTL.
 *
 *   <SearchInput value={q} onChange={setQ} placeholder={t('customers.searchPlaceholder')} />
 *
 * `onChange` receives the string, not the event. `onClear` runs after the value
 * is cleared — for a form whose applied search differs from what is typed.
 */
const SEARCH_INPUT_BASE =
  'w-full ps-9 pe-9 py-2 border border-[#e6e9ef] dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] rounded-lg text-sm focus:ring-2 focus:ring-[#4338ca] focus:border-transparent outline-none placeholder:text-[#746f65] dark:placeholder:text-[#a4acb7]'

export const SearchInput = React.forwardRef(function SearchInput(
  { value, onChange, onClear, placeholder, 'aria-label': ariaLabel, className = '', inputClassName, ...props },
  ref
) {
  const { t } = useTranslation()
  const localRef = useRef(null)

  function setRefs(node) {
    localRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }

  function clear() {
    onChange('')
    onClear?.()
    localRef.current?.focus()
  }

  return (
    <div className={cn('relative', className)}>
      <input
        ref={setRefs}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        // A placeholder is not an accessible name; fall back to it only when the
        // caller gives no label.
        aria-label={ariaLabel ?? placeholder}
        className={cn(inputClassName ?? SEARCH_INPUT_BASE, 'search-input ps-9 pe-9')}
        {...props}
      />
      <svg
        aria-hidden="true"
        className="w-4 h-4 text-[#6c6760] dark:text-[#9aa4b2] absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      {value ? (
        <button
          type="button"
          onClick={clear}
          // Keep focus in the field, so clearing and typing again is one motion.
          onMouseDown={(e) => e.preventDefault()}
          aria-label={t('common.clear')}
          title={t('common.clear')}
          className="absolute end-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] hover:bg-[#f4f6f9] dark:hover:bg-[#121823] focus:outline-none focus:ring-2 focus:ring-[#4338ca]"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </div>
  )
})

export default SearchInput
