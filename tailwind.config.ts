import type { Config } from 'tailwindcss';

export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-raised': 'var(--surface-raised)',
        'surface-sunken': 'var(--surface-sunken)',
        terminal: 'var(--terminal-bg)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        text: {
          DEFAULT: 'var(--text)',
          dim: 'var(--text-dim)',
          faint: 'var(--text-faint)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-strong)',
          subtle: 'var(--accent-subtle)',
        },
        ok: { DEFAULT: 'var(--ok)', subtle: 'var(--ok-subtle)' },
        run: { DEFAULT: 'var(--run)', subtle: 'var(--run-subtle)' },
        fail: { DEFAULT: 'var(--fail)', subtle: 'var(--fail-subtle)' },
        warn: { DEFAULT: 'var(--warn)', subtle: 'var(--warn-subtle)' },
        attn: { DEFAULT: 'var(--attn)', subtle: 'var(--attn-subtle)' },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
      },
      boxShadow: {
        focus: 'var(--shadow-focus)',
        card: 'var(--shadow-card)',
        popover: 'var(--shadow-popover)',
      },
      transitionDuration: {
        fast: 'var(--d-fast)',
        base: 'var(--d-base)',
        slow: 'var(--d-slow)',
      },
      transitionTimingFunction: {
        out: 'var(--e-out)',
        in: 'var(--e-in)',
      },
      keyframes: {
        pulse: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.6' } },
      },
      animation: {
        pulse: 'pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
