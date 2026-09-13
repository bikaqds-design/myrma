import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppearanceProvider } from './contexts/AppearanceContext.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { initSentry } from './lib/sentry.js'
import App from './App.jsx'
import './index.css'
import './styles/tokens.css'
import './styles/appearance.css'
import './styles/rtl.css'
import { i18nReady } from './lib/i18n.js'

initSentry() // no-op if VITE_SENTRY_DSN is not set

// @axe-core/react: dev-only accessibility violation logger — never included in production builds
if (import.meta.env.DEV) {
  import('@axe-core/react').then((axe) => axe.default(React, ReactDOM, 1000))
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 min — stale data shows instantly on re-visit; background refetch starts
      retry: 1,
      refetchOnWindowFocus: false, // avoid surprise refetches when user alt-tabs back
    },
  },
})

// Render once the saved language is ready. Only a non-English choice fetches
// anything; an English visitor renders on the next tick, exactly as before. A
// language file that fails to load still renders, in English. (BUG-078.)
const render = () =>
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <QueryClientProvider client={queryClient}>
            <AppearanceProvider>
              <App />
            </AppearanceProvider>
          </QueryClientProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  )

i18nReady.then(render, render)
