import React, { useCallback, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

/**
 * Replacement for `window.confirm`.
 *
 * Ten call sites across seven files guarded destructive actions with the native
 * dialog:
 *
 *     if (!window.confirm(t('leads.bulkDeleteConfirm', { count }))) return
 *
 * It works, which is why it survived, but it is the wrong dialog for this app.
 * It ignores the theme, blocks the main thread, cannot be styled, and — the part
 * that actually matters here — its buttons are drawn by the browser in the
 * *browser's* locale. An Arabic user got a right-to-left page interrupted by a
 * left-to-right box with English OK/Cancel. It is also unreachable from the
 * automated tests, which is how a QA run mistook one for a dead button.
 *
 * The app already had ConfirmDialog for exactly this. What it did not have was a
 * cheap way to use it: each call site needs open/title/message/onConfirm state
 * plus the element rendered somewhere in the tree, which is a dozen lines of
 * boilerplate per file and the reason `window.confirm` kept winning.
 *
 *     const { confirm, confirmDialog } = useConfirm()
 *     ...
 *     confirm({
 *       title: t('leads.bulkDeleteTitle'),
 *       message: t('leads.bulkDeleteConfirm', { count }),
 *       onConfirm: async () => { ...the work... },
 *     })
 *     ...
 *     return (<>{...page...}{confirmDialog}</>)
 *
 * Note the shape change this forces on callers: `window.confirm` was a
 * synchronous guard that let the work stay inline after an early return, and
 * this is a callback. The work moves into `onConfirm`. That is not incidental —
 * a promise-returning `confirm()` would have preserved the old shape, but it
 * also hides a suspended continuation behind an await, and the early-return
 * guard reads clearly only because it is synchronous. Explicit is better here.
 */
export function useConfirm() {
  const [state, setState] = useState({
    open: false,
    title: '',
    message: '',
    confirmLabel: undefined,
    onConfirm: null,
  })

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), [])

  const confirm = useCallback(({ title, message, confirmLabel, onConfirm }) => {
    setState({ open: true, title, message, confirmLabel, onConfirm })
  }, [])

  const handleConfirm = useCallback(() => {
    // Close first so the dialog cannot be double-fired by an impatient second
    // click while an async onConfirm is still running.
    setState((s) => ({ ...s, open: false }))
    state.onConfirm?.()
  }, [state])

  const confirmDialog = (
    <ConfirmDialog
      open={state.open}
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      onConfirm={handleConfirm}
      onCancel={close}
    />
  )

  return { confirm, confirmDialog }
}
