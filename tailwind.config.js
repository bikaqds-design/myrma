/** @type {import('tailwindcss').Config} */

/**
 * Themed palette entries are backed by the CSS variables in
 * src/styles/tokens.css rather than fixed hex, so `bg-gray-100` and friends
 * resolve per theme through the cascade instead of through a sheet of
 * `!important` overrides. See tokens.css for why, and for the contrast numbers.
 *
 * `rgb(... / <alpha-value>)` is what keeps the opacity modifiers working, so
 * `bg-red-100/40` still means what it says.
 *
 * Only the entries the old override sheet actually repainted are listed. Every
 * other Tailwind colour is untouched and behaves exactly as before, which keeps
 * this a redirection of existing behaviour rather than a palette redesign.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

const tintFills = Object.fromEntries(
  ['indigo', 'blue', 'amber', 'yellow', 'green', 'emerald', 'red', 'orange', 'teal', 'purple', 'pink']
    .map((c) => [c, { 50: token(`c-bg-${c}-50`) }])
)
const badgeFills = ['indigo', 'blue', 'green', 'emerald', 'red', 'amber', 'yellow', 'orange', 'pink', 'purple', 'teal']

export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /**
       * A named stacking ladder (UX-GLOBAL-002).
       *
       * Overlay z-indexes were eight ad-hoc values — z-50 beside z-[60], z-[70],
       * z-[200], z-[400] and z-[500]. The ORDER happened to be right, so nothing
       * stacked wrong; the problem is that the next person adding an overlay has
       * nothing to read and picks a number by guessing higher than whatever they
       * saw last. That is how the ladder got to 500.
       *
       * Named rungs, with gaps left between them so something can be slotted in
       * without renumbering.
       */
      zIndex: {
        dropdown: '100',   // menus, comboboxes, popovers anchored to a control
        overlay: '200',    // modal and drawer backdrops
        modal: '300',      // the dialog itself
        // A modal opened from inside another one. TransferModal and
        // ProductDetailModal sat at z-[70] against z-[60] for the surrounding
        // screen's own modal, and WarehousesTab renders both — collapsing them
        // to one rung would have let DOM order decide, silently reversing it.
        modalNested: '350',
        confirm: '400',    // a confirmation opened FROM a modal, so it sits above
        fullscreen: '500', // camera scanner and similar takeovers
        onboarding: '600', // first-run wizard, above everything
        toast: '700',      // feedback must never be hidden by what triggered it
      },

      screens: {
        'xs': '475px',
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', 'sans-serif'],
      },
      colors: {
        page: { light: '#f4f6f9', dark: '#0b0f17' },
      },
      backgroundColor: {
        white: token('c-bg-white'),
        gray: {
          50: token('c-bg-gray-50'),
          100: token('c-bg-gray-100'),
          200: token('c-bg-gray-200'),
        },
        ...Object.fromEntries(
          badgeFills.map((c) => [
            c,
            { ...(tintFills[c] || {}), 100: token(`c-bg-${c}-100`) },
          ])
        ),
        blue: { 50: token('c-bg-blue-50'), 100: token('c-bg-blue-100'), 600: token('c-bg-blue-600') },
        green: { 50: token('c-bg-green-50'), 100: token('c-bg-green-100'), 600: token('c-bg-green-600') },
        red: { 50: token('c-bg-red-50'), 100: token('c-bg-red-100'), 600: token('c-bg-red-600') },
        yellow: { 50: token('c-bg-yellow-50'), 100: token('c-bg-yellow-100'), 500: token('c-bg-yellow-500') },
      },
      textColor: {
        gray: {
          400: token('c-text-gray-400'),
          500: token('c-text-gray-500'),
          600: token('c-text-gray-600'),
          700: token('c-text-gray-700'),
          800: token('c-text-gray-800'),
          900: token('c-text-gray-900'),
        },
        indigo: { 600: token('c-text-indigo-600'), 800: token('c-text-indigo-800') },
        red: { 500: token('c-text-red-500'), 600: token('c-text-red-600') },
        emerald: { 600: token('c-text-emerald-600') },
        green: { 600: token('c-text-green-600') },
        amber: { 600: token('c-text-amber-600') },
      },
      borderColor: {
        DEFAULT: token('c-border-default'),
        gray: {
          100: token('c-border-gray-100'),
          200: token('c-border-gray-200'),
          300: token('c-border-gray-300'),
        },
        blue: { 200: token('c-border-blue-200') },
        amber: { 200: token('c-border-amber-200') },
        green: { 200: token('c-border-green-200') },
        red: { 200: token('c-border-red-200') },
        indigo: { 200: token('c-border-indigo-200') },
      },
      divideColor: {
        DEFAULT: token('c-border-gray-200'),
        gray: { 100: token('c-border-gray-200') },
      },
    },
  },
  plugins: [],
}
