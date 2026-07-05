import React from 'react'
import { cn } from '../lib/utils'

// ─── BUTTON ───────────────────────────────────────────────────────────────────
const BTN_BASE =
  'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed'

const BTN_VARIANTS = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500',
  secondary: 'border border-[#e6e9ef] dark:border-[#212a38] text-[#6c6760] dark:text-[#9aa4b2] bg-white dark:bg-transparent hover:bg-[#f4f6f9] dark:hover:bg-[#0f1520] focus:ring-[#4338ca]',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  success: 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500',
  ghost: 'text-gray-600 hover:text-gray-900 hover:bg-gray-100 focus:ring-gray-200',
  warning: 'bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-400',
}

const BTN_SIZES = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  className = '',
  ...props
}) {
  const spinColor = variant === 'secondary' || variant === 'ghost' ? 'gray' : 'white'
  return (
    <button
      className={cn(BTN_BASE, BTN_VARIANTS[variant] ?? BTN_VARIANTS.primary, BTN_SIZES[size] ?? BTN_SIZES.md, className)}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Spinner size="sm" color={spinColor} />}
      {children}
    </button>
  )
}

// ─── SPINNER ──────────────────────────────────────────────────────────────────
const SPINNER_SIZES = {
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-8 h-8 border-[3px]',
  xl: 'w-10 h-10 border-4',
}

const SPINNER_COLORS = {
  indigo: 'border-indigo-600 border-t-transparent',
  white: 'border-white border-t-transparent',
  gray: 'border-gray-400 border-t-transparent',
}

export function Spinner({ size = 'md', color = 'indigo', className = '' }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`animate-spin rounded-full flex-shrink-0 ${SPINNER_SIZES[size] ?? SPINNER_SIZES.md} ${SPINNER_COLORS[color] ?? SPINNER_COLORS.indigo} ${className}`}
    />
  )
}

// ─── PAGE LOADING ─────────────────────────────────────────────────────────────
export function PageLoading({ message }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[320px] gap-3">
      <Spinner size="lg" />
      {message && <p className="text-sm text-gray-500">{message}</p>}
    </div>
  )
}

// ─── BADGE ────────────────────────────────────────────────────────────────────
const BADGE_VARIANTS = {
  success: 'bg-green-100 dark:bg-green-900/20 text-green-800 dark:text-green-400',
  danger: 'bg-red-100 dark:bg-red-900/20 text-red-800 dark:text-red-400',
  warning: 'bg-yellow-100 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-400',
  info: 'bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-400',
  neutral: 'bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#9aa4b2]',
  indigo: 'bg-indigo-100 dark:bg-indigo-900/20 text-indigo-800 dark:text-indigo-400',
  purple: 'bg-purple-100 dark:bg-purple-900/20 text-purple-800 dark:text-purple-400',
  teal: 'bg-teal-100 dark:bg-teal-900/20 text-teal-800 dark:text-teal-400',
  orange: 'bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-400',
  pink: 'bg-pink-100 dark:bg-pink-900/20 text-pink-800 dark:text-pink-400',
  emerald: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-400',
  sky: 'bg-sky-100 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400',
  amber: 'bg-amber-100 dark:bg-amber-900/20 text-amber-800 dark:text-amber-400',
}

export function Badge({ variant = 'neutral', dot = false, children, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${BADGE_VARIANTS[variant] ?? BADGE_VARIANTS.neutral} ${className}`}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  )
}

// ─── CARD ─────────────────────────────────────────────────────────────────────
export function Card({ children, className = '', padding = true, ...props }) {
  return (
    <div
      className={`bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] ${padding ? 'p-[18px]' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  )
}

// ─── STATUS PILL ──────────────────────────────────────────────────────────────
const STATUS_PILL_COLORS = {
  Open:          '#3b82f6',
  'In Progress': '#6366f1',
  Pending:       '#f59e0b',
  'On Hold':     '#eab308',
  Completed:     '#14b8a6',
  Closed:        '#10b981',
  Cancelled:     '#94a3b8',
  Overdue:       '#ef4444',
}

export function StatusPill({ status, className = '' }) {
  const color = STATUS_PILL_COLORS[status] || '#94a3b8'
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 10px', borderRadius: 9999,
        fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap',
        color, background: color + '1e', flexShrink: 0,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color, display: 'inline-block', flexShrink: 0 }} />
      {status}
    </span>
  )
}

// ─── FORM FIELDS ──────────────────────────────────────────────────────────────
const INPUT_BASE =
  'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white placeholder-gray-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors ' +
  'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed'

// forwardRef so react-hook-form's register() ref attaches to the DOM node —
// without it the ref is silently dropped and RHF never reads the value.
export const Input = React.forwardRef(function Input({ className = '', ...props }, ref) {
  return <input ref={ref} className={cn(INPUT_BASE, className)} {...props} />
})

export const Select = React.forwardRef(function Select({ className = '', children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(INPUT_BASE, className)} {...props}>
      {children}
    </select>
  )
})

export const Textarea = React.forwardRef(function Textarea(
  { className = '', rows = 3, ...props },
  ref
) {
  return (
    <textarea ref={ref} rows={rows} className={cn(INPUT_BASE, 'resize-none', className)} {...props} />
  )
})

// ─── LABEL ────────────────────────────────────────────────────────────────────
export function Label({ children, required, htmlFor, className = '' }) {
  return (
    <label
      htmlFor={htmlFor}
      className={`block text-sm font-medium text-gray-700 mb-1 ${className}`}
    >
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  )
}

// ─── PAGE HEADER ──────────────────────────────────────────────────────────────
export function PageHeader({
  title,
  subtitle,
  children,
  onBack,
  backLabel = 'Back',
  className = '',
}) {
  return (
    <div className={`flex items-center justify-between flex-wrap gap-4 mb-6 ${className}`}>
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            aria-label={backLabel}
            className="flex items-center gap-1.5 text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] transition-colors"
          >
            <svg className="w-4 h-4" aria-hidden="true" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            {backLabel}
          </button>
        )}
        <div>
          <h1 className="text-[22px] font-[750] tracking-[-0.4px] text-[#211f1b] dark:text-[#e8ebf0] m-0 leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[13px] text-[#6c6760] dark:text-[#9aa4b2] mt-0.5 m-0">{subtitle}</p>
          )}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

// ─── SECTION TITLE ────────────────────────────────────────────────────────────
export function SectionTitle({ children, className = '' }) {
  return (
    <h2 className={`text-sm font-semibold text-gray-500 uppercase tracking-wide ${className}`}>
      {children}
    </h2>
  )
}

// ─── DIVIDER ──────────────────────────────────────────────────────────────────
export function Divider({ className = '' }) {
  return <div className={`border-t border-gray-200 ${className}`} />
}

// ─── ICON BUTTON ──────────────────────────────────────────────────────────────
export function IconButton({ children, className = '', title, 'aria-label': ariaLabel, ...props }) {
  return (
    <button
      title={title}
      aria-label={ariaLabel ?? title}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

// ─── MODAL SHELL ──────────────────────────────────────────────────────────────
export function ModalOverlay({ children, onClose }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 overflow-y-auto py-8 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      {children}
    </div>
  )
}

export function ModalCard({ children, className = '', 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy, ...props }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={`bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-auto ${className}`}
      {...props}
    >
      {children}
    </div>
  )
}
