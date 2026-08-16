import { defineConfig } from 'vitest/config'

/**
 * Integration tier — runs against a hosted Supabase project, never a container.
 *
 * Separate from vitest.config.js on purpose. The unit tier is hermetic, fast
 * and always runs; this one talks to a real database over the network, needs
 * credentials, and skips itself without them. Mixing the two would make
 * `npm test` sometimes-networked, which is the kind of flakiness that gets a
 * suite ignored.
 *
 *   npm run test:integration
 *
 * Node environment, not jsdom: there is no DOM here, just supabase-js.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    // A hosted round-trip is slower than a pure function; the default 5s is
    // tight for a cold connection.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Sequential. These share one remote database, and parallel suites make a
    // failure much harder to attribute.
    fileParallelism: false,
  },
})
