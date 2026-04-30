# FBI UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the FBI web interface around a terminal-inspired design language delivered as a reusable primitive library with extension points for future features.

**Architecture:** Layered frontend redesign. Bottom-up: design tokens (CSS vars) → primitives → patterns → data components → shell (AppShell, Sidebar, Topbar, StatusBar, CommandPalette, KeyMap) → feature migrations. Every step is shippable on its own.

**Tech Stack:** React 18, TypeScript, Tailwind CSS (tokens via CSS variables), Vite, vitest + @testing-library/react + happy-dom, `cmdk` for the command palette, `@fontsource/inter`, `@fontsource/jetbrains-mono`.

**Reference spec:** `docs/superpowers/specs/2026-04-22-fbi-ui-redesign-design.md`

---

## Phase 1: Foundation

### Task 1: Install dependencies and establish `@ui` alias

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.web.json`
- Modify: `tsconfig.test.json`

- [ ] **Step 1: Install runtime and dev dependencies**

Run:
```bash
npm install cmdk @fontsource/inter @fontsource/jetbrains-mono
```

Expected: three new entries in `dependencies` in `package.json`; `package-lock.json` updated.

- [ ] **Step 2: Add `@ui` alias to Vite**

Edit `vite.config.ts`, extend `resolve.alias`:

```ts
resolve: {
  alias: {
    '@shared': path.resolve(__dirname, 'src/shared'),
    '@ui': path.resolve(__dirname, 'src/web/ui'),
  },
},
```

- [ ] **Step 3: Add `@ui` alias to Vitest**

Edit `vitest.config.ts` the same way:

```ts
resolve: {
  alias: {
    '@shared': path.resolve(__dirname, 'src/shared'),
    '@ui': path.resolve(__dirname, 'src/web/ui'),
  },
},
```

- [ ] **Step 4: Add `@ui` path to TypeScript configs**

Edit `tsconfig.web.json` `compilerOptions.paths`:

```json
"paths": {
  "@shared/*": ["src/shared/*"],
  "@ui/*": ["src/web/ui/*"]
}
```

Edit `tsconfig.test.json` to mirror. (Open it and add the same `paths` entry.)

- [ ] **Step 5: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS (no changes to source yet, just new aliases).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vite.config.ts vitest.config.ts tsconfig.web.json tsconfig.test.json
git commit -m "chore(ui): add cmdk + fontsource deps and @ui alias"
```

---

### Task 2: Create design tokens (`tokens.css`) and fonts entrypoint

**Files:**
- Create: `src/web/ui/tokens.css`
- Modify: `src/web/index.css`

- [ ] **Step 1: Create `src/web/ui/tokens.css`**

```css
/* Design tokens — see docs/superpowers/specs/2026-04-22-fbi-ui-redesign-design.md */

:root {
  /* color — dark (default) */
  --bg: #0b0f14;
  --surface: #0a1218;
  --surface-raised: #0c1722;
  --surface-sunken: #060a0f;
  --border: #15212d;
  --border-strong: #1e2a36;
  --text: #e2e8f0;
  --text-dim: #94a3b8;
  --text-faint: #64748b;
  --accent: #38bdf8;
  --accent-strong: #7dd3fc;
  --accent-subtle: #082f49;
  --ok: #34d399;
  --ok-subtle: #042f2e;
  --run: #38bdf8;
  --run-subtle: #082f49;
  --fail: #f87171;
  --fail-subtle: #450a0a;
  --warn: #fbbf24;
  --warn-subtle: #2d1c07;
  --focus-ring: #38bdf866;

  /* typography */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;

  /* radii */
  --r-sm: 3px;
  --r-md: 6px;
  --r-lg: 8px;
  --r-xl: 12px;

  /* spacing */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 24px;
  --s-6: 32px;
  --s-7: 48px;

  /* shadows */
  --shadow-focus: 0 0 0 2px var(--focus-ring);
  --shadow-card: none;
  --shadow-popover: 0 8px 24px -6px rgba(0, 0, 0, 0.4);

  /* motion */
  --d-fast: 120ms;
  --d-base: 180ms;
  --d-slow: 320ms;
  --e-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --e-in: cubic-bezier(0.4, 0, 1, 1);

  /* z */
  --z-statusbar: 10;
  --z-sidebar: 20;
  --z-topbar: 30;
  --z-drawer: 40;
  --z-dialog: 50;
  --z-palette: 60;
  --z-toast: 70;

  color-scheme: dark;
}

:root.light {
  --bg: #f8fafc;
  --surface: #ffffff;
  --surface-raised: #f1f5f9;
  --surface-sunken: #eef2f7;
  --border: #e2e8f0;
  --border-strong: #cbd5e1;
  --text: #0f172a;
  --text-dim: #475569;
  --text-faint: #94a3b8;
  --accent: #0284c7;
  --accent-strong: #0369a1;
  --accent-subtle: #e0f2fe;
  --ok: #047857;
  --ok-subtle: #ecfdf5;
  --run: #0284c7;
  --run-subtle: #e0f2fe;
  --fail: #b91c1c;
  --fail-subtle: #fef2f2;
  --warn: #b45309;
  --warn-subtle: #fffbeb;
  --focus-ring: #0284c766;

  --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 12px -2px rgba(15, 23, 42, 0.06);
  --shadow-popover: 0 10px 30px -8px rgba(15, 23, 42, 0.14), 0 4px 10px -4px rgba(15, 23, 42, 0.08);

  color-scheme: light;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --d-fast: 0ms;
    --d-base: 0ms;
    --d-slow: 0ms;
  }
}

html, body, #root { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 20px;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
```

- [ ] **Step 2: Update `src/web/index.css` to import tokens + fonts**

Replace the whole file:

```css
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
@import '@fontsource/jetbrains-mono/400.css';
@import '@fontsource/jetbrains-mono/500.css';
@import '@fontsource/jetbrains-mono/600.css';
@import './ui/tokens.css';

@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 3: Run dev server and open the app**

Run: `./scripts/dev.sh`
Expected: app loads on `http://localhost:5173`. Background/font changes since `body` now reads from `--bg` / `--font-sans`. Currently hardcoded `bg-white dark:bg-gray-800` classes in `Layout.tsx` may override — that's expected; we remove them later.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/tokens.css src/web/index.css
git commit -m "feat(ui): add design tokens and font imports"
```

---

### Task 3: Extend Tailwind config to read CSS variables

**Files:**
- Modify: `tailwind.config.ts`

- [ ] **Step 1: Rewrite `tailwind.config.ts`**

```ts
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
```

- [ ] **Step 2: Verify build + typecheck**

Run: `npm run typecheck && npm run build:web`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
git add tailwind.config.ts
git commit -m "feat(ui): extend Tailwind theme to read design tokens"
```

---

### Task 4: Theme module and no-flash inline script

**Files:**
- Create: `src/web/ui/theme.ts`
- Create: `src/web/ui/theme.test.ts`
- Modify: `src/web/index.html`
- Modify: `src/web/main.tsx`

- [ ] **Step 1: Create the test**

`src/web/ui/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getStoredTheme, setStoredTheme, applyTheme, toggleTheme, subscribeSystemTheme } from './theme.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('light');
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: q === '(prefers-color-scheme: light)' ? false : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe('theme', () => {
  it('getStoredTheme returns null when nothing saved', () => {
    expect(getStoredTheme()).toBeNull();
  });

  it('setStoredTheme + getStoredTheme round-trip', () => {
    setStoredTheme('light');
    expect(getStoredTheme()).toBe('light');
    setStoredTheme('dark');
    expect(getStoredTheme()).toBe('dark');
  });

  it('applyTheme dark removes .light', () => {
    document.documentElement.classList.add('light');
    applyTheme('dark');
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('applyTheme light adds .light', () => {
    applyTheme('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('toggleTheme flips dark→light and persists', () => {
    applyTheme('dark');
    const next = toggleTheme();
    expect(next).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(getStoredTheme()).toBe('light');
  });

  it('subscribeSystemTheme calls handler on change only when user has no stored preference', () => {
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      matches: false,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    });
    const handler = vi.fn();
    subscribeSystemTheme(handler);
    // simulate change
    listeners[0]({ matches: true } as MediaQueryListEvent);
    expect(handler).toHaveBeenCalledWith('light');
    // after user stores preference, subsequent system changes ignored by the handler contract;
    // subscribeSystemTheme itself always forwards — the consumer decides to act.
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/web/ui/theme.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/web/ui/theme.ts`**

```ts
export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'fbi-theme';

export function getStoredTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'dark' || v === 'light' ? v : null;
}

export function setStoredTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function resolveInitialTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return systemPrefersLight() ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}

export function toggleTheme(): Theme {
  const current: Theme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const next: Theme = current === 'light' ? 'dark' : 'light';
  setStoredTheme(next);
  applyTheme(next);
  return next;
}

export function subscribeSystemTheme(handler: (theme: Theme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const listener = (e: MediaQueryListEvent) => handler(e.matches ? 'light' : 'dark');
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

// Inline script string — injected into index.html to prevent flash on load.
export const NO_FLASH_SCRIPT = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var m=window.matchMedia('(prefers-color-scheme: light)').matches;if(s==='light'||(!s&&m)){document.documentElement.classList.add('light');}}catch(e){}})();`;
```

- [ ] **Step 4: Rerun the test to confirm it passes**

Run: `npx vitest run src/web/ui/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Inline no-flash script into `src/web/index.html`**

Insert immediately before the closing `</head>` tag:

```html
<script>
  (function(){try{var s=localStorage.getItem('fbi-theme');var m=window.matchMedia('(prefers-color-scheme: light)').matches;if(s==='light'||(!s&&m)){document.documentElement.classList.add('light');}}catch(e){}})();
</script>
```

This runs before React mounts so the correct theme class is set before first paint.

- [ ] **Step 6: Delete the now-unused `src/web/lib/theme.ts`** (will be replaced by `@ui/theme.ts` usage)

Run: `git rm src/web/lib/theme.ts src/web/lib/theme.test.ts`

Also temporarily make `ThemeToggle.tsx` compile by rewriting its import to `@ui/theme.js`. Replace the file body:

```tsx
import { useEffect, useState } from 'react';
import { applyTheme, resolveInitialTheme, toggleTheme, type Theme } from '@ui/theme.js';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return (
    <button
      onClick={() => setTheme(toggleTheme())}
      aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      className="text-text-faint hover:text-text text-lg leading-none"
    >
      {theme === 'light' ? '☾' : '☀'}
    </button>
  );
}
```

(`ThemeToggle` will be removed entirely in a later task when the command-palette action replaces it.)

- [ ] **Step 7: Update `ThemeToggle.test.tsx`** to match the new class-based API (remove `.dark` class expectations; expect `.light` class toggling instead):

Replace the two `document.documentElement.classList.contains('dark')` lines:

```tsx
expect(document.documentElement.classList.contains('light')).toBe(false);
```
and
```tsx
expect(document.documentElement.classList.contains('light')).toBe(true);
```

Update `beforeEach` to remove `.light` instead of `.dark`, and initial `mockMatchMedia` to set `prefersDark` to the inverse sense (current test names / behaviors still align if we swap senses: `localStorage.setItem('fbi-theme', 'light')` triggers light, clicking light→dark removes `.light`).

(Easiest: rewrite the test file end-to-end — see Task 1 file for inspiration. The rewrite must test: button label in dark state, button label in light state, clicking dark→light adds `.light`, clicking light→dark removes `.light`.)

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/web/ui/theme.ts src/web/ui/theme.test.ts src/web/index.html src/web/components/ThemeToggle.tsx src/web/components/ThemeToggle.test.tsx
git rm --cached src/web/lib/theme.ts src/web/lib/theme.test.ts 2>/dev/null || true
git add -u src/web/lib
git commit -m "feat(ui): theme module with no-flash init; consolidate theme utilities under @ui"
```

---

### Task 5: Contributor rules and classNames helper

**Files:**
- Create: `src/web/ui/CLAUDE.md`
- Create: `src/web/ui/cn.ts`

- [ ] **Step 0: Tiny classNames helper**

`src/web/ui/cn.ts`:

```ts
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
```

Used by every primitive. No dep, no magic.

- [ ] **Step 1: Write `src/web/ui/CLAUDE.md`**

```markdown
# UI system — contributor rules

This directory is the FBI design system. Every page and feature in `src/web/features/` and `src/web/pages/` composes from here. Read this before adding UI.

## The rules

1. **Never hardcode a color, spacing, radius, or shadow.** Always a token. Hex in component files is a review-blocker. If a token is missing, add it to `tokens.css` first.
2. **Never copy primitive styling into a feature file.** If a feature needs a variant the primitive doesn't expose, extend the primitive.
3. **New feature = new directory under `src/web/features/`** composed from `src/web/ui/`. Don't reach into other features' internals.
4. **Every new primitive is added to `/design`** (the live showcase at `src/web/pages/Design.tsx`). If it isn't in the showcase, it isn't a primitive.
5. **Prefer composition (extension points) over modification.** `Sidebar`, `StatusBar`, `CommandPalette`, `KeyMap` accept registrations. New feature surfaces register; they don't edit the shell.

## Directory map

- `primitives/` — Button, Pill, Input, Card, Tabs, Dialog, … Small, composable, no app-specific logic.
- `patterns/` — FormRow, EmptyState, SplitPane, … Higher-order compositions of primitives.
- `data/` — StatCard, Sparkline, ProgressBar, DiffRow, … Primitives for data display.
- `shell/` — AppShell, Sidebar, Topbar, StatusBar, CommandPalette, KeyMap. The app chrome + its extension APIs.
- `tokens.css` — The one and only source of color / type / spacing values.
- `theme.ts` — Dark/light switching. No UI.

## Tokens quick reference

Use Tailwind classes that resolve to tokens, e.g. `bg-surface`, `text-text-dim`, `border-border-strong`, `text-accent`, `bg-ok-subtle`, `rounded-md`, `duration-fast`, `ease-out`.

## When you need to break a rule

If you genuinely need to break a rule, document why in a comment in your PR description. The rules exist so future agents can pick up this codebase without re-deriving the system.
```

- [ ] **Step 2: Commit**

```bash
git add src/web/ui/CLAUDE.md src/web/ui/cn.ts
git commit -m "docs(ui): add contributor rules and cn helper"
```

---

## Phase 2: Primitives

Every primitive is a named export from `src/web/ui/primitives/<Name>.tsx` and is re-exported from `src/web/ui/primitives/index.ts`. Every primitive has a `.test.tsx` beside it. Tests verify: (a) renders children, (b) applies variants, (c) forwards events and refs.

### Task 6: Button, IconButton, Link

**Files:**
- Create: `src/web/ui/primitives/Button.tsx`
- Create: `src/web/ui/primitives/IconButton.tsx`
- Create: `src/web/ui/primitives/Link.tsx`
- Create: `src/web/ui/primitives/Button.test.tsx`
- Create: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Write `Button.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button.js';
import { IconButton } from './IconButton.js';

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Start run</Button>);
    await userEvent.click(screen.getByRole('button', { name: /start run/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies the primary variant by default', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'primary');
  });

  it('applies secondary/ghost/danger variants', () => {
    const { rerender } = render(<Button variant="secondary">x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'secondary');
    rerender(<Button variant="ghost">x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'ghost');
    rerender(<Button variant="danger">x</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'danger');
  });

  it('disabled prevents click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Go</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('requires and exposes an aria-label', () => {
    render(<IconButton aria-label="Close">×</IconButton>);
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run src/web/ui/primitives/Button.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `Button.tsx`**

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-surface hover:bg-accent-strong border-accent',
  secondary: 'bg-accent-subtle text-accent-strong border-accent-subtle hover:border-accent',
  ghost: 'bg-transparent text-text-dim border-border-strong hover:bg-surface-raised hover:text-text',
  danger: 'bg-fail-subtle text-fail border-fail-subtle hover:border-fail',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'text-[11px] px-2.5 py-1',
  md: 'text-xs px-3 py-1.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      data-variant={variant}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium rounded-md border transition-colors duration-fast ease-out disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
```

- [ ] **Step 4: Implement `IconButton.tsx`**

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center w-7 h-7 rounded-md text-text-dim hover:text-text hover:bg-surface-raised transition-colors duration-fast ease-out disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});
```

- [ ] **Step 5: Implement `Link.tsx`**

```tsx
import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function Link(
  { className, ...rest },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cn('text-accent hover:text-accent-strong transition-colors duration-fast ease-out', className)}
      {...rest}
    />
  );
});
```

(For React Router links, features wrap `Link` and `NavLink` from `react-router-dom` using the same classes. Keep both available.)

- [ ] **Step 6: Create `src/web/ui/primitives/index.ts`**

```ts
export * from './Button.js';
export * from './IconButton.js';
export * from './Link.js';
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/web/ui/primitives/Button.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/ui/primitives/Button.tsx src/web/ui/primitives/IconButton.tsx src/web/ui/primitives/Link.tsx src/web/ui/primitives/Button.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Button, IconButton, Link primitives"
```

---

### Task 7: Kbd, Pill, StatusDot, Tag

**Files:**
- Create: `src/web/ui/primitives/Kbd.tsx`
- Create: `src/web/ui/primitives/Pill.tsx`
- Create: `src/web/ui/primitives/StatusDot.tsx`
- Create: `src/web/ui/primitives/Tag.tsx`
- Create: `src/web/ui/primitives/Pill.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Write `Pill.test.tsx`** (covers all four)

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Pill } from './Pill.js';
import { Kbd } from './Kbd.js';
import { StatusDot } from './StatusDot.js';
import { Tag } from './Tag.js';

describe('Pill', () => {
  it('renders each tone', () => {
    for (const tone of ['ok', 'run', 'fail', 'warn', 'wait'] as const) {
      const { unmount } = render(<Pill tone={tone}>{tone}</Pill>);
      expect(screen.getByText(tone)).toHaveAttribute('data-tone', tone);
      unmount();
    }
  });

  it('pulses when tone=run', () => {
    render(<Pill tone="run">x</Pill>);
    expect(screen.getByText('x').className).toContain('animate-pulse');
  });
});

describe('Kbd', () => {
  it('renders the key character', () => {
    render(<Kbd>⌘</Kbd>);
    expect(screen.getByText('⌘').tagName).toBe('KBD');
  });
});

describe('StatusDot', () => {
  it('exposes the tone', () => {
    render(<StatusDot tone="ok" aria-label="succeeded" />);
    expect(screen.getByLabelText('succeeded')).toHaveAttribute('data-tone', 'ok');
  });
});

describe('Tag', () => {
  it('renders children', () => {
    render(<Tag>main</Tag>);
    expect(screen.getByText('main')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test; confirm failure**

Run: `npx vitest run src/web/ui/primitives/Pill.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `Pill.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type PillTone = 'ok' | 'run' | 'fail' | 'warn' | 'wait';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone: PillTone;
}

const TONES: Record<PillTone, string> = {
  ok: 'bg-ok-subtle text-ok border-ok/40',
  run: 'bg-run-subtle text-run border-run/40 animate-pulse',
  fail: 'bg-fail-subtle text-fail border-fail/40',
  warn: 'bg-warn-subtle text-warn border-warn/40',
  wait: 'bg-surface-raised text-text-dim border-border-strong',
};

export function Pill({ tone, className, ...rest }: PillProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[10px] font-medium px-1.5 rounded-sm border',
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
```

- [ ] **Step 4: Implement `Kbd.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center min-w-[16px] px-1.5 font-mono text-[10px] font-medium rounded-sm bg-surface-raised text-text-dim border border-border-strong',
        className,
      )}
      {...rest}
    />
  );
}
```

- [ ] **Step 5: Implement `StatusDot.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type DotTone = 'ok' | 'run' | 'fail' | 'warn';

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone: DotTone;
}

const DOT: Record<DotTone, string> = {
  ok: 'bg-ok',
  run: 'bg-run shadow-[0_0_6px_var(--run)] animate-pulse',
  fail: 'bg-fail',
  warn: 'bg-warn',
};

export function StatusDot({ tone, className, ...rest }: StatusDotProps) {
  return (
    <span
      data-tone={tone}
      className={cn('inline-block w-[7px] h-[7px] rounded-full', DOT[tone], className)}
      {...rest}
    />
  );
}
```

- [ ] **Step 6: Implement `Tag.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Tag({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[10px] px-1.5 rounded-sm bg-surface-raised text-text-dim border border-border',
        className,
      )}
      {...rest}
    />
  );
}
```

- [ ] **Step 7: Export from `index.ts`**

Append to `src/web/ui/primitives/index.ts`:

```ts
export * from './Kbd.js';
export * from './Pill.js';
export * from './StatusDot.js';
export * from './Tag.js';
```

- [ ] **Step 8: Run tests; confirm PASS**

Run: `npx vitest run src/web/ui/primitives/Pill.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/web/ui/primitives/Pill.tsx src/web/ui/primitives/Kbd.tsx src/web/ui/primitives/StatusDot.tsx src/web/ui/primitives/Tag.tsx src/web/ui/primitives/Pill.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Kbd, Pill, StatusDot, Tag primitives"
```

---

### Task 8: Input, Textarea, FieldLabel

**Files:**
- Create: `src/web/ui/primitives/Input.tsx`
- Create: `src/web/ui/primitives/Textarea.tsx`
- Create: `src/web/ui/primitives/FieldLabel.tsx`
- Create: `src/web/ui/primitives/Input.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Input } from './Input.js';
import { Textarea } from './Textarea.js';

describe('Input', () => {
  it('forwards value and onChange', async () => {
    function Host() {
      const [v, setV] = (require('react') as typeof import('react')).useState('');
      return <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="name" />;
    }
    render(<Host />);
    await userEvent.type(screen.getByPlaceholderText('name'), 'abc');
    expect(screen.getByPlaceholderText('name')).toHaveValue('abc');
  });

  it('monoscale flag applies the mono font', () => {
    render(<Input mono placeholder="m" />);
    expect(screen.getByPlaceholderText('m').className).toContain('font-mono');
  });
});

describe('Textarea', () => {
  it('renders', () => {
    render(<Textarea placeholder="prompt" />);
    expect(screen.getByPlaceholderText('prompt')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run; confirm failure**

Run: `npx vitest run src/web/ui/primitives/Input.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `Input.tsx`**

```tsx
import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'w-full bg-surface text-text border border-border-strong rounded-md px-2.5 py-1.5 text-sm placeholder:text-text-faint outline-none transition-shadow duration-fast ease-out',
        'focus:border-accent focus:shadow-focus',
        mono ? 'font-mono text-[12px]' : 'font-sans',
        className,
      )}
      {...rest}
    />
  );
});
```

- [ ] **Step 4: Implement `Textarea.tsx`**

```tsx
import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full bg-surface text-text border border-border-strong rounded-md px-2.5 py-2 text-sm placeholder:text-text-faint outline-none transition-shadow duration-fast ease-out',
        'focus:border-accent focus:shadow-focus',
        mono ? 'font-mono text-[12px]' : 'font-sans',
        className,
      )}
      {...rest}
    />
  );
});
```

- [ ] **Step 5: Implement `FieldLabel.tsx`**

```tsx
import type { LabelHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function FieldLabel({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('block text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint mb-1.5', className)}
      {...rest}
    />
  );
}
```

- [ ] **Step 6: Export + test PASS**

Append to `index.ts`:

```ts
export * from './Input.js';
export * from './Textarea.js';
export * from './FieldLabel.js';
```

Run: `npx vitest run src/web/ui/primitives/Input.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/ui/primitives/Input.tsx src/web/ui/primitives/Textarea.tsx src/web/ui/primitives/FieldLabel.tsx src/web/ui/primitives/Input.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Input, Textarea, FieldLabel primitives"
```

---

### Task 9: Toggle, Checkbox, Select

**Files:**
- Create: `src/web/ui/primitives/Toggle.tsx`
- Create: `src/web/ui/primitives/Checkbox.tsx`
- Create: `src/web/ui/primitives/Select.tsx`
- Create: `src/web/ui/primitives/Toggle.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Toggle } from './Toggle.js';
import { Checkbox } from './Checkbox.js';

describe('Toggle', () => {
  it('fires onChange', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} aria-label="notifs" />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reflects checked state via aria-checked', () => {
    render(<Toggle checked onChange={() => {}} aria-label="x" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Checkbox', () => {
  it('fires onChange', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} aria-label="agree" />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run; expect failure**

Run: `npx vitest run src/web/ui/primitives/Toggle.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `Toggle.tsx`**

```tsx
import { cn } from '../cn.js';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  'aria-label': string;
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, disabled, className, ...aria }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria['aria-label']}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-7 h-4 rounded-full border transition-colors duration-fast ease-out',
        checked ? 'bg-accent-subtle border-accent' : 'bg-surface-raised border-border-strong',
        disabled && 'opacity-50 cursor-not-allowed',
        className,
      )}
    >
      <span
        className={cn(
          'absolute top-[1px] w-3 h-3 rounded-full transition-all duration-fast ease-out',
          checked ? 'left-[13px] bg-accent' : 'left-[1px] bg-text-faint',
        )}
      />
    </button>
  );
}
```

- [ ] **Step 4: Implement `Checkbox.tsx`**

```tsx
import { cn } from '../cn.js';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, disabled, id, className, ...aria }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      id={id}
      aria-label={aria['aria-label']}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className={cn(
        'appearance-none w-[14px] h-[14px] rounded-sm border border-border-strong bg-surface',
        'checked:bg-accent checked:border-accent',
        'focus-visible:shadow-focus outline-none transition-colors duration-fast ease-out',
        className,
      )}
    />
  );
}
```

- [ ] **Step 5: Implement `Select.tsx`** (native `<select>` styled to match)

```tsx
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'w-full bg-surface text-text border border-border-strong rounded-md px-2.5 py-1.5 text-sm outline-none transition-shadow duration-fast ease-out focus:border-accent focus:shadow-focus',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
```

- [ ] **Step 6: Export; run tests**

Append to `index.ts`:

```ts
export * from './Toggle.js';
export * from './Checkbox.js';
export * from './Select.js';
```

Run: `npx vitest run src/web/ui/primitives/Toggle.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/ui/primitives/Toggle.tsx src/web/ui/primitives/Checkbox.tsx src/web/ui/primitives/Select.tsx src/web/ui/primitives/Toggle.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Toggle, Checkbox, Select primitives"
```

---

### Task 10: Card, Section

**Files:**
- Create: `src/web/ui/primitives/Card.tsx`
- Create: `src/web/ui/primitives/Section.tsx`
- Create: `src/web/ui/primitives/Card.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Card } from './Card.js';
import { Section } from './Section.js';

describe('Card', () => {
  it('renders children inside a styled container', () => {
    render(<Card><p>inside</p></Card>);
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('flat variant skips the surface bg', () => {
    render(<Card variant="flat" data-testid="c"><span>x</span></Card>);
    expect(screen.getByTestId('c').className).not.toContain('bg-surface');
  });
});

describe('Section', () => {
  it('renders title and children', () => {
    render(<Section title="Runs"><div>content</div></Section>);
    expect(screen.getByText('Runs')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Implement `Card.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type CardVariant = 'raised' | 'flat';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
}

export function Card({ variant = 'raised', className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border-strong',
        variant === 'raised' && 'bg-surface shadow-card',
        className,
      )}
      {...rest}
    />
  );
}
```

- [ ] **Step 4: Implement `Section.tsx`**

```tsx
import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export interface SectionProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Section({ title, actions, children, className }: SectionProps) {
  return (
    <section className={cn('space-y-3', className)}>
      <header className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold tracking-[-0.015em] text-text">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div>{children}</div>
    </section>
  );
}
```

- [ ] **Step 5: Export + run tests + commit.**

Append to `index.ts`:

```ts
export * from './Card.js';
export * from './Section.js';
```

Run: `npx vitest run src/web/ui/primitives/Card.test.tsx` — expect PASS.

```bash
git add src/web/ui/primitives/Card.tsx src/web/ui/primitives/Section.tsx src/web/ui/primitives/Card.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Card and Section primitives"
```

---

### Task 11: Tabs

**Files:**
- Create: `src/web/ui/primitives/Tabs.tsx`
- Create: `src/web/ui/primitives/Tabs.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { Tabs } from './Tabs.js';

function Host() {
  const [v, setV] = useState('a');
  return (
    <Tabs
      value={v}
      onChange={setV}
      tabs={[
        { value: 'a', label: 'Terminal' },
        { value: 'b', label: 'Files', count: 3 },
        { value: 'c', label: 'GitHub' },
      ]}
    />
  );
}

describe('Tabs', () => {
  it('marks the active tab', () => {
    render(<Host />);
    expect(screen.getByRole('tab', { name: /terminal/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking a tab changes selection', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('tab', { name: /github/i }));
    expect(screen.getByRole('tab', { name: /github/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders count when provided', () => {
    render(<Host />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Implement `Tabs.tsx`**

```tsx
import { cn } from '../cn.js';

export interface TabDef<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn('flex border-b border-border', className)}>
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'font-mono text-[11px] px-3 py-1.5 border-b-2 transition-colors duration-fast ease-out',
              active
                ? 'text-accent-strong border-accent'
                : 'text-text-faint border-transparent hover:text-text',
            )}
          >
            {t.label}
            {t.count != null && <span className="ml-1 text-text-faint">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Export + run tests + commit.**

Append to `index.ts`:

```ts
export * from './Tabs.js';
```

Run: `npx vitest run src/web/ui/primitives/Tabs.test.tsx` — expect PASS.

```bash
git add src/web/ui/primitives/Tabs.tsx src/web/ui/primitives/Tabs.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Tabs primitive"
```

---

### Task 12: Dialog (modal with focus trap)

**Files:**
- Create: `src/web/ui/primitives/Dialog.tsx`
- Create: `src/web/ui/primitives/Dialog.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './Dialog.js';

describe('Dialog', () => {
  it('renders content when open', () => {
    render(<Dialog open onClose={() => {}} title="Confirm"><p>body</p></Dialog>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="x"><p>hidden</p></Dialog>);
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
  });

  it('Esc calls onClose', async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="x"><p>y</p></Dialog>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Implement `Dialog.tsx`**

```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../cn.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, children, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
        className={cn(
          'bg-surface border border-border-strong rounded-xl shadow-popover w-full max-w-md outline-none',
          className,
        )}
      >
        <header className="px-5 py-3 border-b border-border">
          <h2 className="text-[14px] font-semibold">{title}</h2>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Export + run tests + commit.**

Append to `index.ts`:

```ts
export * from './Dialog.js';
```

Run: `npx vitest run src/web/ui/primitives/Dialog.test.tsx` — expect PASS.

```bash
git add src/web/ui/primitives/Dialog.tsx src/web/ui/primitives/Dialog.test.tsx src/web/ui/primitives/index.ts
git commit -m "feat(ui): Dialog primitive with focus restore"
```

---

### Task 13: Drawer, Menu, Tooltip, Table

**Files:**
- Create: `src/web/ui/primitives/Drawer.tsx`
- Create: `src/web/ui/primitives/Menu.tsx`
- Create: `src/web/ui/primitives/Tooltip.tsx`
- Create: `src/web/ui/primitives/Table.tsx`
- Create: `src/web/ui/primitives/Drawer.test.tsx`
- Modify: `src/web/ui/primitives/index.ts`

- [ ] **Step 1: Test (Drawer and Menu only; Tooltip + Table are trivially styled wrappers)**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Drawer } from './Drawer.js';
import { Menu } from './Menu.js';

describe('Drawer', () => {
  it('collapses and expands on toggle', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Drawer open={true} onToggle={onToggle} header={<span>Files</span>}><div>body</div></Drawer>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /collapse drawer/i }));
    expect(onToggle).toHaveBeenCalledWith(false);
    rerender(<Drawer open={false} onToggle={onToggle} header={<span>Files</span>}><div>body</div></Drawer>);
    expect(screen.queryByText('body')).not.toBeInTheDocument();
  });
});

describe('Menu', () => {
  it('opens on trigger and picks an item', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button>Open</button>}
        items={[
          { id: 'a', label: 'Cancel', onSelect: () => onSelect('a') },
          { id: 'b', label: 'Delete', onSelect: () => onSelect('b') },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /open/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});
```

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Implement `Drawer.tsx`**

```tsx
import type { ReactNode } from 'react';
import { cn } from '../cn.js';
import { IconButton } from './IconButton.js';

export interface DrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  header: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Drawer({ open, onToggle, header, children, className }: DrawerProps) {
  return (
    <div className={cn('border-t border-border-strong bg-surface', className)}>
      <div className="flex items-center px-3 py-1.5">
        <div className="flex-1 min-w-0 font-mono text-[11px] text-text-dim">{header}</div>
        <IconButton
          aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
          onClick={() => onToggle(!open)}
          className="text-[12px]"
        >
          {open ? '▾' : '▸'}
        </IconButton>
      </div>
      {open && <div className="border-t border-border">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Implement `Menu.tsx`**

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn.js';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  trigger: ReactNode;
  items: readonly MenuItem[];
}

export function Menu({ trigger, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-[var(--z-palette)] min-w-[160px] bg-surface-raised border border-border-strong rounded-md shadow-popover py-1"
        >
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect(); }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-sm transition-colors duration-fast ease-out',
                it.danger ? 'text-fail hover:bg-fail-subtle' : 'text-text hover:bg-surface',
                it.disabled && 'opacity-50 cursor-not-allowed',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement `Tooltip.tsx`** (title-based, keyboard-accessible minimal tooltip)

```tsx
import type { ReactElement, ReactNode } from 'react';
import { cloneElement } from 'react';

export interface TooltipProps {
  label: string;
  children: ReactElement;
}

export function Tooltip({ label, children }: TooltipProps): ReactNode {
  // Minimal implementation: set title attribute. Keyboard-accessible via browser defaults.
  return cloneElement(children, { title: label, 'aria-label': (children.props as { 'aria-label'?: string })['aria-label'] ?? label });
}
```

(A richer hover-positioned tooltip is out of scope for this pass; native `title` is acceptable and fully accessible.)

- [ ] **Step 6: Implement `Table.tsx`** (thin semantic wrappers)

```tsx
import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full text-xs', className)} {...rest} />;
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('text-text-faint text-[10px] uppercase tracking-[0.08em]', className)} {...rest} />;
}

export function TR({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-border last:border-0', className)} {...rest} />;
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('text-left px-2 py-1 font-semibold', className)} {...rest} />;
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-2 py-1 font-mono', className)} {...rest} />;
}
```

- [ ] **Step 7: Export; tests PASS; commit.**

Append to `index.ts`:

```ts
export * from './Drawer.js';
export * from './Menu.js';
export * from './Tooltip.js';
export * from './Table.js';
```

Run: `npx vitest run src/web/ui/primitives/Drawer.test.tsx` — expect PASS.

```bash
git add src/web/ui/primitives
git commit -m "feat(ui): Drawer, Menu, Tooltip, Table primitives"
```

---

## Phase 3: Patterns

### Task 14: FormRow, KeyboardHint

**Files:**
- Create: `src/web/ui/patterns/FormRow.tsx`
- Create: `src/web/ui/patterns/KeyboardHint.tsx`
- Create: `src/web/ui/patterns/index.ts`

- [ ] **Step 1: Implement `FormRow.tsx`**

```tsx
import type { ReactNode } from 'react';
import { FieldLabel } from '../primitives/FieldLabel.js';

export interface FormRowProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

export function FormRow({ label, hint, htmlFor, children }: FormRowProps) {
  return (
    <div className="mb-4">
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {hint && <p className="text-[11px] text-text-dim mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Implement `KeyboardHint.tsx`**

```tsx
import { Kbd } from '../primitives/Kbd.js';

export interface KeyboardHintProps {
  keys: readonly string[];  // e.g. ['⌘', 'K'] or ['g', 'p']
  label?: string;
}

export function KeyboardHint({ keys, label }: KeyboardHintProps) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-text-faint">
      {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      {label && <span>{label}</span>}
    </span>
  );
}
```

- [ ] **Step 3: Export**

`src/web/ui/patterns/index.ts`:

```ts
export * from './FormRow.js';
export * from './KeyboardHint.js';
```

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/patterns
git commit -m "feat(ui): FormRow + KeyboardHint patterns"
```

---

### Task 15: EmptyState, LoadingState, ErrorState

**Files:**
- Create: `src/web/ui/patterns/EmptyState.tsx`
- Create: `src/web/ui/patterns/LoadingState.tsx`
- Create: `src/web/ui/patterns/ErrorState.tsx`
- Create: `src/web/ui/patterns/EmptyState.test.tsx`
- Modify: `src/web/ui/patterns/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyState } from './EmptyState.js';
import { LoadingState } from './LoadingState.js';
import { ErrorState } from './ErrorState.js';

describe('EmptyState', () => {
  it('shows title and action', () => {
    render(<EmptyState title="No projects yet" description="Create one" action={<button>Create</button>} />);
    expect(screen.getByText(/no projects/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('renders a status message', () => {
    render(<LoadingState label="Loading" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('renders the message', () => {
    render(<ErrorState message="boom" />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Implement**

`EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  hint?: ReactNode;
}

export function EmptyState({ title, description, action, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 p-8 border border-dashed border-border-strong rounded-lg">
      <h2 className="font-mono text-[13px] text-text">{title}</h2>
      {description && <p className="text-[12px] text-text-dim max-w-sm">{description}</p>}
      {action}
      {hint && <div className="mt-2">{hint}</div>}
    </div>
  );
}
```

`LoadingState.tsx`:

```tsx
export interface LoadingStateProps { label?: string; }

export function LoadingState({ label = 'Loading…' }: LoadingStateProps) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-[12px] text-text-faint p-4 font-mono">
      <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
      {label}
    </div>
  );
}
```

`ErrorState.tsx`:

```tsx
export interface ErrorStateProps { message: string; }

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div role="alert" className="p-3 border border-fail/40 bg-fail-subtle text-fail rounded-md text-[12px] font-mono">
      {message}
    </div>
  );
}
```

- [ ] **Step 4: Export + test PASS + commit**

Append to `index.ts`:

```ts
export * from './EmptyState.js';
export * from './LoadingState.js';
export * from './ErrorState.js';
```

Run: `npx vitest run src/web/ui/patterns/EmptyState.test.tsx` — PASS.

```bash
git add src/web/ui/patterns
git commit -m "feat(ui): EmptyState, LoadingState, ErrorState patterns"
```

---

### Task 16: SplitPane

**Files:**
- Create: `src/web/ui/patterns/SplitPane.tsx`
- Create: `src/web/ui/patterns/SplitPane.test.tsx`
- Modify: `src/web/ui/patterns/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SplitPane } from './SplitPane.js';

describe('SplitPane', () => {
  it('renders left and right panels', () => {
    render(<SplitPane left={<div>L</div>} right={<div>R</div>} />);
    expect(screen.getByText('L')).toBeInTheDocument();
    expect(screen.getByText('R')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `SplitPane.tsx`**

```tsx
import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  leftWidth?: string;   // e.g. '380px' or '40%'
  className?: string;
}

export function SplitPane({ left, right, leftWidth = '360px', className }: SplitPaneProps) {
  return (
    <div className={cn('h-full min-h-0 flex', className)}>
      <aside
        className="shrink-0 border-r border-border-strong bg-surface min-h-0 overflow-auto"
        style={{ width: leftWidth }}
      >
        {left}
      </aside>
      <main className="flex-1 min-w-0 min-h-0 overflow-auto">{right}</main>
    </div>
  );
}
```

- [ ] **Step 3: Export + test + commit**

Append to `index.ts`:

```ts
export * from './SplitPane.js';
```

Run: `npx vitest run src/web/ui/patterns/SplitPane.test.tsx` — PASS.

```bash
git add src/web/ui/patterns
git commit -m "feat(ui): SplitPane pattern"
```

---

## Phase 4: Data components

### Task 17: StatCard, ProgressBar, Sparkline

**Files:**
- Create: `src/web/ui/data/StatCard.tsx`
- Create: `src/web/ui/data/ProgressBar.tsx`
- Create: `src/web/ui/data/Sparkline.tsx`
- Create: `src/web/ui/data/StatCard.test.tsx`
- Create: `src/web/ui/data/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatCard } from './StatCard.js';
import { ProgressBar } from './ProgressBar.js';

describe('StatCard', () => {
  it('renders label, value, delta', () => {
    render(<StatCard label="Active" value="1" delta="running" tone="accent" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });
});

describe('ProgressBar', () => {
  it('computes width as percentage', () => {
    render(<ProgressBar value={25} max={100} aria-label="tokens" />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });
});
```

- [ ] **Step 2: Implement `StatCard.tsx`**

```tsx
import { cn } from '../cn.js';

export type StatTone = 'default' | 'accent' | 'ok' | 'fail' | 'warn';

export interface StatCardProps {
  label: string;
  value: string | number;
  delta?: string;
  tone?: StatTone;
}

const TONE: Record<StatTone, string> = {
  default: 'text-text',
  accent: 'text-accent',
  ok: 'text-ok',
  fail: 'text-fail',
  warn: 'text-warn',
};

export function StatCard({ label, value, delta, tone = 'default' }: StatCardProps) {
  return (
    <div className="bg-surface border border-border-strong rounded-lg px-4 py-2.5 min-w-[110px] flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</span>
      <span className={cn('font-mono text-[20px] font-semibold tracking-[-0.02em]', TONE[tone])}>{value}</span>
      {delta && <span className="font-mono text-[10px] text-ok">{delta}</span>}
    </div>
  );
}
```

- [ ] **Step 3: Implement `ProgressBar.tsx`**

```tsx
export interface ProgressBarProps {
  value: number;
  max?: number;
  'aria-label': string;
}

export function ProgressBar({ value, max = 100, ...aria }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={aria['aria-label']}
      className="h-1 w-full bg-surface-sunken rounded-full overflow-hidden"
    >
      <span className="block h-full bg-accent rounded-full transition-all duration-base ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}
```

- [ ] **Step 4: Implement `Sparkline.tsx`**

```tsx
export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  'aria-label': string;
}

export function Sparkline({ values, width = 140, height = 28, ...aria }: SparklineProps) {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg role="img" aria-label={aria['aria-label']} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline fill="none" stroke="var(--accent)" strokeWidth="1.5" points={points} />
    </svg>
  );
}
```

- [ ] **Step 5: Export + tests + commit**

`src/web/ui/data/index.ts`:

```ts
export * from './StatCard.js';
export * from './ProgressBar.js';
export * from './Sparkline.js';
```

Run: `npx vitest run src/web/ui/data/StatCard.test.tsx` — PASS.

```bash
git add src/web/ui/data
git commit -m "feat(ui): StatCard, ProgressBar, Sparkline data components"
```

---

### Task 18: TimestampRelative, CodeBlock, FilterChip, DiffRow

**Files:**
- Create: `src/web/ui/data/TimestampRelative.tsx`
- Create: `src/web/ui/data/CodeBlock.tsx`
- Create: `src/web/ui/data/FilterChip.tsx`
- Create: `src/web/ui/data/DiffRow.tsx`
- Create: `src/web/ui/data/TimestampRelative.test.tsx`
- Modify: `src/web/ui/data/index.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TimestampRelative } from './TimestampRelative.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
});

describe('TimestampRelative', () => {
  it('formats "just now" for < 10s', () => {
    render(<TimestampRelative iso="2026-04-22T11:59:55Z" />);
    expect(screen.getByText(/now/i)).toBeInTheDocument();
  });

  it('formats minutes', () => {
    render(<TimestampRelative iso="2026-04-22T11:55:00Z" />);
    expect(screen.getByText(/5m/i)).toBeInTheDocument();
  });

  it('formats hours', () => {
    render(<TimestampRelative iso="2026-04-22T09:00:00Z" />);
    expect(screen.getByText(/3h/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `TimestampRelative.tsx`**

```tsx
export interface TimestampRelativeProps { iso: string; }

export function TimestampRelative({ iso }: TimestampRelativeProps) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000; // seconds
  let text: string;
  if (diff < 10) text = 'now';
  else if (diff < 60) text = `${Math.round(diff)}s`;
  else if (diff < 3600) text = `${Math.round(diff / 60)}m`;
  else if (diff < 86400) text = `${Math.round(diff / 3600)}h`;
  else text = `${Math.round(diff / 86400)}d`;
  return <time dateTime={iso} title={new Date(iso).toLocaleString()} className="font-mono text-[11px] text-text-faint">{text}</time>;
}
```

- [ ] **Step 3: Implement `CodeBlock.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function CodeBlock({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn('font-mono text-[11px] px-1.5 py-0.5 rounded-sm bg-surface-raised border border-border', className)}
      {...rest}
    />
  );
}
```

- [ ] **Step 4: Implement `FilterChip.tsx`**

```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface FilterChipProps extends HTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function FilterChip({ active, className, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      data-active={active ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[11px] font-mono border transition-colors duration-fast ease-out',
        active
          ? 'bg-accent-subtle text-accent-strong border-accent'
          : 'bg-surface-raised text-text-dim border-border hover:text-text',
        className,
      )}
      {...rest}
    />
  );
}
```

- [ ] **Step 5: Implement `DiffRow.tsx`**

```tsx
export interface DiffRowProps {
  status: 'added' | 'modified' | 'removed' | 'renamed';
  filename: string;
  href?: string;
  additions: number;
  deletions: number;
}

const STATUS_CHAR: Record<DiffRowProps['status'], string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  renamed: 'R',
};

export function DiffRow({ status, filename, href, additions, deletions }: DiffRowProps) {
  return (
    <div className="grid grid-cols-[18px_1fr_40px_40px] items-center gap-2 px-2 py-0.5 border-b border-border font-mono text-[11px] last:border-0">
      <span className="text-accent text-center">{STATUS_CHAR[status]}</span>
      {href ? <a href={href} target="_blank" rel="noreferrer" className="text-accent truncate">{filename}</a> : <span className="text-text truncate">{filename}</span>}
      <span className="text-right text-ok">+{additions}</span>
      <span className="text-right text-fail">−{deletions}</span>
    </div>
  );
}
```

- [ ] **Step 6: Export + tests + commit**

Append to `index.ts`:

```ts
export * from './TimestampRelative.js';
export * from './CodeBlock.js';
export * from './FilterChip.js';
export * from './DiffRow.js';
```

Run: `npx vitest run src/web/ui/data/TimestampRelative.test.tsx` — PASS.

```bash
git add src/web/ui/data
git commit -m "feat(ui): TimestampRelative, CodeBlock, FilterChip, DiffRow"
```

---

## Phase 5: /design showcase route

### Task 19: `/design` route with all primitives

**Files:**
- Create: `src/web/pages/Design.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Implement `Design.tsx`**

```tsx
import { useState } from 'react';
import {
  Button, IconButton, Link, Kbd, Pill, StatusDot, Tag,
  Input, Textarea, FieldLabel, Toggle, Checkbox, Select,
  Card, Section, Tabs, Dialog, Drawer, Menu, Tooltip, Table, THead, TR, TH, TD,
} from '@ui/primitives/index.js';
import { FormRow, KeyboardHint, EmptyState, LoadingState, ErrorState, SplitPane } from '@ui/patterns/index.js';
import { StatCard, ProgressBar, Sparkline, TimestampRelative, CodeBlock, FilterChip, DiffRow } from '@ui/data/index.js';
import { toggleTheme } from '@ui/theme.js';

export function DesignPage() {
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [tab, setTab] = useState<'terminal' | 'files' | 'github'>('terminal');
  const [chip, setChip] = useState('all');
  const [toggle, setToggle] = useState(true);
  const [check, setCheck] = useState(false);

  return (
    <div className="p-6 space-y-8 max-w-6xl">
      <header className="flex items-center justify-between border-b border-border pb-3">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Design · showcase</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={toggleTheme}>Toggle theme</Button>
          <KeyboardHint keys={['⌘', 'K']} label="search" />
        </div>
      </header>

      <Section title="Buttons">
        <div className="flex items-center gap-2 flex-wrap">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <IconButton aria-label="settings">⚙</IconButton>
          <Link href="#">A link</Link>
        </div>
      </Section>

      <Section title="Pills, Dots, Tags, Kbd, Code">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="ok">succeeded</Pill>
          <Pill tone="run">running</Pill>
          <Pill tone="fail">failed</Pill>
          <Pill tone="warn">cancelled</Pill>
          <Pill tone="wait">queued</Pill>
          <StatusDot tone="ok" aria-label="ok" />
          <StatusDot tone="run" aria-label="run" />
          <Tag>main</Tag>
          <CodeBlock>feat/recent-prompts</CodeBlock>
          <Kbd>⌘</Kbd><Kbd>K</Kbd>
        </div>
      </Section>

      <Section title="Form primitives">
        <div className="max-w-md space-y-3">
          <FormRow label="Project name" hint="Human-readable."><Input placeholder="My project" /></FormRow>
          <FormRow label="Branch"><Input mono placeholder="feat/branch-name" /></FormRow>
          <FormRow label="Prompt"><Textarea mono rows={3} placeholder="Describe what Claude should do…" /></FormRow>
          <FormRow label="Notifications">
            <div className="flex items-center gap-2">
              <Toggle checked={toggle} onChange={setToggle} aria-label="enable notifications" />
              <span className="text-[12px] text-text-dim">enabled</span>
            </div>
          </FormRow>
          <FormRow label="I agree">
            <div className="flex items-center gap-2">
              <Checkbox checked={check} onChange={setCheck} id="agree" aria-label="agree" />
              <label htmlFor="agree" className="text-[12px] text-text-dim">Accept terms</label>
            </div>
          </FormRow>
          <FormRow label="Backend">
            <Select><option>claude</option><option>codex</option></Select>
          </FormRow>
        </div>
      </Section>

      <Section title="Tabs + Drawer + Dialog + Menu + Tooltip">
        <div className="space-y-4">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'terminal', label: 'terminal' },
            { value: 'files', label: 'files', count: 3 },
            { value: 'github', label: 'github' },
          ]} />
          <Drawer open={drawer} onToggle={setDrawer} header={<span>files (3)</span>}>
            <div className="p-3 space-y-1">
              <DiffRow status="modified" filename="src/web/App.tsx" additions={12} deletions={3} />
              <DiffRow status="added" filename="src/web/ui/primitives/Button.tsx" additions={48} deletions={0} />
            </div>
          </Drawer>
          <div className="flex items-center gap-3">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Menu
              trigger={<Button variant="ghost">Actions ▾</Button>}
              items={[
                { id: 'follow', label: 'Follow up', onSelect: () => {} },
                { id: 'cancel', label: 'Cancel', onSelect: () => {} },
                { id: 'delete', label: 'Delete', onSelect: () => {}, danger: true },
              ]}
            />
            <Tooltip label="Switch theme (⌘T)"><Button variant="ghost" onClick={toggleTheme}>Theme</Button></Tooltip>
          </div>
          <Dialog open={dialog} onClose={() => setDialog(false)} title="Confirm delete">
            <p className="text-[12px] text-text-dim mb-4">This removes the run and its transcript.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>Delete</Button>
            </div>
          </Dialog>
        </div>
      </Section>

      <Section title="Cards, Stats, Progress, Sparkline">
        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <Card>
            <div className="p-4"><p className="text-[12px] text-text-dim">A card. Primitive container.</p></div>
          </Card>
          <div className="flex gap-2">
            <StatCard label="Active" value={1} tone="accent" delta="running" />
            <StatCard label="Today" value={7} delta="↑ 3 vs yesterday" />
            <StatCard label="Failed" value={1} tone="fail" />
          </div>
          <div>
            <p className="text-[11px] text-text-faint mb-1">Tokens used — 1.2M / 5M</p>
            <ProgressBar value={1_200_000} max={5_000_000} aria-label="tokens" />
          </div>
          <Sparkline values={[3, 5, 2, 7, 4, 9, 6, 11, 8, 14]} aria-label="runs per day" />
        </div>
      </Section>

      <Section title="Filters + Table">
        <div className="flex gap-2 mb-3">
          <FilterChip active={chip === 'all'} onClick={() => setChip('all')}>all</FilterChip>
          <FilterChip active={chip === 'running'} onClick={() => setChip('running')}>running</FilterChip>
          <FilterChip active={chip === 'failed'} onClick={() => setChip('failed')}>failed</FilterChip>
        </div>
        <Table>
          <THead><TR><TH>Run</TH><TH>Branch</TH><TH>State</TH><TH>Started</TH></TR></THead>
          <tbody>
            <TR><TD>#42</TD><TD>feat/recent-prompts</TD><TD><Pill tone="run">running</Pill></TD><TD><TimestampRelative iso={new Date(Date.now() - 2 * 60_000).toISOString()} /></TD></TR>
            <TR><TD>#41</TD><TD>fix/dark-terminal</TD><TD><Pill tone="ok">succeeded</Pill></TD><TD><TimestampRelative iso={new Date(Date.now() - 14 * 60_000).toISOString()} /></TD></TR>
          </tbody>
        </Table>
      </Section>

      <Section title="Empty, Loading, Error states">
        <div className="grid grid-cols-3 gap-3">
          <EmptyState title="No projects yet" description="Create one to start running agents." action={<Button>Create project</Button>} hint={<KeyboardHint keys={['c', 'p']} />} />
          <LoadingState />
          <ErrorState message="Failed to load runs. Check connection and retry." />
        </div>
      </Section>

      <Section title="SplitPane">
        <div className="h-64 border border-border-strong rounded-lg overflow-hidden">
          <SplitPane
            left={<div className="p-3 text-[12px] text-text-dim">master list</div>}
            right={<div className="p-3 text-[12px] text-text-dim">detail pane</div>}
          />
        </div>
      </Section>
    </div>
  );
}
```

- [ ] **Step 2: Add `/design` route in `App.tsx`**

Insert a new `<Route>` before the catch-all:

```tsx
<Route path="/design" element={<DesignPage />} />
```

And add the import:

```tsx
import { DesignPage } from './pages/Design.js';
```

- [ ] **Step 3: Manual verification**

Start dev server, open `http://localhost:5173/design`, toggle theme, click through the dialog/menu/tabs/drawer.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/Design.tsx src/web/App.tsx
git commit -m "feat(ui): /design showcase route for all primitives"
```

---

## Phase 6: Shell

### Task 20: KeyMap — global keyboard controller with registry

**Files:**
- Create: `src/web/ui/shell/KeyMap.ts`
- Create: `src/web/ui/shell/KeyMap.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { keymap } from './KeyMap.js';

beforeEach(() => { keymap._reset(); });

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}

describe('KeyMap', () => {
  it('registers and fires a single-key binding', () => {
    const fn = vi.fn();
    keymap.register({ chord: 'n', handler: fn });
    press('n');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not fire single-key bindings while typing in inputs', () => {
    const fn = vi.fn();
    keymap.register({ chord: 'n', handler: fn });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('n');
    expect(fn).not.toHaveBeenCalled();
    input.remove();
  });

  it('fires modifier bindings even while typing', () => {
    const fn = vi.fn();
    keymap.register({ chord: 'mod+k', handler: fn });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('k', { metaKey: true });
    expect(fn).toHaveBeenCalledOnce();
    input.remove();
  });

  it('resolves leader sequences within 1s', async () => {
    const fn = vi.fn();
    keymap.register({ chord: 'g p', handler: fn });
    press('g'); press('p');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('unregister removes the binding', () => {
    const fn = vi.fn();
    const off = keymap.register({ chord: 'n', handler: fn });
    off();
    press('n');
    expect(fn).not.toHaveBeenCalled();
  });

  it('respects when predicate', () => {
    const fn = vi.fn();
    let enabled = false;
    keymap.register({ chord: 'n', handler: fn, when: () => enabled });
    press('n');
    expect(fn).not.toHaveBeenCalled();
    enabled = true;
    press('n');
    expect(fn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Implement `KeyMap.ts`**

```ts
export interface Binding {
  chord: string;                        // 'n' | 'mod+k' | 'g p' | '?'
  handler: (e: KeyboardEvent) => void;
  when?: () => boolean;
  description?: string;
}

type ParsedChord =
  | { kind: 'single'; key: string; mod: boolean; shift: boolean }
  | { kind: 'leader'; a: string; b: string };

function parse(chord: string): ParsedChord {
  const parts = chord.trim().split(/\s+/);
  if (parts.length === 2) return { kind: 'leader', a: parts[0].toLowerCase(), b: parts[1].toLowerCase() };
  const tokens = parts[0].split('+').map((t) => t.toLowerCase());
  const mod = tokens.includes('mod') || tokens.includes('cmd') || tokens.includes('ctrl');
  const shift = tokens.includes('shift');
  const key = tokens.filter((t) => !['mod', 'cmd', 'ctrl', 'shift'].includes(t)).pop() || '';
  return { kind: 'single', key, mod, shift };
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !('tagName' in el)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

class KeyMap {
  private bindings = new Set<Binding>();
  private pendingLeader: string | null = null;
  private leaderTimer: ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  register(b: Binding): () => void {
    this.bindings.add(b);
    this.attach();
    return () => { this.bindings.delete(b); };
  }

  list(): readonly Binding[] { return [...this.bindings]; }

  _reset(): void {
    this.bindings.clear();
    this.pendingLeader = null;
    if (this.leaderTimer) clearTimeout(this.leaderTimer);
    this.leaderTimer = null;
  }

  private attach(): void {
    if (this.attached || typeof window === 'undefined') return;
    window.addEventListener('keydown', this.onKey);
    this.attached = true;
  }

  private onKey = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    const typing = isTyping(e.target);
    const mod = e.metaKey || e.ctrlKey;

    // Pending leader sequence?
    if (this.pendingLeader) {
      const a = this.pendingLeader;
      this.pendingLeader = null;
      if (this.leaderTimer) { clearTimeout(this.leaderTimer); this.leaderTimer = null; }
      for (const b of this.bindings) {
        const p = parse(b.chord);
        if (p.kind === 'leader' && p.a === a && p.b === k && (!b.when || b.when())) {
          e.preventDefault();
          b.handler(e);
          return;
        }
      }
      // fall through — may still match a non-leader single key
    }

    for (const b of this.bindings) {
      const p = parse(b.chord);
      if (p.kind === 'single') {
        if (p.key !== k) continue;
        if (p.mod !== mod) continue;
        if (!p.mod && typing) continue;
        if (b.when && !b.when()) continue;
        e.preventDefault();
        b.handler(e);
        return;
      }
    }

    // Maybe start a leader sequence
    for (const b of this.bindings) {
      const p = parse(b.chord);
      if (p.kind === 'leader' && p.a === k && !mod && !typing && (!b.when || b.when())) {
        this.pendingLeader = k;
        this.leaderTimer = setTimeout(() => { this.pendingLeader = null; this.leaderTimer = null; }, 1000);
        return;
      }
    }
  };
}

export const keymap = new KeyMap();

// React hook: register bindings with automatic cleanup.
import { useEffect } from 'react';

export function useKeyBinding(binding: Binding | null, deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!binding) return;
    return keymap.register(binding);
     
  }, deps);
}
```

- [ ] **Step 4: Run tests; expect PASS**

Run: `npx vitest run src/web/ui/shell/KeyMap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/shell/KeyMap.ts src/web/ui/shell/KeyMap.test.ts
git commit -m "feat(ui): KeyMap global keyboard controller + useKeyBinding hook"
```

---

### Task 21: CommandPalette with cmdk and registered groups

**Files:**
- Create: `src/web/ui/shell/CommandPalette.tsx`
- Create: `src/web/ui/shell/CommandPalette.test.tsx`
- Create: `src/web/ui/shell/paletteRegistry.ts`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandPalette } from './CommandPalette.js';
import { paletteRegistry } from './paletteRegistry.js';

beforeEach(() => { paletteRegistry._reset(); });

describe('CommandPalette', () => {
  it('renders static actions registered via the registry', async () => {
    const run = vi.fn();
    paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: async () => [{ id: 'theme', label: 'Toggle theme', onSelect: run }],
    });
    render(<CommandPalette open={true} onClose={() => {}} />);
    await userEvent.keyboard('the');
    expect(screen.getByText('Toggle theme')).toBeInTheDocument();
  });

  it('selecting an item calls onSelect and closes', async () => {
    const onClose = vi.fn();
    const run = vi.fn();
    paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: async () => [{ id: 'a', label: 'Do a thing', onSelect: run }],
    });
    render(<CommandPalette open={true} onClose={onClose} />);
    await userEvent.click(screen.getByText('Do a thing'));
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement `paletteRegistry.ts`**

```ts
export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;       // right-side hint (e.g. 'c r')
  keywords?: string[]; // extra search tokens
  onSelect: () => void;
}

export interface PaletteGroup {
  id: string;
  label: string;
  items: (query: string) => Promise<readonly PaletteItem[]> | readonly PaletteItem[];
}

type Listener = () => void;

class Registry {
  private groups = new Map<string, PaletteGroup>();
  private listeners = new Set<Listener>();

  register(g: PaletteGroup): () => void {
    this.groups.set(g.id, g);
    this.emit();
    return () => { this.groups.delete(g.id); this.emit(); };
  }

  list(): readonly PaletteGroup[] { return [...this.groups.values()]; }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  _reset(): void { this.groups.clear(); this.listeners.clear(); }

  private emit(): void { for (const l of this.listeners) l(); }
}

export const paletteRegistry = new Registry();
```

- [ ] **Step 3: Implement `CommandPalette.tsx`**

```tsx
import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { paletteRegistry, type PaletteGroup, type PaletteItem } from './paletteRegistry.js';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<readonly PaletteGroup[]>([]);
  const [items, setItems] = useState<Record<string, readonly PaletteItem[]>>({});

  useEffect(() => {
    const update = () => setGroups(paletteRegistry.list());
    update();
    return paletteRegistry.subscribe(update);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all(
      groups.map(async (g) => [g.id, await g.items(query)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setItems(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [open, query, groups]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center pt-[15vh] bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <Command
        label="Command palette"
        className="w-full max-w-xl bg-surface-raised border border-border-strong rounded-lg shadow-popover overflow-hidden"
      >
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Type to search actions, runs, projects…"
          className="w-full px-4 py-3 bg-transparent font-mono text-[13px] text-text placeholder:text-text-faint border-b border-border outline-none"
        />
        <Command.List className="max-h-80 overflow-auto py-1">
          <Command.Empty className="px-4 py-3 text-[12px] text-text-faint">No results.</Command.Empty>
          {groups.map((g) => {
            const rows = items[g.id] ?? [];
            if (rows.length === 0) return null;
            return (
              <Command.Group key={g.id} heading={g.label} className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-text-faint">
                {rows.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.label} ${it.keywords?.join(' ') ?? ''}`}
                    onSelect={() => { it.onSelect(); onClose(); }}
                    className="flex items-center gap-2 px-4 py-1.5 text-[12px] text-text-dim aria-selected:bg-accent-subtle aria-selected:text-accent-strong cursor-pointer"
                  >
                    <span className="flex-1 min-w-0 truncate">{it.label}</span>
                    {it.hint && <span className="font-mono text-[11px] text-text-faint">{it.hint}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
      </Command>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 4: Tests PASS**

Run: `npx vitest run src/web/ui/shell/CommandPalette.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/web/ui/shell/CommandPalette.tsx src/web/ui/shell/CommandPalette.test.tsx src/web/ui/shell/paletteRegistry.ts
git commit -m "feat(ui): CommandPalette with cmdk and group registry"
```

---

### Task 22: Sidebar with view registry

**Files:**
- Create: `src/web/ui/shell/Sidebar.tsx`
- Create: `src/web/ui/shell/sidebarRegistry.ts`
- Create: `src/web/ui/shell/Sidebar.test.tsx`

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import { Sidebar } from './Sidebar.js';
import { sidebarRegistry } from './sidebarRegistry.js';

beforeEach(() => { sidebarRegistry._reset(); });

describe('Sidebar', () => {
  it('renders registered views grouped', () => {
    sidebarRegistry.register({ id: 'runs', group: 'views', label: 'All runs', route: '/runs' });
    sidebarRegistry.register({ id: 'settings', group: 'views', label: 'Settings', route: '/settings' });
    render(
      <MemoryRouter initialEntries={['/runs']}>
        <Sidebar projects={[{ id: 1, name: 'fbi/claude-ui', runs: 12, hasRunning: true }]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('fbi/claude-ui')).toBeInTheDocument();
    expect(screen.getByText('All runs')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement `sidebarRegistry.ts`**

```ts
export interface SidebarView {
  id: string;
  group: 'views';                // future: 'admin' | etc.
  label: string;
  route: string;
  order?: number;
}

type Listener = () => void;

class Registry {
  private views = new Map<string, SidebarView>();
  private listeners = new Set<Listener>();

  register(v: SidebarView): () => void {
    this.views.set(v.id, v);
    this.emit();
    return () => { this.views.delete(v.id); this.emit(); };
  }

  list(): readonly SidebarView[] {
    return [...this.views.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  _reset(): void { this.views.clear(); this.listeners.clear(); }

  private emit(): void { for (const l of this.listeners) l(); }
}

export const sidebarRegistry = new Registry();
```

- [ ] **Step 3: Implement `Sidebar.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '../cn.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { sidebarRegistry, type SidebarView } from './sidebarRegistry.js';

export interface SidebarProject {
  id: number;
  name: string;
  runs: number;
  hasRunning: boolean;
}

export interface SidebarProps {
  projects: readonly SidebarProject[];
  collapsed?: boolean;
  onCreateProject?: () => void;
}

export function Sidebar({ projects, collapsed }: SidebarProps) {
  const [views, setViews] = useState<readonly SidebarView[]>([]);
  useEffect(() => {
    const update = () => setViews(sidebarRegistry.list());
    update();
    return sidebarRegistry.subscribe(update);
  }, []);

  return (
    <div className={cn('h-full flex flex-col bg-surface border-r border-border-strong transition-all duration-base ease-out', collapsed ? 'w-[52px]' : 'w-[220px]')}>
      {!collapsed && <Group label="Projects" />}
      {projects.map((p) => (
        <NavLink
          key={p.id}
          to={`/projects/${p.id}`}
          className={({ isActive }) => cn(
            'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[12px] transition-colors duration-fast ease-out',
            isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
          )}
        >
          {p.hasRunning && <StatusDot tone="run" aria-label="running" />}
          <span className="truncate">{collapsed ? p.name.slice(0, 2) : p.name}</span>
          {!collapsed && <span className="ml-auto font-mono text-[10px] text-text-faint">{p.runs}</span>}
        </NavLink>
      ))}
      {!collapsed && <Group label="Views" />}
      {views.map((v) => (
        <NavLink
          key={v.id}
          to={v.route}
          className={({ isActive }) => cn(
            'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[12px] transition-colors duration-fast ease-out',
            isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
          )}
        >
          <span className="truncate">{collapsed ? v.label.slice(0, 2) : v.label}</span>
        </NavLink>
      ))}
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</div>;
}
```

- [ ] **Step 4: Tests PASS + commit**

```bash
git add src/web/ui/shell/Sidebar.tsx src/web/ui/shell/sidebarRegistry.ts src/web/ui/shell/Sidebar.test.tsx
git commit -m "feat(ui): Sidebar shell + view registry"
```

---

### Task 23: Topbar

**Files:**
- Create: `src/web/ui/shell/Topbar.tsx`

- [ ] **Step 1: Implement**

```tsx
import type { ReactNode } from 'react';
import { Kbd } from '../primitives/Kbd.js';

export interface TopbarProps {
  breadcrumb: ReactNode;
  onOpenPalette: () => void;
}

export function Topbar({ breadcrumb, onOpenPalette }: TopbarProps) {
  return (
    <header className="h-[32px] flex items-center gap-3 px-3 border-b border-border-strong bg-surface">
      <span className="font-semibold text-[13px] tracking-tight">▮ FBI</span>
      <span className="font-mono text-[11px] text-text-faint truncate">{breadcrumb}</span>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-auto flex items-center gap-1 text-[11px] text-text-faint hover:text-text"
        aria-label="Open command palette"
      >
        <Kbd>⌘</Kbd><Kbd>K</Kbd><span>search</span>
      </button>
    </header>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/ui/shell/Topbar.tsx
git commit -m "feat(ui): Topbar shell"
```

---

### Task 24: StatusBar with item registry

**Files:**
- Create: `src/web/ui/shell/StatusBar.tsx`
- Create: `src/web/ui/shell/statusRegistry.ts`

- [ ] **Step 1: Implement `statusRegistry.ts`**

```ts
import type { ReactNode } from 'react';

export interface StatusItem {
  id: string;
  side: 'left' | 'right';
  order?: number;
  render: () => ReactNode;
}

type Listener = () => void;

class Registry {
  private items = new Map<string, StatusItem>();
  private listeners = new Set<Listener>();

  register(i: StatusItem): () => void {
    this.items.set(i.id, i);
    this.emit();
    return () => { this.items.delete(i.id); this.emit(); };
  }

  list(side: 'left' | 'right'): readonly StatusItem[] {
    return [...this.items.values()].filter((i) => i.side === side).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  _reset(): void { this.items.clear(); this.listeners.clear(); }

  private emit(): void { for (const l of this.listeners) l(); }
}

export const statusRegistry = new Registry();
```

- [ ] **Step 2: Implement `StatusBar.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { statusRegistry, type StatusItem } from './statusRegistry.js';

export function StatusBar() {
  const [left, setLeft] = useState<readonly StatusItem[]>([]);
  const [right, setRight] = useState<readonly StatusItem[]>([]);
  useEffect(() => {
    const update = () => {
      setLeft(statusRegistry.list('left'));
      setRight(statusRegistry.list('right'));
    };
    update();
    return statusRegistry.subscribe(update);
  }, []);
  return (
    <footer className="h-[22px] flex items-center gap-4 px-3 border-t border-border-strong bg-surface font-mono text-[10px] uppercase tracking-[0.06em] text-text-faint">
      {left.map((i) => <span key={i.id}>{i.render()}</span>)}
      <span className="ml-auto flex items-center gap-3">
        {right.map((i) => <span key={i.id}>{i.render()}</span>)}
      </span>
    </footer>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/ui/shell/StatusBar.tsx src/web/ui/shell/statusRegistry.ts
git commit -m "feat(ui): StatusBar shell + item registry"
```

---

### Task 25: AppShell + replace Layout

**Files:**
- Create: `src/web/ui/shell/AppShell.tsx`
- Create: `src/web/ui/shell/index.ts`
- Modify: `src/web/App.tsx`
- Delete: `src/web/components/Layout.tsx`

- [ ] **Step 1: Implement `AppShell.tsx`**

```tsx
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Sidebar, type SidebarProject } from './Sidebar.js';
import { Topbar } from './Topbar.js';
import { StatusBar } from './StatusBar.js';
import { CommandPalette } from './CommandPalette.js';
import { keymap } from './KeyMap.js';

export interface AppShellProps {
  projects: readonly SidebarProject[];
  children: ReactNode;
  /** when true, hide the sidebar (used by full-width pages like /settings, /design) */
  hideSidebar?: boolean;
}

export function AppShell({ projects, children, hideSidebar }: AppShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const location = useLocation();

  const breadcrumb = useMemo(() => location.pathname, [location.pathname]);

  useEffect(() => {
    const offK = keymap.register({ chord: 'mod+k', description: 'Open command palette', handler: () => setPaletteOpen(true) });
    const offB = keymap.register({ chord: 'mod+b', description: 'Toggle sidebar', handler: () => setSidebarCollapsed((v) => !v) });
    return () => { offK(); offB(); };
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-text">
      <Topbar breadcrumb={breadcrumb} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex-1 min-h-0 flex">
        {!hideSidebar && <Sidebar projects={projects} collapsed={sidebarCollapsed} />}
        <main className="flex-1 min-w-0 min-h-0">{children}</main>
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
```

- [ ] **Step 2: Create `src/web/ui/shell/index.ts`**

```ts
export * from './AppShell.js';
export * from './Sidebar.js';
export * from './sidebarRegistry.js';
export * from './Topbar.js';
export * from './StatusBar.js';
export * from './statusRegistry.js';
export * from './CommandPalette.js';
export * from './paletteRegistry.js';
export * from './KeyMap.js';
```

- [ ] **Step 3: Rewrite `src/web/App.tsx`** to mount `AppShell`, load projects, register core palette/sidebar entries.

```tsx
import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppShell } from '@ui/shell/index.js';
import { sidebarRegistry } from '@ui/shell/sidebarRegistry.js';
import { paletteRegistry } from '@ui/shell/paletteRegistry.js';
import { statusRegistry } from '@ui/shell/statusRegistry.js';
import { keymap } from '@ui/shell/KeyMap.js';
import { toggleTheme } from '@ui/theme.js';
import { api } from './lib/api.js';
import { useRunWatcher } from './hooks/useRunWatcher.js';
import type { Project, Run } from '@shared/types.js';
import { ProjectsPage } from './pages/Projects.js';
import { NewProjectPage } from './pages/NewProject.js';
import { ProjectDetailPage } from './pages/ProjectDetail.js';
import { EditProjectPage } from './pages/EditProject.js';
import { NewRunPage } from './pages/NewRun.js';
import { RunsPage } from './pages/Runs.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { SettingsPage } from './pages/Settings.js';
import { DesignPage } from './pages/Design.js';

function Shell({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const location = useLocation();
  const hideSidebar = location.pathname === '/settings' || location.pathname === '/design';

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => {});
  }, []);
  useEffect(() => {
    const reload = () => void api.listRuns().then(setRuns).catch(() => {});
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, []);

  const active = runs.filter((r) => r.state === 'running').length;
  const today = runs.filter((r) => Date.now() - new Date(r.created_at).getTime() < 86400_000).length;

  const projectRows = projects.map((p) => ({
    id: p.id,
    name: p.name,
    runs: runs.filter((r) => r.project_id === p.id).length,
    hasRunning: runs.some((r) => r.project_id === p.id && r.state === 'running'),
  }));

  return (
    <AppShell projects={projectRows} hideSidebar={hideSidebar}>
      {children}
      <StatusRegistrations active={active} today={today} />
    </AppShell>
  );
}

function StatusRegistrations({ active, today }: { active: number; today: number }) {
  useEffect(() => {
    const off1 = statusRegistry.register({ id: 'conn', side: 'left', order: 0, render: () => <>● <span className="text-ok">connected</span></> });
    const off2 = statusRegistry.register({ id: 'active', side: 'left', order: 1, render: () => <>{active} <span className="text-run">running</span></> });
    const off3 = statusRegistry.register({ id: 'today', side: 'left', order: 2, render: () => <>{today} today</> });
    return () => { off1(); off2(); off3(); };
  }, [active, today]);
  return null;
}

export function App() {
  const [notif, setNotif] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    void api.getSettings().then((s) => setNotif(s.notifications_enabled));
  }, []);
  useRunWatcher(notif);

  useEffect(() => {
    // register sidebar views
    const offRuns = sidebarRegistry.register({ id: 'runs', group: 'views', label: 'All runs', route: '/runs', order: 10 });
    const offSet = sidebarRegistry.register({ id: 'settings', group: 'views', label: 'Settings', route: '/settings', order: 20 });

    // register palette actions
    const offActions = paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: () => [
        { id: 'new-project', label: 'New project', hint: 'c p', onSelect: () => nav('/projects/new') },
        { id: 'runs', label: 'Go to all runs', hint: 'g r', onSelect: () => nav('/runs') },
        { id: 'settings', label: 'Open settings', hint: 'g s', onSelect: () => nav('/settings') },
        { id: 'toggle-theme', label: 'Toggle theme', onSelect: () => toggleTheme() },
      ],
    });

    // register leader/single-key bindings
    const offGR = keymap.register({ chord: 'g r', description: 'Go to runs', handler: () => nav('/runs') });
    const offGS = keymap.register({ chord: 'g s', description: 'Go to settings', handler: () => nav('/settings') });
    const offCP = keymap.register({ chord: 'c p', description: 'Create project', handler: () => nav('/projects/new') });

    return () => { offRuns(); offSet(); offActions(); offGR(); offGS(); offCP(); };
  }, [nav]);

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/runs" replace />} />
        <Route path="/projects/new" element={<NewProjectPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/projects/:id/edit" element={<EditProjectPage />} />
        <Route path="/projects/:id/runs/new" element={<NewRunPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/design" element={<DesignPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
```

- [ ] **Step 4: Delete old `Layout.tsx`**

```bash
git rm src/web/components/Layout.tsx
```

- [ ] **Step 5: Remove the old projects list page's "No projects / Create one" behavior so the app no longer renders an empty shell when first opened.** (The new home is `/runs`; the empty-runs state is owned by the Runs feature later.)

No code change required in this step — just verify the redirect works and pages still render (ugly is fine — migrations happen in Phase 7).

- [ ] **Step 6: Full typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/ui/shell/AppShell.tsx src/web/ui/shell/index.ts src/web/App.tsx
git commit -m "feat(ui): AppShell replaces Layout; wire registries and routes"
```

---

## Phase 7: Feature migrations

Each feature task creates a `src/web/features/<name>/` directory, extracts UI from the existing `src/web/pages/<Name>.tsx` into composable components using primitives, and rewrites the page to be a thin route component. Keep behavior identical; only the rendering changes.

### Task 26: Runs feature — master list in the detail pane

**Files:**
- Create: `src/web/features/runs/RunRow.tsx`
- Create: `src/web/features/runs/RunsList.tsx`
- Create: `src/web/features/runs/RunsFilter.tsx`
- Modify: `src/web/pages/Runs.tsx`
- Modify: `src/web/pages/Projects.test.tsx` (if it asserts on classes/elements that changed; keep behavior assertions)

- [ ] **Step 1: Implement `RunRow.tsx`**

```tsx
import { NavLink } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { TimestampRelative } from '@ui/data/TimestampRelative.js';
import type { Run } from '@shared/types.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  running: 'run',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'warn',
};

export interface RunRowProps {
  run: Run;
  to: string;
}

export function RunRow({ run, to }: RunRowProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[12px] transition-colors duration-fast ease-out ${
          isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
        }`
      }
    >
      <span className="font-mono text-[11px] w-8 text-text-faint">#{run.id}</span>
      <span className="flex-1 min-w-0 truncate">{run.branch_name ?? (run.prompt.split('\n')[0] || 'untitled')}</span>
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      <TimestampRelative iso={run.created_at} />
    </NavLink>
  );
}
```

- [ ] **Step 2: Implement `RunsFilter.tsx`**

```tsx
import { Input } from '@ui/primitives/Input.js';

export interface RunsFilterProps {
  value: string;
  onChange: (v: string) => void;
}

export function RunsFilter({ value, onChange }: RunsFilterProps) {
  return (
    <div className="p-2 border-b border-border bg-surface">
      <Input
        placeholder="Filter by prompt / branch / id…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
```

- [ ] **Step 3: Implement `RunsList.tsx`**

```tsx
import { useMemo, useState } from 'react';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import type { Run } from '@shared/types.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
}

export function RunsList({ runs, toHref }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  const running = runs.filter((r) => r.state === 'running').length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">
          Runs
        </h2>
        <span className="font-mono text-[10px] text-text-faint">
          {runs.length} · {running} running
        </span>
      </div>
      <RunsFilter value={filter} onChange={setFilter} />
      <div className="flex-1 min-h-0 overflow-auto">
        {visible.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite `src/web/pages/Runs.tsx`** to use master-detail

```tsx
import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import { Button } from '@ui/primitives/Button.js';
import { KeyboardHint } from '@ui/patterns/KeyboardHint.js';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useParams();

  useEffect(() => {
    let cancelled = false;
    const load = () => api.listRuns()
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!runs) return <LoadingState label="Loading runs…" />;

  return (
    <SplitPane
      leftWidth="360px"
      left={<RunsList runs={runs} toHref={(r) => `/runs/${r.id}`} />}
      right={
        params.id ? <Outlet /> : (
          <div className="h-full flex items-center justify-center">
            <EmptyState
              title="Select a run"
              description="Pick a run from the list, or create a new one."
              hint={<KeyboardHint keys={['j', '/', 'k']} label="navigate" />}
            />
          </div>
        )
      }
    />
  );
}
```

- [ ] **Step 5: Wire nested route in `App.tsx`** — RunsPage hosts a nested `/:id` so the list stays persistent. Replace:

```tsx
<Route path="/runs" element={<RunsPage />} />
<Route path="/runs/:id" element={<RunDetailPage />} />
```

with:

```tsx
<Route path="/runs" element={<RunsPage />}>
  <Route path=":id" element={<RunDetailPage />} />
</Route>
```

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs src/web/pages/Runs.tsx src/web/App.tsx
git commit -m "feat(ui): migrate Runs page to master-detail with feature components"
```

---

### Task 27: ProjectDetail — scoped runs master list + project header

**Files:**
- Create: `src/web/features/projects/ProjectHeader.tsx`
- Modify: `src/web/pages/ProjectDetail.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Implement `ProjectHeader.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { Button } from '@ui/primitives/Button.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import type { Project } from '@shared/types.js';

export interface ProjectHeaderProps { project: Project; }

export function ProjectHeader({ project }: ProjectHeaderProps) {
  return (
    <div className="px-3 py-2 border-b border-border bg-surface flex items-center gap-2">
      <div className="min-w-0">
        <h1 className="text-[14px] font-semibold truncate">{project.name}</h1>
        <p className="text-[10px] text-text-faint truncate"><CodeBlock>{project.repo_url}</CodeBlock></p>
      </div>
      <div className="ml-auto flex gap-1.5">
        <Link to={`/projects/${project.id}/edit`}><Button variant="ghost" size="sm">Edit</Button></Link>
        <Link to={`/projects/${project.id}/runs/new`}><Button size="sm">New run</Button></Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `src/web/pages/ProjectDetail.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Outlet, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';
import { ProjectHeader } from '../features/projects/ProjectHeader.js';

export function ProjectDetailPage() {
  const { id } = useParams();
  const pid = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { rid } = useParams();

  useEffect(() => {
    let cancelled = false;
    const loadRuns = () => api.listProjectRuns(pid)
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    void api.getProject(pid).then((p) => { if (!cancelled) setProject(p); });
    loadRuns();
    const t = setInterval(loadRuns, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pid]);

  if (error) return <ErrorState message={error} />;
  if (!project || !runs) return <LoadingState label="Loading project…" />;

  return (
    <SplitPane
      leftWidth="360px"
      left={
        <div className="h-full flex flex-col min-h-0">
          <ProjectHeader project={project} />
          <div className="flex-1 min-h-0"><RunsList runs={runs} toHref={(r) => `/projects/${pid}/runs/${r.id}`} /></div>
        </div>
      }
      right={
        rid ? <Outlet /> : (
          <div className="h-full flex items-center justify-center">
            <EmptyState title="Select a run" description="Or create a new run for this project." />
          </div>
        )
      }
    />
  );
}
```

- [ ] **Step 3: Update the route tree** so ProjectDetail hosts nested `runs/:rid`

Replace:

```tsx
<Route path="/projects/:id" element={<ProjectDetailPage />} />
<Route path="/projects/:id/runs/new" element={<NewRunPage />} />
```

with:

```tsx
<Route path="/projects/:id" element={<ProjectDetailPage />}>
  <Route path="runs/:rid" element={<RunDetailPage />} />
  <Route path="runs/new" element={<NewRunPage />} />
</Route>
```

And teach `RunDetailPage` to accept either `:id` or `:rid` param (see Task 29).

- [ ] **Step 4: Commit**

```bash
git add src/web/features/projects/ProjectHeader.tsx src/web/pages/ProjectDetail.tsx src/web/App.tsx
git commit -m "feat(ui): migrate ProjectDetail to master-detail with scoped runs list"
```

---

### Task 28: Projects list + feature dir + New Project form

**Files:**
- Create: `src/web/features/projects/ProjectList.tsx` (used by `/projects/new` sibling — shows projects alongside the form)
- Modify: `src/web/pages/Projects.tsx`
- Modify: `src/web/pages/NewProject.tsx`

- [ ] **Step 1: Implement `ProjectList.tsx`**

```tsx
import { NavLink } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { StatusDot } from '@ui/primitives/StatusDot.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';

export interface ProjectListProps {
  projects: readonly Project[];
  runs: readonly Run[];
}

export function ProjectList({ projects, runs }: ProjectListProps) {
  return (
    <div className="flex flex-col">
      <h2 className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint">Projects</h2>
      {projects.map((p) => {
        const hasRunning = runs.some((r) => r.project_id === p.id && r.state === 'running');
        const count = runs.filter((r) => r.project_id === p.id).length;
        return (
          <NavLink
            key={p.id}
            to={`/projects/${p.id}`}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[12px] transition-colors duration-fast ease-out ${
                isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
              }`
            }
          >
            {hasRunning && <StatusDot tone="run" aria-label="running" />}
            <div className="min-w-0">
              <div className="truncate">{p.name}</div>
              <div className="text-[10px] text-text-faint truncate"><CodeBlock>{p.repo_url}</CodeBlock></div>
            </div>
            <span className="ml-auto font-mono text-[10px] text-text-faint">{count}</span>
          </NavLink>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `src/web/pages/Projects.tsx`** — this page is only used as the root of `/projects/new`; home redirects to `/runs`. Keep it minimal — it mounts a projects list on the left and an Outlet on the right.

```tsx
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { LoadingState, EmptyState } from '@ui/patterns/index.js';
import { Button } from '@ui/primitives/Button.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { ProjectList } from '../features/projects/ProjectList.js';
import { Link } from 'react-router-dom';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    void api.listProjects().then(setProjects);
    void api.listRuns().then(setRuns);
  }, []);

  if (!projects) return <LoadingState label="Loading projects…" />;

  return (
    <SplitPane
      leftWidth="320px"
      left={
        <div className="flex flex-col h-full">
          <ProjectList projects={projects} runs={runs} />
          {projects.length === 0 && (
            <div className="p-4"><EmptyState title="No projects yet" action={<Link to="/projects/new"><Button>Create project</Button></Link>} /></div>
          )}
        </div>
      }
      right={<Outlet />}
    />
  );
}
```

- [ ] **Step 3: Rewrite `src/web/pages/NewProject.tsx`** using primitives.

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button } from '@ui/primitives/index.js';
import { ErrorState, Section } from '@ui/patterns/index.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { api } from '../lib/api.js';

function splitLines(v: string): string[] {
  return v.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function NewProjectPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [instructions, setInstructions] = useState('');
  const [marketplaces, setMarketplaces] = useState('');
  const [plugins, setPlugins] = useState('');
  const [devcontainerJson, setDevcontainerJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const p = await api.createProject({
        name, repo_url: repoUrl, default_branch: defaultBranch,
        instructions: instructions.trim() || null,
        devcontainer_override_json: devcontainerJson.trim() || null,
        git_author_name: gitAuthorName.trim() || null,
        git_author_email: gitAuthorEmail.trim() || null,
        marketplaces: splitLines(marketplaces),
        plugins: splitLines(plugins),
        mem_mb: null, cpus: null, pids_limit: null,
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">New project</h1>

      <Section title="Identity">
        <FormRow label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required /></FormRow>
        <FormRow label="Repo URL (SSH)"><Input mono value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required /></FormRow>
        <FormRow label="Default branch"><Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} required /></FormRow>
      </Section>

      <Section title="Git (overrides)">
        <FormRow label="Author name"><Input mono value={gitAuthorName} onChange={(e) => setGitAuthorName(e.target.value)} /></FormRow>
        <FormRow label="Author email"><Input mono value={gitAuthorEmail} onChange={(e) => setGitAuthorEmail(e.target.value)} /></FormRow>
      </Section>

      <Section title="Agent">
        <FormRow label="Project-level instructions" hint="Prepended after the global prompt, before the run prompt.">
          <Textarea mono rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </FormRow>
      </Section>

      <Section title="Plugins">
        <FormRow label="Extra marketplaces (one per line; merged with global defaults)">
          <Textarea mono rows={3} value={marketplaces} onChange={(e) => setMarketplaces(e.target.value)} />
        </FormRow>
        <FormRow label="Extra plugins (name@marketplace; one per line)">
          <Textarea mono rows={3} value={plugins} onChange={(e) => setPlugins(e.target.value)} />
        </FormRow>
      </Section>

      <Section title="Devcontainer">
        <JsonEditor
          label="Override JSON (used when repo has no .devcontainer/devcontainer.json)"
          value={devcontainerJson}
          onChange={setDevcontainerJson}
        />
      </Section>

      {error && <ErrorState message={error} />}
      <Button type="submit" disabled={submitting}>{submitting ? 'Creating…' : 'Create project'}</Button>
    </form>
  );
}
```

- [ ] **Step 4: Update `Projects.test.tsx`** — rewrite to assert the new structure ("Projects" heading, list items linking to `/projects/:id`, empty-state button). Keep semantic assertions; drop class-based ones.

- [ ] **Step 5: Run tests; commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/web/features/projects src/web/pages/Projects.tsx src/web/pages/NewProject.tsx src/web/pages/Projects.test.tsx
git commit -m "feat(ui): migrate Projects + NewProject to primitives and master-detail"
```

---

### Task 29: RunDetail — header + SplitPane + right rail + Terminal restyle

**Files:**
- Create: `src/web/features/runs/RunHeader.tsx`
- Create: `src/web/features/runs/RunSidePanel.tsx`
- Create: `src/web/features/runs/RunTerminal.tsx`
- Modify: `src/web/components/Terminal.tsx` (read colors from CSS vars)
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Restyle `Terminal.tsx`** to pull xterm theme from CSS vars

In `Terminal.tsx`, add a helper that reads computed tokens and applies them on mount + on theme change. Sketch:

```tsx
function readTheme(): { background: string; foreground: string; cursor: string } {
  const s = getComputedStyle(document.documentElement);
  return {
    background: s.getPropertyValue('--surface-sunken').trim(),
    foreground: s.getPropertyValue('--text').trim(),
    cursor: s.getPropertyValue('--accent').trim(),
  };
}
```

Apply `term.options.theme = readTheme()` on mount and whenever a `class`-change `MutationObserver` on `document.documentElement` fires (detects `.light` toggle). Drop hardcoded black/white colors.

- [ ] **Step 2: Implement `RunHeader.tsx`**

```tsx
import { useNavigate } from 'react-router-dom';
import { Button, Pill, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import { Menu } from '@ui/primitives/Menu.js';
import type { Run } from '@shared/types.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};

export interface RunHeaderProps {
  run: Run;
  onCancel: () => void;
  onDelete: () => void;
}

export function RunHeader({ run, onCancel, onDelete }: RunHeaderProps) {
  const nav = useNavigate();
  const canFollowUp = run.state !== 'running' && run.state !== 'queued' && run.branch_name;
  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-border-strong bg-surface">
      <h1 className="text-[14px] font-semibold">Run #{run.id}</h1>
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      {run.branch_name && <CodeBlock>{run.branch_name}{run.head_commit ? `@${run.head_commit.slice(0,8)}` : ''}</CodeBlock>}
      <div className="ml-auto flex gap-1.5">
        {canFollowUp && <Button variant="ghost" size="sm" onClick={() => nav(`/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`)}>Follow up</Button>}
        {run.state === 'running' && <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>}
        <Menu
          trigger={<Button variant="ghost" size="sm">More ▾</Button>}
          items={[
            { id: 'delete', label: 'Delete run', danger: true, onSelect: onDelete, disabled: run.state === 'running' },
          ]}
        />
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Implement `RunSidePanel.tsx`** (right rail — metadata, related, GitHub)

```tsx
import { Link } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import { TimestampRelative } from '@ui/data/TimestampRelative.js';
import type { Run } from '@shared/types.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', running: 'run', succeeded: 'ok', failed: 'fail', cancelled: 'warn',
};

export interface RunSidePanelProps {
  run: Run;
  siblings: readonly Run[];
  github: { pr?: { number: number; url: string; title: string; state: string } | null; checks?: { state: string; passed: number; failed: number; total: number } | null; github_available: boolean } | null;
  onCreatePr: () => void;
  creatingPr: boolean;
}

export function RunSidePanel({ run, siblings, github, onCreatePr, creatingPr }: RunSidePanelProps) {
  return (
    <aside className="w-[200px] shrink-0 border-l border-border-strong bg-surface p-2 overflow-auto">
      <Group label="Info">
        <Row label="project"><CodeBlock>#{run.project_id}</CodeBlock></Row>
        <Row label="started"><TimestampRelative iso={run.created_at} /></Row>
        {run.branch_name && <Row label="branch"><CodeBlock>{run.branch_name}</CodeBlock></Row>}
      </Group>

      {github && run.state === 'succeeded' && (
        <Group label="GitHub">
          {!github.github_available ? (
            <p className="text-[11px] text-text-faint">no gh / non-github</p>
          ) : github.pr ? (
            <>
              <a href={github.pr.url} target="_blank" rel="noreferrer" className="block text-[11px] text-accent underline">
                PR #{github.pr.number}
              </a>
              <p className="text-[11px] text-text-dim truncate">{github.pr.title}</p>
              {github.checks && (
                <p className="text-[11px] text-text-faint mt-1">
                  CI: <span className={github.checks.state === 'success' ? 'text-ok' : github.checks.state === 'failure' ? 'text-fail' : 'text-text-faint'}>
                    {github.checks.state}
                  </span> ({github.checks.passed}/{github.checks.total})
                </p>
              )}
            </>
          ) : (
            <button
              onClick={onCreatePr}
              disabled={creatingPr}
              className="text-[11px] text-accent hover:text-accent-strong disabled:opacity-50"
            >
              {creatingPr ? 'Creating…' : 'Create PR'}
            </button>
          )}
        </Group>
      )}

      {siblings.length > 0 && (
        <Group label="Related">
          {siblings.map((s) => (
            <Link key={s.id} to={`/runs/${s.id}`} className="flex items-center gap-1 text-[11px] text-text-dim hover:text-text py-0.5">
              <span className="font-mono">#{s.id}</span>
              <Pill tone={TONE[s.state]}>{s.state}</Pill>
              <span className="truncate text-text-faint">{s.branch_name}</span>
            </Link>
          ))}
        </Group>
      )}
    </aside>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">{label}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center gap-1 text-[11px] text-text-dim py-0.5"><span className="text-text-faint">{label}</span><span className="ml-auto">{children}</span></div>;
}
```

- [ ] **Step 4: Implement `RunTerminal.tsx`** — thin wrapper around the existing `Terminal` that fills the pane.

```tsx
import { Terminal } from '../../components/Terminal.js';

export function RunTerminal({ runId, interactive }: { runId: number; interactive: boolean }) {
  return (
    <div className="flex-1 min-h-0 bg-surface-sunken">
      <Terminal runId={runId} interactive={interactive} />
    </div>
  );
}
```

- [ ] **Step 5: Rewrite `src/web/pages/RunDetail.tsx`** (drawer added in next task)

```tsx
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { RunHeader } from '../features/runs/RunHeader.js';
import { RunTerminal } from '../features/runs/RunTerminal.js';
import { RunSidePanel } from '../features/runs/RunSidePanel.js';

export function RunDetailPage() {
  const params = useParams();
  const runId = Number(params.id ?? params.rid);
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [gh, setGh] = useState<Awaited<ReturnType<typeof api.getRunGithub>> | null>(null);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [, setProject] = useState<Project | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.getRun(runId);
        if (alive) setRun(r);
      } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    void api.getRunSiblings(run.id).then(setSiblings).catch(() => setSiblings([]));
    void api.getProject(run.project_id).then(setProject).catch(() => {});
  }, [run?.id]);

  useEffect(() => {
    if (!run || run.state !== 'succeeded') return;
    let alive = true;
    const load = async () => {
      try { const g = await api.getRunGithub(run.id); if (alive) setGh(g); } catch { /* ignore */ }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [run?.id, run?.state]);

  if (!run) return <LoadingState label="Loading run…" />;
  const interactive = run.state === 'running' || run.state === 'queued';

  async function cancel() {
    if (!confirm('Cancel this run?')) return;
    try { await api.deleteRun(runId); } catch { /* ignore */ }
  }
  async function remove() {
    if (!confirm('Delete this run and its transcript?')) return;
    try { await api.deleteRun(runId); nav(-1); } catch { /* ignore */ }
  }

  async function createPr() {
    setCreatingPr(true);
    try { await api.createRunPr(run!.id); const g = await api.getRunGithub(run!.id); setGh(g); }
    catch (e) { alert(String(e)); }
    finally { setCreatingPr(false); }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <RunHeader run={run} onCancel={cancel} onDelete={remove} />
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <RunTerminal runId={run.id} interactive={interactive} />
        </div>
        <RunSidePanel run={run} siblings={siblings} github={gh} onCreatePr={createPr} creatingPr={creatingPr} />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs/RunHeader.tsx src/web/features/runs/RunSidePanel.tsx src/web/features/runs/RunTerminal.tsx src/web/components/Terminal.tsx src/web/pages/RunDetail.tsx
git commit -m "feat(ui): migrate RunDetail to split pane with header + terminal + right rail"
```

---

### Task 30: Run detail bottom drawer (files / prompt / github tabs)

**Files:**
- Create: `src/web/features/runs/RunDrawer.tsx`
- Create: `src/web/features/runs/FilesTab.tsx`
- Create: `src/web/features/runs/PromptTab.tsx`
- Create: `src/web/features/runs/GithubTab.tsx`
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Implement `FilesTab.tsx`**

```tsx
import { DiffRow } from '@ui/data/DiffRow.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import type { Project } from '@shared/types.js';

export interface FilesTabProps {
  diff: { github_available: boolean; head: string; files: Array<{ status: string; filename: string; additions: number; deletions: number }> } | null;
  project: Project | null;
}

export function FilesTab({ diff, project }: FilesTabProps) {
  if (!diff) return <LoadingState label="Loading diff…" />;
  if (!diff.github_available) return <p className="p-3 text-[11px] text-text-faint">GitHub CLI not available or non-GitHub remote.</p>;
  if (diff.files.length === 0) return <p className="p-3 text-[11px] text-text-faint">No files changed.</p>;
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  return (
    <div className="py-1">
      {diff.files.map((f) => (
        <DiffRow
          key={f.filename}
          status={(['added', 'modified', 'removed', 'renamed'] as const).find((s) => s.startsWith(f.status.toLowerCase())) ?? 'modified'}
          filename={f.filename}
          href={repo ? `https://github.com/${repo}/blob/${diff.head}/${f.filename}` : undefined}
          additions={f.additions}
          deletions={f.deletions}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `PromptTab.tsx`**

```tsx
export function PromptTab({ prompt }: { prompt: string }) {
  return <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap text-text-dim">{prompt}</pre>;
}
```

- [ ] **Step 3: Implement `GithubTab.tsx`** (summary card)

```tsx
import { Pill } from '@ui/primitives/Pill.js';

export interface GithubTabProps {
  github: { pr?: { number: number; url: string; title: string; state: string } | null; checks?: { state: string; passed: number; failed: number; total: number } | null; github_available: boolean } | null;
}

export function GithubTab({ github }: GithubTabProps) {
  if (!github) return <p className="p-3 text-[11px] text-text-faint">Loading…</p>;
  if (!github.github_available) return <p className="p-3 text-[11px] text-text-faint">GitHub CLI not available or non-GitHub remote.</p>;
  return (
    <div className="p-3 space-y-2 text-[12px]">
      {github.pr ? (
        <a href={github.pr.url} target="_blank" rel="noreferrer" className="text-accent">PR #{github.pr.number} — {github.pr.title}</a>
      ) : (
        <p className="text-text-dim">No PR yet.</p>
      )}
      {github.checks && (
        <p>CI: <Pill tone={github.checks.state === 'success' ? 'ok' : github.checks.state === 'failure' ? 'fail' : 'wait'}>{github.checks.state}</Pill> ({github.checks.passed}/{github.checks.total} passed, {github.checks.failed} failed)</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `RunDrawer.tsx`**

```tsx
import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';

export type RunTab = 'files' | 'prompt' | 'github';

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  filesCount: number;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({ open, onToggle, filesCount, children }: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('files');
  return (
    <Drawer
      open={open}
      onToggle={onToggle}
      header={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'files', label: 'files', count: filesCount },
            { value: 'prompt', label: 'prompt' },
            { value: 'github', label: 'github' },
          ]}
        />
      }
    >
      <div className="max-h-[35vh] overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
```

- [ ] **Step 5: Wire drawer into `RunDetail.tsx`**

In `RunDetail.tsx`, add state + keybinding, fetch diff, and render `RunDrawer` between the terminal and the status bar (inside the left column of the inner flex). Insert:

```tsx
const [drawerOpen, setDrawerOpen] = useState(true);
const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.getRunDiff>> | null>(null);

useEffect(() => {
  if (!run || run.state !== 'succeeded') return;
  void api.getRunDiff(run.id).then(setDiff).catch(() => {});
}, [run?.id, run?.state]);

useKeyBinding({ chord: 'mod+j', handler: () => setDrawerOpen((v) => !v), description: 'Toggle run drawer' });
```

Import `useKeyBinding` from `@ui/shell/KeyMap.js`. Then in the JSX below the terminal:

```tsx
<RunDrawer
  open={drawerOpen}
  onToggle={setDrawerOpen}
  filesCount={diff?.files.length ?? 0}
>
  {(t) => t === 'files' ? <FilesTab diff={diff} project={project} />
       : t === 'prompt' ? <PromptTab prompt={run.prompt} />
       : <GithubTab github={gh} />}
</RunDrawer>
```

(Change the earlier `const [, setProject]` back to a full state pair: `const [project, setProject] = useState<Project | null>(null);`)

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs/RunDrawer.tsx src/web/features/runs/FilesTab.tsx src/web/features/runs/PromptTab.tsx src/web/features/runs/GithubTab.tsx src/web/pages/RunDetail.tsx
git commit -m "feat(ui): RunDetail bottom drawer with files/prompt/github tabs + ⌘J toggle"
```

---

### Task 31: NewRun form migration + RecentPromptsDropdown refactor

**Files:**
- Modify: `src/web/pages/NewRun.tsx`
- Modify: `src/web/components/RecentPromptsDropdown.tsx`

- [ ] **Step 1: Refactor `RecentPromptsDropdown.tsx`** to use `Select` primitive. Replace internal native `<select>` and hand-rolled styling with:

```tsx
import { useEffect, useState } from 'react';
import { Select } from '@ui/primitives/Select.js';
import { FieldLabel } from '@ui/primitives/FieldLabel.js';
import { api } from '../lib/api.js';

export interface RecentPromptsDropdownProps {
  projectId: number;
  onPick: (prompt: string) => void;
}

export function RecentPromptsDropdown({ projectId, onPick }: RecentPromptsDropdownProps) {
  const [prompts, setPrompts] = useState<string[]>([]);
  useEffect(() => {
    void api.getRecentPrompts(projectId).then(setPrompts).catch(() => setPrompts([]));
  }, [projectId]);
  if (prompts.length === 0) return null;
  return (
    <div>
      <FieldLabel>Recent prompts</FieldLabel>
      <Select defaultValue="" onChange={(e) => { if (e.target.value) onPick(e.target.value); }}>
        <option value="" disabled>Pick a recent prompt…</option>
        {prompts.map((p, i) => <option key={i} value={p}>{p.slice(0, 80)}</option>)}
      </Select>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `src/web/pages/NewRun.tsx`**

```tsx
import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button } from '@ui/primitives/index.js';
import { ErrorState } from '@ui/patterns/ErrorState.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState(searchParams.get('branch') ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      const run = await api.createRun(pid, prompt, branch);
      nav(`/projects/${pid}/runs/${run.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  useKeyBinding({ chord: 'mod+enter', handler: () => void submit(), description: 'Submit run' }, []);

  if (!Number.isFinite(pid)) return <ErrorState message="Invalid project ID." />;

  return (
    <form onSubmit={submit} className="max-w-3xl mx-auto p-6 space-y-4">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">New run</h1>
      <RecentPromptsDropdown projectId={pid} onPick={setPrompt} />
      <FormRow label="Branch name" hint="Leave blank to let Claude choose.">
        <Input mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/branch-name" />
      </FormRow>
      <FormRow label="Prompt">
        <Textarea mono rows={12} autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what Claude should do…" />
      </FormRow>
      {error && <ErrorState message={error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start run'}</Button>
        <span className="text-[11px] text-text-faint">⌘⏎ to submit</span>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/NewRun.tsx src/web/components/RecentPromptsDropdown.tsx
git commit -m "feat(ui): migrate NewRun form and RecentPromptsDropdown to primitives"
```

---

### Task 32: EditProject form + SecretsEditor refactor + JsonEditor restyle

**Files:**
- Modify: `src/web/pages/EditProject.tsx`
- Modify: `src/web/components/SecretsEditor.tsx`
- Modify: `src/web/components/JsonEditor.tsx`

- [ ] **Step 1: Restyle `JsonEditor.tsx`** — replace hardcoded `bg-gray-900` classes with `bg-surface-sunken`, text colors with `text-text`, border with `border-border-strong`. The xterm-style border + label remain but use primitives where possible.

- [ ] **Step 2: Refactor `SecretsEditor.tsx`** — replace its ad-hoc inputs/buttons with `Input`, `Button`, `FormRow`, `Section`, `EmptyState`. Keep logic (load, add, edit, delete secret rows). Swap the container classes to `bg-surface`, `border-border-strong`.

- [ ] **Step 3: Rewrite `EditProject.tsx`** using the same shape as `NewProject.tsx` (same `Section`/`FormRow` breakdown), plus a `Section title="Secrets"` that mounts `<SecretsEditor projectId={pid} />`.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/EditProject.tsx src/web/components/SecretsEditor.tsx src/web/components/JsonEditor.tsx
git commit -m "feat(ui): migrate EditProject + SecretsEditor + JsonEditor to primitives and tokens"
```

---

### Task 33: Settings page (full-width)

**Files:**
- Modify: `src/web/pages/Settings.tsx`

- [ ] **Step 1: Rewrite `Settings.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { FormRow, ErrorState, Section } from '@ui/patterns/index.js';
import { Textarea, Toggle, Button } from '@ui/primitives/index.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';

export function SettingsPage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.getSettings().then((s) => { setPrompt(s.global_prompt); setEnabled(s.notifications_enabled); });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prompt == null) return;
    setSaving(true); setSaved(false); setError(null);
    try {
      await api.updateSettings({ global_prompt: prompt, notifications_enabled: enabled });
      setSaved(true);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }

  if (prompt == null) return <LoadingState label="Loading settings…" />;

  return (
    <form onSubmit={submit} className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Settings</h1>
      <Section title="Global prompt">
        <FormRow label="Text" hint="Prepended to every run, across every project, before project instructions.">
          <Textarea mono rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </FormRow>
      </Section>
      <Section title="Notifications">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={setEnabled} aria-label="Enable run-completion notifications" />
          <span className="text-[12px] text-text-dim">Enable run-completion notifications</span>
        </div>
      </Section>
      {error && <ErrorState message={error} />}
      {saved && <p className="text-[12px] text-ok">Saved.</p>}
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
    </form>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/pages/Settings.tsx
git commit -m "feat(ui): migrate Settings to primitives and full-width layout"
```

---

### Task 34: Retire old ThemeToggle / StateBadge

**Files:**
- Delete: `src/web/components/ThemeToggle.tsx`
- Delete: `src/web/components/ThemeToggle.test.tsx`
- Delete: `src/web/components/StateBadge.tsx`
- Search: `src/web` for remaining imports of `ThemeToggle` / `StateBadge` and replace

- [ ] **Step 1: Search**

Run: `git grep -n "StateBadge\|ThemeToggle" src/web`
Replace any remaining `StateBadge` imports with `Pill` from `@ui/primitives/index.js` using the `TONE` map pattern shown in `RunRow.tsx`. Remove any remaining `ThemeToggle` imports — theme toggling happens via the command palette action and/or a future keybinding.

- [ ] **Step 2: Delete files**

```bash
git rm src/web/components/ThemeToggle.tsx src/web/components/ThemeToggle.test.tsx src/web/components/StateBadge.tsx
```

- [ ] **Step 3: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -u src/web
git commit -m "chore(ui): retire ThemeToggle and StateBadge; replaced by palette action and Pill"
```

---

## Phase 8: Polish

### Task 35: Cheatsheet overlay (`?`)

**Files:**
- Create: `src/web/ui/shell/Cheatsheet.tsx`
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Implement `Cheatsheet.tsx`**

```tsx
import { Dialog } from '@ui/primitives/Dialog.js';
import { Kbd } from '@ui/primitives/Kbd.js';
import { keymap } from './KeyMap.js';

export interface CheatsheetProps {
  open: boolean;
  onClose: () => void;
}

export function Cheatsheet({ open, onClose }: CheatsheetProps) {
  const bindings = keymap.list().filter((b) => b.description);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <ul className="space-y-1.5">
        {bindings.map((b, i) => (
          <li key={i} className="flex items-center justify-between text-[12px]">
            <span className="text-text-dim">{b.description}</span>
            <span className="flex gap-1">
              {b.chord.split(/\s+|\+/).map((k, j) => <Kbd key={j}>{k}</Kbd>)}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
```

- [ ] **Step 2: Mount + bind `?` in `App.tsx`**

In the `App` component, add local state + binding:

```tsx
const [cheatsheet, setCheatsheet] = useState(false);
// inside the useEffect that registers bindings:
const offHelp = keymap.register({ chord: '?', description: 'Show keyboard shortcuts', handler: () => setCheatsheet(true) });
// add offHelp() to the cleanup list.
```

Render `<Cheatsheet open={cheatsheet} onClose={() => setCheatsheet(false)} />` once at the bottom of the App tree (outside `<Shell>`).

Import: `import { Cheatsheet } from '@ui/shell/Cheatsheet.js';` and add `Cheatsheet` to `src/web/ui/shell/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/web/ui/shell/Cheatsheet.tsx src/web/ui/shell/index.ts src/web/App.tsx
git commit -m "feat(ui): keyboard cheatsheet overlay triggered by ?"
```

---

### Task 36: Command palette — runs and projects search groups

**Files:**
- Modify: `src/web/App.tsx`

- [ ] **Step 1: Register `Runs` and `Projects` palette groups**

Extend the `useEffect` in `App.tsx` that registers palette actions. Load a small list of recent runs + all projects once; update on palette open by subscribing to existing `/runs` + `/projects` fetches in `Shell`.

Simplest path: expose the `projects` + `runs` state from `Shell` via a shared React context (`AppDataContext`) so the palette registrations can read them and return fresh lists when invoked.

Sketch (in `App.tsx`):

```tsx
import { createContext, useContext } from 'react';

interface AppData { projects: Project[]; runs: Run[]; }
const AppDataContext = createContext<AppData>({ projects: [], runs: [] });
export const useAppData = () => useContext(AppDataContext);
```

Wrap `<Shell>` with `<AppDataContext.Provider value={{ projects, runs }}>` (requires hoisting the fetches into `App` or a shared hook; adjust accordingly).

Then inside the palette-registration effect:

```tsx
const offRunsGroup = paletteRegistry.register({
  id: 'runs',
  label: 'Runs',
  items: (q) => {
    const query = q.toLowerCase().trim();
    return dataRef.current.runs
      .filter((r) => !query || String(r.id).includes(query) || (r.branch_name ?? '').toLowerCase().includes(query) || r.prompt.toLowerCase().includes(query))
      .slice(0, 10)
      .map((r) => ({
        id: `run-${r.id}`,
        label: `#${r.id} ${r.branch_name ?? r.prompt.split('\n')[0]}`,
        hint: r.state,
        onSelect: () => nav(`/runs/${r.id}`),
      }));
  },
});
const offProjGroup = paletteRegistry.register({
  id: 'projects',
  label: 'Projects',
  items: (q) => {
    const query = q.toLowerCase().trim();
    return dataRef.current.projects
      .filter((p) => !query || p.name.toLowerCase().includes(query) || p.repo_url.toLowerCase().includes(query))
      .map((p) => ({ id: `proj-${p.id}`, label: p.name, hint: `${p.repo_url}`, onSelect: () => nav(`/projects/${p.id}`) }));
  },
});
```

`dataRef` is a `useRef<AppData>` updated via a separate `useEffect` whenever the context data changes — avoids re-registering the palette group each data tick.

- [ ] **Step 2: Verify in dev**

Open `⌘K`, type a few characters, confirm runs and projects appear under their own groups.

- [ ] **Step 3: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat(ui): runs + projects search groups in command palette"
```

---

### Task 37: Accessibility audit + focus polish

**Files:**
- Create: `src/web/ui/shell/axe.test.tsx` (dev-only smoke test using `vitest-axe`, if preferred — or manual)
- Modify: any primitives where focus is not visible

- [ ] **Step 1: Install `vitest-axe` and `axe-core`**

Run:
```bash
npm install --save-dev vitest-axe axe-core
```

- [ ] **Step 2: Write a smoke test**

`src/web/ui/shell/axe.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { MemoryRouter } from 'react-router-dom';
import { DesignPage } from '../../pages/Design.js';

describe('a11y', () => {
  it('/design has no axe violations', async () => {
    const { container } = render(<MemoryRouter><DesignPage /></MemoryRouter>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
```

- [ ] **Step 3: Run; fix any violations**

Run: `npx vitest run src/web/ui/shell/axe.test.tsx`

Likely fixes:
- Ensure every `IconButton` has `aria-label`.
- Ensure all form inputs have associated `<label>` (use `FormRow` + `htmlFor` + `id`).
- Ensure `Pill` tones still meet contrast — the tokens are tuned for it, but re-check light mode.

- [ ] **Step 4: Manual keyboard pass**

Manual: tab through `/design`, `/runs`, `/projects/:id`, `/projects/:id/runs/:rid`, `/settings`. Confirm visible focus, `Esc` closes dialog/drawer, `?` opens cheatsheet, `⌘K` opens palette. Confirm single-key bindings don't fire while typing in inputs.

- [ ] **Step 5: Commit**

```bash
git add src/web
git commit -m "feat(ui): a11y smoke test + focus/label polish"
```

---

### Task 38: Docs + README pointer + verify full suite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a short pointer to the design system in `README.md`** (beneath "Local development"):

```markdown
## Design system

The UI is built on a reusable primitive library at `src/web/ui/`. See:
- `src/web/ui/CLAUDE.md` — rules for contributors (use tokens, not hex; use primitives, not raw Tailwind).
- `/design` (dev server `http://localhost:5173/design`) — live showcase of every primitive.

Design spec: `docs/superpowers/specs/2026-04-22-fbi-ui-redesign-design.md`
```

- [ ] **Step 2: Final verification**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all PASS.

Open dev server and click through:
- `/runs` — filter, navigate with `j`/`k`, open a run, drawer toggles with `⌘J`, right rail populates.
- `/projects/:id` — same.
- `/projects/:id/runs/new` — `⌘⏎` submits.
- `/projects/new` — form sections, JSON editor.
- `/settings` — full-width, toggle saves.
- `/design` — every primitive, both themes.
- `⌘K` — actions, runs, projects appear; arrow keys + enter select.
- `?` — cheatsheet shows all bindings.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: point to design system and /design showcase"
```

---

## Self-review — spec coverage

Checked against `docs/superpowers/specs/2026-04-22-fbi-ui-redesign-design.md`:

| Spec section | Task(s) |
|---|---|
| Aesthetic + palette + typography + motion | Tasks 2 (tokens), 3 (tailwind), 4 (theme), primitives tasks 6–13 |
| Shell (AppShell, Sidebar, Topbar, StatusBar) | Tasks 22–25 |
| Command palette (⌘K) + groups | Tasks 21, 36 |
| KeyMap (single/modifier/leader) | Task 20 |
| Keyboard shortcuts vocabulary | Tasks 20, 25, 30 (⌘J), 31 (⌘⏎), 35 (?) |
| Run detail split pane + drawer + right rail | Tasks 29, 30 |
| Forms in detail pane | Tasks 28 (NewProject), 31 (NewRun), 32 (EditProject), 33 (Settings) |
| IA + routes | Task 25 (App.tsx routes), 26 (Runs nested), 27 (ProjectDetail nested) |
| Light mode | Tasks 2, 4 (tokens + theme module + no-flash script) |
| /design showcase | Task 19 |
| Component system directories + extension points | Tasks 5–25 (system laid down incrementally); registries in 21, 22, 24 |
| Contributor rules (src/web/ui/CLAUDE.md) | Task 5 |
| Testing (primitives, theme, shell, features, a11y) | Every primitive task has a test; 20, 21, 22 test shell; 37 a11y |
| Dependencies added | Task 1 |
| Out of scope (backend, new features, mobile) | Honored — no tasks touch backend/schema |

No gaps found. Migration ordering is shippable step-by-step (every task ends in a commit and the app still works).

---

## Plan complete

Plan saved to `docs/superpowers/plans/2026-04-22-fbi-ui-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
