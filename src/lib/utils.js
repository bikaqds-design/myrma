import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

// The "who" columns store emails (user_roles has no display name). Derive a
// readable name from the local-part for documents: sara.mostafa@x → Sara Mostafa.
export function nameFromEmail(email) {
  if (!email) return '—'
  const local = String(email).split('@')[0]
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return name || String(email)
}
