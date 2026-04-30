# FBI UI Redesign Design

## Goal

Redesign the FBI web interface around a cohesive terminal-inspired design language ("Warp / classic-cyan") delivered as a documented, reusable primitive library. The system must carry the existing feature set (projects, runs, run detail, settings) forward to a visibly beautiful, keyboard-first UI, and must be extensible enough that upcoming features (MCP management, multiple agent backends, usage/quota views) can adopt it without rework.

## Non-goals

- No backend changes. No new endpoints, schema migrations, or API contracts.
- No new product features. MCP management, backends, and usage each ship later as their own specs, composing from this system.
- No visual-regression pipeline. Manual QA via the `/design` route.
- No user-customizable accent colors or theme plugins.

## Aesthetic

- **Direction:** Terminal / Warp — dark-first, IDE-like, keyboard-forward.
- **Palette:** Classic Warp cyan. Electric cyan (`#38bdf8`) as the primary accent, teal success, soft red fail, amber warn. Both dark and light variants of every token.
- **Typography:** Hybrid. Inter for UI chrome, JetBrains Mono for code, IDs, branches, terminal output, keyboard hints, and the command palette input. Self-hosted via `@fontsource`.
- **Motion:** Subtle. `running` pill pulses, `150ms` hover/focus transitions, cursor blink in terminal. No theatrical flourishes. `prefers-reduced-motion` respected.

## Shell and navigation

The whole app sits inside a three-region `AppShell`:

```
┌────────────────────────────────────────────────────────────────┐
│ ▮ FBI   /projects/fbi-claude-ui/runs/42      ⌘K to search      │  topbar
├───────────┬────────────────────────────────────────────────────┤
│ PROJECTS  │                                                    │
│ ● fbi…    │                                                    │
│   ops…    │         master-detail / detail content             │
│   api…    │                                                    │
│ ───────── │                                                    │
│ VIEWS     │                                                    │
│   runs    │                                                    │
│   usage   │                                                    │
│   ⚙ set   │                                                    │
├───────────┴────────────────────────────────────────────────────┤
│ ● connected · 1 running · 7 today         ⌘K · n · gp · ?      │  statusbar
└────────────────────────────────────────────────────────────────┘
```

**Primary layout — master-detail two-pane.** Every route renders inside the shell. Within most routes, a `SplitPane` shows a list on the left (master) and a per-item view on the right (detail). URL-driven: `/runs/42` highlights run #42 in the list and renders its detail on the right.

### Shell components

- **`AppShell`** — owns the three regions and theme. Mount point for keyboard and command palette.
- **`Sidebar`** (220px, collapsible to 52px icon rail) — groups: **Projects** (each with live dot indicating running status) and **Views** (All runs, Settings; future: Usage, Servers, Backends). Accepts registered views at runtime.
- **`Topbar`** — breadcrumb path in mono, right-aligned `⌘K` hint. Only branding is a square mark + "FBI".
- **`StatusBar`** — left cluster: connection state, active count, today count. Right cluster: contextual keyboard hints for the current view. Accepts registered items.
- **`CommandPalette`** (⌘K) — full fuzzy search. Groups: **Actions**, **Go to**, **Runs**, **Projects**, **Settings**, plus any registered groups. Recent queries pinned. Built on `cmdk`.
- **`KeyMap`** — global keyboard controller.

### Keyboard vocabulary

- **Single-key (pane-scoped)** — `j`/`k` navigate rows, `⏎` open, `esc` back/close, `?` cheatsheet, `/` focus filter.
- **Modifier (global)** — `⌘K` command palette, `⌘N` new run in current project, `⌘,` settings, `⌘B` toggle sidebar, `⌘J` toggle run-detail drawer, `⌘⏎` submit form.
- **Leader sequences** — `g p` projects, `g r` runs, `g s` settings, `c r` create run, `c p` create project.
- Single-key bindings never fire while a text input / textarea / contenteditable has focus.
- `?` opens a cheatsheet overlay listing all active bindings in the current context.

## Information architecture

| Route | Sidebar highlight | Master column | Detail pane |
|---|---|---|---|
| `/` | — | — | redirect → `/runs` |
| `/runs` | "All runs" | all runs, filterable by `/` | empty state or selected run |
| `/runs/:id` | "All runs" or project (by run's `project_id`) | runs list in that scope, row highlighted | run detail |
| `/projects/:id` | project | project's runs | empty state or selected run |
| `/projects/:id/runs/new` | project | project's runs | new-run form |
| `/projects/new` | — | projects list | new-project form |
| `/projects/:id/edit` | project | project's runs | edit-project form + secrets |
| `/settings` | "Settings" | — (hidden; detail full-width) | settings form |
| `/design` | — | — | live primitive showcase |

### Per-page layouts

**Runs list (master column)** — dense mono rows: `#42` · title (first line of prompt or branch) · `Pill` · relative time. `j`/`k` navigate, `⏎` open, `/` focus fuzzy filter at top. Sticky header shows counts.

**Project detail** — same run-list shape but scoped to one project. Compact project header above the list with repo URL, `[new run]` action, `c r` shortcut.

**Run detail (split pane)** — the most complex view. Terminal fills the main area; a collapsible bottom drawer (`⌘J`) hosts tabs `files` / `prompt` / `github`; a narrow right rail (180px) shows metadata (project, branch, head SHA, timing), Related runs, GitHub PR + checks. Header shows run number, branch, state pill, Cancel / Follow-up / Delete.

**New Run** — focused form in detail pane. Branch input (mono), prompt textarea (mono, tall), Recent Prompts dropdown, primary action. `⌘⏎` submits. On success, URL flips to `/runs/:newId` — form becomes run detail.

**New Project / Edit Project** — form grouped into sections (`Identity`, `Git`, `Devcontainer`, `Plugins`). `JsonEditor` for the devcontainer override. Edit adds the `SecretsEditor` section.

**Settings** — full-width (sidebar collapses). Sections: `Global prompt`, `Notifications`.

**Empty states** — every list or pane's empty state uses the shared `EmptyState` primitive: centered mono title, one-line help, primary action, keyboard hint.

## Component system

### Directory layout

```
src/web/
├── ui/
│   ├── tokens.css                 CSS vars, dark + light
│   ├── theme.ts                   light/dark switch; no-flash inline snippet
│   ├── CLAUDE.md                  contributor rules
│   ├── primitives/                Button, Pill, Kbd, Input, Textarea, Select, Checkbox,
│   │                              Toggle, Card, Tabs, Tag, StatusDot, Menu, Tooltip, Link,
│   │                              IconButton, Dialog, Drawer, Table
│   ├── patterns/                  FormRow, Section, EmptyState, SplitPane, LoadingState,
│   │                              ErrorState, KeyboardHint, Kbd sequence
│   ├── data/                      StatCard, ProgressBar, Sparkline, FilterChip,
│   │                              TimestampRelative, CodeBlock, DiffRow
│   └── shell/                     AppShell, Sidebar, Topbar, StatusBar, CommandPalette, KeyMap
├── features/
│   ├── projects/
│   ├── runs/
│   ├── settings/
│   ├── mcp/                       (future)
│   ├── usage/                     (future)
│   └── backends/                  (future)
└── pages/                         thin route components mounting features
```

### Extension points (forward-compat contract)

Future features plug into the shell without touching shell internals:

1. **`Sidebar.registerView({ id, label, icon, route, group })`** — MCP adds "Servers", Usage adds "Usage".
2. **`StatusBar.registerItem({ id, render, side, order })`** — Usage adds a token-gauge, Backends adds a backend selector.
3. **`CommandPalette.registerGroup({ id, label, search, render })`** — MCP adds fuzzy-search over servers.
4. **`KeyMap.register({ chord, when, handler })`** — context-scoped bindings with `when` predicates.
5. **`/design`** — live showcase route. Every primitive rendered with every variant and copy-pasteable usage. Canonical reference before building new UI.

### Contributor rules (`src/web/ui/CLAUDE.md`)

- Never hardcode a color, spacing, or radius — always use a token.
- Never copy primitive styling into a feature file — extend the primitive or add a variant.
- New feature = new directory under `features/`, composed from `ui/`.
- Before shipping a new primitive, add it to `/design`.
- Prefer composition (extension points) over modification for shell components.

## Design tokens

All tokens live in `src/web/ui/tokens.css` as CSS custom properties. `:root` is dark (default); `:root.light` is light mode. Tailwind's theme reads them via `var(--*)` so classes like `bg-surface` auto-switch.

### Color

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg` | `#0b0f14` | `#f8fafc` | app canvas |
| `--surface` | `#0a1218` | `#ffffff` | sidebar, topbar, statusbar, cards |
| `--surface-raised` | `#0c1722` | `#f1f5f9` | hover, dropdowns |
| `--surface-sunken` | `#060a0f` | `#eef2f7` | terminal bg |
| `--border` | `#15212d` | `#e2e8f0` | hairlines |
| `--border-strong` | `#1e2a36` | `#cbd5e1` | card/panel edges |
| `--text` | `#e2e8f0` | `#0f172a` | primary |
| `--text-dim` | `#94a3b8` | `#475569` | secondary |
| `--text-faint` | `#64748b` | `#94a3b8` | tertiary, timestamps |
| `--accent` | `#38bdf8` | `#0284c7` | primary actions, links |
| `--accent-strong` | `#7dd3fc` | `#0369a1` | hover, focused |
| `--accent-subtle` | `#082f49` | `#e0f2fe` | backgrounds, chip fills |
| `--ok` | `#34d399` | `#047857` | succeeded |
| `--ok-subtle` | `#042f2e` | `#ecfdf5` | ok pill bg |
| `--run` | `#38bdf8` | `#0284c7` | running (same hue as accent by design) |
| `--run-subtle` | `#082f49` | `#e0f2fe` | run pill bg |
| `--fail` | `#f87171` | `#b91c1c` | failed |
| `--fail-subtle` | `#450a0a` | `#fef2f2` | fail pill bg |
| `--warn` | `#fbbf24` | `#b45309` | cancelled, warnings |
| `--warn-subtle` | `#2d1c07` | `#fffbeb` | warn pill bg |
| `--focus-ring` | `#38bdf866` | `#0284c766` | 2px outline; `--shadow-focus` uses this |

### Typography

```
--font-sans: 'Inter', system-ui, -apple-system, sans-serif
--font-mono: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace
```

Self-hosted via `@fontsource/inter` (400/500/600/700) and `@fontsource/jetbrains-mono` (400/500/600).

| Token | Size / Line | Weight | Tracking | Usage |
|---|---|---|---|---|
| `--t-display` | 22 / 28 | 600 | -0.02em | page title |
| `--t-title` | 16 / 22 | 600 | -0.015em | section heading |
| `--t-body` | 13 / 20 | 400 | 0 | body |
| `--t-body-strong` | 13 / 20 | 500 | 0 | emphasis |
| `--t-caption` | 11 / 16 | 400 | 0 | help / secondary |
| `--t-label` | 10 / 14 | 600 | 0.08em, uppercase | section labels |
| `--t-mono` | 12 / 18 | 400 | 0 | code / IDs / branches |

### Spacing, radii, shadows, motion

- **Spacing** — 4px base. `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24, `--s-6` 32, `--s-7` 48.
- **Radii** — `--r-sm` 3 (pills, kbd), `--r-md` 6 (inputs, rows), `--r-lg` 8 (cards, panels), `--r-xl` 12 (dialog).
- **Shadows** — `--shadow-focus: 0 0 0 2px var(--focus-ring)`; `--shadow-card-light: 0 1px 2px rgba(15,23,42,.04), 0 4px 12px -2px rgba(15,23,42,.06)`; `--shadow-card-dark: none` (dark uses `border-strong` instead); `--shadow-popover: 0 8px 24px -6px rgba(0,0,0,.4)`.
- **Motion** — `--d-fast` 120ms, `--d-base` 180ms, `--d-slow` 320ms; easings `--e-out: cubic-bezier(.2,.8,.2,1)`, `--e-in: cubic-bezier(.4,0,1,1)`. Reduced-motion collapses all durations to `0ms`.
- **Z-index** — statusbar 10, sidebar 20, topbar 30, drawer 40, dialog 50, palette 60, toast 70.

### Tailwind config

```ts
theme: {
  extend: {
    colors: {
      bg: 'var(--bg)',
      surface: 'var(--surface)',
      'surface-raised': 'var(--surface-raised)',
      'surface-sunken': 'var(--surface-sunken)',
      border: 'var(--border)',
      'border-strong': 'var(--border-strong)',
      text: { DEFAULT: 'var(--text)', dim: 'var(--text-dim)', faint: 'var(--text-faint)' },
      accent: { DEFAULT: 'var(--accent)', strong: 'var(--accent-strong)', subtle: 'var(--accent-subtle)' },
      ok: { DEFAULT: 'var(--ok)', subtle: 'var(--ok-subtle)' },
      run: { DEFAULT: 'var(--run)', subtle: 'var(--run-subtle)' },
      fail: { DEFAULT: 'var(--fail)', subtle: 'var(--fail-subtle)' },
      warn: { DEFAULT: 'var(--warn)', subtle: 'var(--warn-subtle)' },
    },
    fontFamily: { sans: ['var(--font-sans)'], mono: ['var(--font-mono)'] },
    borderRadius: { sm: 'var(--r-sm)', md: 'var(--r-md)', lg: 'var(--r-lg)', xl: 'var(--r-xl)' },
    transitionDuration: { fast: 'var(--d-fast)', base: 'var(--d-base)', slow: 'var(--d-slow)' },
  },
},
```

Because every color / spacing / type token already reads through a CSS custom property that switches on the `.light` class, Tailwind's built-in `dark:` variant is unused — one set of utility classes works for both themes. The existing `darkMode: 'class'` setting can be removed.

### Theme switching

- `theme.ts` toggles `.light` class on `:root` and persists to `localStorage['fbi:theme']`.
- A small inline script in `index.html` reads the stored preference (fallback: `prefers-color-scheme`) and applies `.light` before first paint — prevents a flash.
- `ThemeToggle` is removed; switching is a command-palette action plus a keyboard shortcut (no modal toggle in the shell).

## Migration strategy

Each step ships a strictly-better app than the one before.

1. **Foundation (invisible)** — add `tokens.css`, Tailwind extension, fonts, theme script. No visual change.
2. **Primitives (small visible)** — build primitive library + `/design` route. Existing pages unchanged.
3. **Shell (big visible)** — replace `Layout` with `AppShell` + Sidebar/Topbar/StatusBar/CommandPalette/KeyMap. Routes unchanged; existing pages render inside.
4. **Page migrations** — rewrite one feature at a time, in this order: Runs → ProjectDetail → RunDetail → NewRun → NewProject/EditProject → Settings → home redirect. Each merge is shippable.
5. **Polish** — motion, focus management, cheatsheet overlay, command-palette ranking, edge cases (long prompts, errors, disconnected state).
6. **Docs** — finalize `src/web/ui/CLAUDE.md`, polish `/design`, add a README pointer.

### Files affected

```
NEW  src/web/ui/tokens.css
NEW  src/web/ui/theme.ts
NEW  src/web/ui/CLAUDE.md
NEW  src/web/ui/primitives/*.tsx
NEW  src/web/ui/patterns/*.tsx
NEW  src/web/ui/data/*.tsx
NEW  src/web/ui/shell/AppShell.tsx
NEW  src/web/ui/shell/Sidebar.tsx
NEW  src/web/ui/shell/Topbar.tsx
NEW  src/web/ui/shell/StatusBar.tsx
NEW  src/web/ui/shell/CommandPalette.tsx
NEW  src/web/ui/shell/KeyMap.ts
NEW  src/web/pages/Design.tsx
NEW  src/web/features/projects/*
NEW  src/web/features/runs/*
NEW  src/web/features/settings/*
EDIT tailwind.config.ts
EDIT src/web/index.css
EDIT src/web/index.html             (inline no-flash theme script)
EDIT src/web/App.tsx                 (mount AppShell, register feature views)
EDIT src/web/main.tsx
EDIT src/web/components/Terminal.tsx         (restyle to tokens; kept)
EDIT src/web/components/JsonEditor.tsx       (restyle to tokens; kept)
EDIT src/web/components/SecretsEditor.tsx    (refactor to primitives; kept)
EDIT src/web/components/RecentPromptsDropdown.tsx  (refactor to primitives)
DEL  src/web/components/Layout.tsx           (→ AppShell)
DEL  src/web/components/StateBadge.tsx       (→ Pill primitive)
DEL  src/web/components/ThemeToggle.tsx      (→ palette action + shortcut)
```

## Dependencies

Added:

- `@fontsource/inter` (400/500/600/700)
- `@fontsource/jetbrains-mono` (400/500/600)
- `cmdk` — accessible, keyboard-ready command palette primitive

Not added (hand-rolled instead): dialog / drawer primitives. If their scope balloons during implementation, swap in `@radix-ui/react-dialog` — decision deferred to implementation.

## Testing

- **Primitives** — unit tests (`@testing-library/react`) for every primitive: variants, keyboard behavior, handler invocation, ARIA roles/labels.
- **Theme** — toggling adds/removes `.light`, persists to `localStorage`; inline no-flash script sets the right class before paint.
- **Shell** —
  - `CommandPalette`: typing filters groups correctly; keyboard selection dispatches the right action; registered groups appear; `Esc` closes; focus returns to previously-focused element.
  - `KeyMap`: single-key bindings ignored while typing in inputs; leader sequences resolve (`g p`, `c r`); `when` predicates scope correctly; no conflicts between registered bindings.
  - `Sidebar`/`StatusBar` registries: register/unregister/reorder; unregistered items disappear.
- **Features** — rewrite existing tests against new components: `Projects.test.tsx`, `NewProject.test.tsx`, `JsonEditor.test.tsx`, `ThemeToggle.test.tsx` (becomes a theme-action test). Add `RunDetail.test.tsx` covering drawer tabs + right-rail metadata.
- **Accessibility** — `axe-core` check on `/design` and each primary route; every interactive element keyboard-operable; visible focus everywhere.

## Out of scope

- Backend, schema, or API changes.
- New features (MCP management, usage views, agent backends) — later specs.
- Visual-regression pipeline / snapshot tests.
- User-customizable theming.
- Mobile layout (current app is desktop-only; unchanged).

## Risks

- **Scope — full redesign is a big diff.** Mitigated by the migration strategy: every step is shippable on its own, so the branch can merge incrementally rather than as one huge PR.
- **Command palette and keyboard layer complexity.** Mitigated by using `cmdk` (battle-tested) and by deferring advanced `when`-predicate logic to the registries. Initial cheatsheet can be a static map.
- **`cmdk` footprint.** If the dep turns out heavy or awkward, a hand-rolled equivalent is tractable — the palette surface is small.
- **Terminal (xterm.js) styling.** xterm has its own theme API; we re-derive colors from tokens at mount time. Theme switches require re-applying to the xterm instance, handled via an effect on theme change.
- **Future features diverge from the system.** Mitigated by extension points (sidebar / statusbar / palette / keymap registries) and explicit contributor rules in `src/web/ui/CLAUDE.md`, plus the live `/design` reference.
