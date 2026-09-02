/**
 * Modal.jsx — accessible modal dialog built on @radix-ui/react-dialog.
 *
 * Provides:
 *  - Focus trap (keyboard cannot escape while open)
 *  - Escape key closes
 *  - Screen-reader announcements via role="dialog" + aria-labelledby
 *  - Scroll-lock on <body>
 *  - Dark-mode aware overlay + panel
 *
 * Usage:
 *   <Modal open={showModal} onClose={() => setShowModal(false)} title="Edit product">
 *     <p>Modal body here</p>
 *   </Modal>
 *
 *   // Without header (custom layout inside)
 *   <Modal open={open} onClose={onClose} title="Details" hideHeader>
 *     <CustomHeader />
 *   </Modal>
 */
import * as Dialog from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'

export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  /** Extra Tailwind classes for the panel (e.g. 'max-w-2xl') */
  className = '',
  /** Hide the built-in title bar — useful when the child renders its own header */
  hideHeader = false,
  /** Allow the panel to scroll internally (default true) */
  scrollable = true,
  /** Remove the default p-6 padding — for modals with custom internal layout */
  noPadding = false,
}) {
  const { t } = useTranslation()
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        {/* Backdrop */}
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />

        {/* Panel */}
        <Dialog.Content
          className={[
            'fixed start-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
            'z-50 w-full max-w-lg',
            'bg-white dark:bg-[#121823]',
            'rounded-2xl shadow-xl',
            'border border-gray-200 dark:border-[#212a38]',
            noPadding ? '' : 'p-6',
            scrollable ? 'overflow-y-auto max-h-[90vh]' : '',
            'focus:outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
            'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
            className,
          ]
            .filter(Boolean)
            .join(' ')}
          aria-describedby={description ? 'modal-description' : undefined}
        >
          {/*
            `hideHeader` used to skip the Dialog.Title entirely. Radix warns
            about that on every open — "DialogContent requires a DialogTitle" —
            and the warning is right: without one the dialog has no accessible
            name, so a screen reader announces it as just "dialog". 13 modals
            across Products, RMA Tickets and User Management set hideHeader
            because they draw their own header, and every one of them was
            unnamed. The docstring above promised aria-labelledby regardless.

            The title is still rendered, just visually hidden — sr-only rather
            than `display: none`, which would hide it from assistive tech too
            and defeat the point.
          */}
          {hideHeader && title && (
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
          )}

          {!hideHeader && (
            <div className="flex items-start justify-between gap-4 mb-5">
              <Dialog.Title className="text-lg font-semibold text-gray-900 dark:text-white leading-snug">
                {title}
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  aria-label={t('emptyState.close')}
                  className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-[#9aa4b2] dark:hover:text-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </Dialog.Close>
            </div>
          )}

          {description && (
            <p id="modal-description" className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-4">
              {description}
            </p>
          )}

          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
