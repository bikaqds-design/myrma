import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Render error:', error, info)
    this.setState({ info })
  }

  handleReload = () => {
    window.location.reload()
  }

  handleHome = () => {
    window.history.replaceState({}, '', '/')
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children

    const isDev = import.meta.env.DEV

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900 p-6">
        <div className="max-w-lg w-full bg-white dark:bg-slate-800 rounded-xl shadow-lg border border-red-200 dark:border-red-900 p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-red-100 dark:bg-red-900/40 rounded-full flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-slate-100">Something went wrong</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400">The page crashed unexpectedly.</p>
            </div>
          </div>

          {isDev && (
            <details className="mt-4 mb-6 text-xs">
              <summary className="cursor-pointer text-gray-600 dark:text-slate-300 font-medium mb-2">Error details (dev only)</summary>
              <pre className="bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg p-3 overflow-auto text-red-700 dark:text-red-300 whitespace-pre-wrap break-all">
                {String(this.state.error?.stack || this.state.error)}
              </pre>
            </details>
          )}

          <div className="flex gap-2 mt-6">
            <button
              onClick={this.handleReload}
              className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Reload page
            </button>
            <button
              onClick={this.handleHome}
              className="flex-1 px-4 py-2 bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors"
            >
              Go to dashboard
            </button>
          </div>
        </div>
      </div>
    )
  }
}
