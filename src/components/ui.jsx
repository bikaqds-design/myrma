import React from 'react'

// ─── BUTTON ───────────────────────────────────────────────────────────────────
const BTN_BASE =
  'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed'

const BTN_VARIANTS = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500',
  secondary: 'border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 focus:ring-gray-300',
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
      className={`${BTN_BASE} ${BTN_VARIANTS[variant] ?? BTN_VARIANTS.primary} ${BTN_SIZES[size] ?? BTN_SIZES.md} ${className}`}
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
  success: 'bg-green-100 text-green-800',
  danger: 'bg-red-100 text-red-800',
  warning: 'bg-yellow-100 text-yellow-800',
  info: 'bg-blue-100 text-blue-800',
  neutral: 'bg-gray-100 text-gray-700',
  indigo: 'bg-indigo-100 text-indigo-800',
  purple: 'bg-purple-100 text-purple-800',
  teal: 'bg-teal-100 text-teal-800',
  orange: 'bg-orange-100 text-orange-800',
  pink: 'bg-pink-100 text-pink-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  sky: 'bg-sky-100 text-sky-700',
  amber: 'bg-amber-100 text-amber-800',
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
      className={`bg-white rounded-xl border border-gray-200 shadow-sm ${padding ? 'p-6' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  )
}

// ─── FORM FIELDS ──────────────────────────────────────────────────────────────
const INPUT_BASE =
  'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white placeholder-gray-400 ' +
  'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors ' +
  'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed'

export function Input({ className = '', ...props }) {
  return <input className={`${INPUT_BASE} ${className}`} {...props} />
}

export function Select({ className = '', children, ...props }) {
  return (
    <select className={`${INPUT_BASE} ${className}`} {...props}>
      {children}
    </select>
  )
}

export function Textarea({ className = '', rows = 3, ...props }) {
  return <textarea rows={rows} className={`${INPUT_BASE} resize-none ${className}`} {...props} />
}

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
    <div className={`flex items-center justify-between flex-wrap gap-4 ${className}`}>
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            {backLabel}
          </button>
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
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
export function IconButton({ children, className = '', title, ...props }) {
  return (
    <button
      title={title}
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

export function ModalCard({ children, className = '' }) {
  return (
    <div className={`bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-auto ${className}`}>
      {children}
    </div>
  )
}
