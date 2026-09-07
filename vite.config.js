import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Which build an error came from.
//
// Sentry groups errors by release. Without one, every error in the dashboard
// looks like it came from the same nameless version, and "did my fix work?"
// becomes unanswerable. Vercel exposes the commit it is building as
// VERCEL_GIT_COMMIT_SHA, but Vite only forwards variables prefixed VITE_, so it
// has to be handed over explicitly here. Falls back to 'dev' for local builds.
const APP_VERSION =
  process.env.VITE_APP_VERSION ||
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
  'dev'

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Inject the service worker registration into index.html automatically
      injectRegister: 'auto',

      manifest: {
        name: 'myCRM — Business Management',
        short_name: 'myCRM',
        description: 'Business management for sales, service, inventory and warranty returns',
        theme_color: '#4f46e5',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        orientation: 'portrait-primary',
        icons: [
          { src: 'pwa-64x64.png',           sizes: '64x64',   type: 'image/png' },
          { src: 'pwa-192x192.png',          sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png',          sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // App-shell strategy: pre-cache all static assets Vite emits
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],

        // Supabase responses are deliberately NOT cached (BUG-024).
        //
        // This used to hold a NetworkFirst rule matching
        // /^https:\/\/.*\.supabase\.co\/.*/i, which covers REST, Auth and
        // Storage alike. Every authenticated GET — customers, tickets,
        // invoices, user_roles — was written to Cache Storage under
        // 'supabase-api' and never removed, because nothing in the app called
        // caches.delete or unregistered the worker. Signing out took the
        // session away and left the data, so on a shared machine the next
        // person could read the previous user's records out of DevTools with
        // no session at all.
        //
        // The offline benefit did not justify that: NetworkFirst serves the
        // network whenever it is reachable, so the cache only mattered when
        // offline, and offline access to someone else's customer list is the
        // problem rather than the feature. Static assets are still precached
        // by globPatterns above, which is the part that makes this a PWA.
        //
        // Removing the rule only prevents NEW caching. Browsers that already
        // hold a populated cache are purged on sign-out by
        // src/lib/purgeCaches.js.

        // Don't cache the service worker itself or the Vite dev HMR endpoint
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/supabase\//],
      },

      // Dev mode: enable the SW in development so you can test offline behaviour
      devOptions: {
        enabled: false, // flip to true to debug SW locally
        type: 'module',
      },
    }),
  ],

  base: '/',

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query', '@tanstack/react-virtual'],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-select',
          ],
          'vendor-ui': ['framer-motion', 'react-hot-toast'],
          'vendor-forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
      },
    },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    // Scope to project tests only — without this Vitest also picks up copies
    // inside .claude/worktrees/*, doubling every test in the output.
    include: ['src/test/**/*.test.{js,jsx,ts,tsx}'],
    // Vitest 4.1.7 + Node 24 worker_threads pool has a race on suite init.
    // forks pool sidesteps it; fileParallelism:false also kept for safety.
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'src/test/', 'dist/'],
    },
  },
})
