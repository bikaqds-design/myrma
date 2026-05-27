import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initSentry } from './lib/sentry.js'

initSentry() // no-op if VITE_SENTRY_DSN is not set
import App from './App.jsx'
import './index.css'
import './styles/appearance.css'
import { AppearanceProvider } from './contexts/AppearanceContext.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,   // 1 min — stale data shows instantly on re-visit; background refetch starts
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
