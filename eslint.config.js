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
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        localStorage: 'readonly',
        // The Storage prototype, for tests that make it throw the way a
        // private window or a full quota does.
        Storage: 'readonly',
        sessionStorage: 'readonly',
        crypto: 'readonly',
        BroadcastChannel: 'readonly',
        Image: 'readonly',
        Promise: 'readonly',
        TextEncoder: 'readonly',
        // Added with the Knowledge Center chat: it reads a streamed response
        // and lets the user stop one mid-answer.
        TextDecoder: 'readonly',
        AbortController: 'readonly',
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

      // Re-enabled: 'off' let "X is not defined" bugs (load, ticketsWithDue)
      // reach production. This is the guard that catches that whole crash class.
      'no-undef': 'error',
    },
  },

  // ── UI guard rails (UX-GLOBAL-001 / 004) ───────────────────────────────────
  //
  // Landed BEFORE the codemods they protect, deliberately. The audit found a
  // design system that exists and is bypassed: 52 declared tokens beside 125
  // hardcoded hex colours, and 378 physical `text-left/right` against 8 logical
  // `text-start/end`. Cleaning that up without a guard just resets the clock.
  //
  // These are warnings, not errors, because the existing violations are counted
  // in `lint:ci` as a ratchet (see package.json). The number may go down and
  // never up; when it reaches zero these become errors.
  {
    files: ['src/**/*.{js,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          // Physical direction in Tailwind classes. Arabic is a first-class
          // locale here, so `ml-`/`text-left` silently mirror wrong.
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/text-left|text-right|(^| )-?(ml|mr|pl|pr)-|(^| )(left|right)-[0-9]/]",
          message:
            'Use logical properties: ms-/me-/ps-/pe-, text-start/text-end, start-/end-. Physical ones do not mirror in Arabic (UX-GLOBAL-004).',
        },
        {
          selector:
            "JSXAttribute[name.name='className'] TemplateElement[value.raw=/text-left|text-right|(^| )-?(ml|mr|pl|pr)-/]",
          message:
            'Use logical properties: ms-/me-/ps-/pe-, text-start/text-end. Physical ones do not mirror in Arabic (UX-GLOBAL-004).',
        },
        {
          // Hardcoded user-visible text (UX-GLOBAL-003 / UX-AUTH-001).
          //
          // This is the guard for the whole Critical class the audit found. The
          // bidi damage — `?Forgot password`, `!Welcome to myCRM`, `.minutes` —
          // was never really a bidi bug. It was English prose sitting inside an
          // RTL container: terminal punctuation attaches to the paragraph
          // direction, so it jumps to the leading edge. Translate the string and
          // the symptom disappears with it. Two or more words, so single-word
          // labels and punctuation are not flagged.
          selector: 'JSXText[value=/[A-Za-z]{2,}\s+[A-Za-z]{2,}/]',
          message:
            'Hardcoded user-visible text. Use t() — untranslated English inside an RTL page also renders its punctuation on the wrong edge (UX-GLOBAL-003).',
        },
        {
          // Raw hex in markup, bypassing the token layer.
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/#[0-9a-fA-F]{3,8}/]",
          message:
            'Use a design token instead of a raw hex colour (UX-GLOBAL-001). See src/styles/tokens.css.',
        },
      ],
    },
  },

  prettierConfig,
]
