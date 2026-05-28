import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Inject the service worker registration into index.html automatically
      injectRegister: 'auto',

      manifest: {
        name: 'myRMA — RMA Management',
        short_name: 'myRMA',
        description: 'Enterprise RMA and warranty ticket management',
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

        // Network-first for Supabase API calls so data is always fresh
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 10,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],

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
    // Vitest 4.1.7 has a parallel-pool race that surfaces as
    // "Cannot read properties of undefined (reading 'config')" on suite import.
    // Disable file-level parallelism to serialise suites and avoid the race.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'src/test/', 'dist/'],
    },
  },
})
