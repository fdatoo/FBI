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
