import React from 'react'
import { captureException } from '../lib/sentry.js'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null, copied: false }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Render error:', error, info)
    this.setState({ info })
    captureException(error, { componentStack: info?.componentStack })
  }

  handleReload = () => {
    window.location.reload()
  }

  handleHome = () => {
    window.history.replaceState({}, '', '/')
    window.location.reload()
  }

  // Full crash report — safe to share. Lets a user copy/paste the error from
  // production (where we don't render the raw stack) so it can be diagnosed.
  buildReport = () => {
    const { error, info } = this.state
    return [
      `Error: ${error?.message || String(error)}`,
      '',
      'Stack:',
      error?.stack || '(none)',
      '',
      'Component stack:',
      info?.componentStack || '(none)',
      '',
      `URL: ${window.location.href}`,
      `Time: ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
    ].join('\n')
  }

  handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(this.buildReport())
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    } catch {
      // Clipboard blocked — surface the report in a prompt as a fallback
      window.prompt('Copy the crash details below:', this.buildReport())
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    const isDev = import.meta.env.DEV
    const message = this.state.error?.message || String(this.state.error)

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#0b0f17] p-6">
        <div className="max-w-lg w-full bg-white dark:bg-[#121823] rounded-xl shadow-lg border border-red-200 dark:border-red-900 p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-red-100 dark:bg-red-900/40 rounded-full flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-[#e8ebf0]">
                Something went wrong
              </h1>
              <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">
                The page crashed unexpectedly.
              </p>
            </div>
          </div>

          {/* Error message is shown in production too — it's safe and makes the
              crash diagnosable. The full stack stays dev-only. */}
          <div className="mt-4 mb-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/50 p-3">
            <p className="text-sm font-mono text-red-700 dark:text-red-300 break-words">
              {message}
            </p>
          </div>

          {isDev && (
            <details className="mt-2 mb-2 text-xs">
              <summary className="cursor-pointer text-gray-600 dark:text-[#9aa4b2] font-medium mb-2">
                Full stack (dev only)
              </summary>
              <pre className="bg-gray-50 dark:bg-[#0b0f17] border border-gray-200 dark:border-[#212a38] rounded-lg p-3 overflow-auto text-red-700 dark:text-red-300 whitespace-pre-wrap break-all">
                {String(this.state.error?.stack || this.state.error)}
                {this.state.info?.componentStack || ''}
              </pre>
            </details>
          )}

          <button
            onClick={this.handleCopy}
            className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            {this.state.copied ? 'Copied!' : 'Copy error details'}
          </button>

          <div className="flex gap-2 mt-6">
            <button
              onClick={this.handleReload}
              className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Reload page
            </button>
            <button
              onClick={this.handleHome}
              className="flex-1 px-4 py-2 bg-gray-100 dark:bg-[#1a2230] hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-[#e8ebf0] rounded-lg text-sm font-medium transition-colors"
            >
              Go to dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }
}
