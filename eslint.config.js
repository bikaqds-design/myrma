import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettierConfig from 'eslint-config-prettier'

export default [
  { ignores: ['dist', 'node_modules', 'eslint-report.json'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        crypto: 'readonly',
        Promise: 'readonly',
        TextEncoder: 'readonly',
        Uint8Array: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        process: 'readonly',
        React: 'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // ── Hooks (spread recommended, then tune) ──────────────────────────────
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'warn',
      // react-hooks v5 React-Compiler rules — off until we adopt the compiler
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',

      // ── Fast refresh ───────────────────────────────────────────────────────
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // ── JS quality — errors (always wrong) ────────────────────────────────
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'no-irregular-whitespace': 'error',

      // ── JS quality — warnings (improve over time) ─────────────────────────
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_|^React$' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-useless-catch': 'warn',
      'no-useless-assignment': 'warn',
      // Empty catch blocks are intentional in this codebase (graceful degradation)
      'no-empty': ['warn', { allowEmptyCatch: true }],

      'no-undef': 'off',
    },
  },

  prettierConfig,
]
