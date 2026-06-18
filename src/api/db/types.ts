// Shared return-type aliases for db helpers that guard optional tables.
// Import from here — never inline { missing: boolean; data: T } in helper signatures.

/** Result from a helper that may target an optional (missing) table. T is the type of `data`. */
export type TableResult<T> = { missing: boolean; data: T }

/** Paged result (e.g. notificationLogs.list). T is the element type; data is T[]. */
export type PagedResult<T> = {
  missing: boolean
  data: T[]
  count: number
  page: number
  pageSize: number
  totalPages: number
}

/** Counted result (e.g. notificationQueue.list). T is the element type; data is T[]. */
export type CountedResult<T> = { missing: boolean; data: T[]; count: number }

/** Result from userPreferences.get — uses `prefs` key, not `data`. */
export type PrefsResult = { missing: boolean; prefs?: Record<string, unknown> | null }

/** Result from userPreferences.set — signals table-missing or success/error. */
export type SetPrefsResult = { missing: boolean; error?: unknown }
