// Wrapper around localStorage that silently handles quota errors and Safari
// private-mode restrictions — both throw when raw localStorage is accessed.
export const safeStorage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {}
  },
}
