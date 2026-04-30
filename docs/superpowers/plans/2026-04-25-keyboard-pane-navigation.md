# Keyboard Pane Navigation & Run Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Mod+1–9 run/project jump shortcuts, arrow-key pane navigation with accent-top-border focus indicator, and Shift+Tab drawer tab cycling.

**Architecture:** A new `PaneFocusContext` (React context) tracks which of four pane IDs has keyboard focus and registers global arrow-key bindings via the existing `keymap` singleton. Mod+1–9 shortcuts are registered once per list component using stable refs and gated by pane focus state. A prerequisite KeyMap fix makes `shift+tab` distinct from plain `tab`.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react (happy-dom env), existing `keymap` singleton (`src/web/ui/shell/KeyMap.ts`), Tailwind CSS token classes.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/web/ui/shell/KeyMap.ts` | edit | Fix: check `e.shiftKey` when matching bindings |
| `src/web/ui/shell/KeyMap.test.ts` | create | Tests for shift-key fix |
| `src/web/hooks/useModifierKeyHeld.ts` | create | Returns `true` while Cmd/Ctrl is held |
| `src/web/hooks/useModifierKeyHeld.test.ts` | create | Tests for the hook |
| `src/web/ui/shell/PaneFocusContext.tsx` | create | Context + provider + hooks for pane focus |
| `src/web/ui/shell/PaneFocusContext.test.tsx` | create | Tests for context behaviour |
| `src/web/ui/shell/AppShell.tsx` | edit | Wrap content in `<PaneFocusProvider>` |
| `src/web/features/runs/RunRow.tsx` | edit | Add optional `shortcutLabel` prop |
| `src/web/features/runs/RunsList.tsx` | edit | Pane registration, modifier hints, mod+1–9 bindings |
| `src/web/ui/shell/Sidebar.tsx` | edit | Pane registration, modifier hints, mod+1–9 bindings |
| `src/web/pages/RunDetail.tsx` | edit | Register `run-terminal` + `run-bottom` panes; open drawer on ArrowDown |
| `src/web/features/runs/RunDrawer.tsx` | edit | Shift+Tab cycles drawer tabs |

---

## Task 1: Fix KeyMap shift-key matching

**Files:**
- Modify: `src/web/ui/shell/KeyMap.ts`
- Create: `src/web/ui/shell/KeyMap.test.ts`

- [ ] **Step 1.1: Write the failing tests**

Create `src/web/ui/shell/KeyMap.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keymap } from './KeyMap.js';

function fire(key: string, opts: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}

beforeEach(() => { keymap._reset(); });

describe('KeyMap — shift matching', () => {
  it('shift+tab does NOT fire on plain Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'shift+tab', handler });
    fire('Tab', { shiftKey: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('shift+tab DOES fire on Shift+Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'shift+tab', handler });
    fire('Tab', { shiftKey: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('plain tab binding does NOT fire on Shift+Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'tab', handler });
    fire('Tab', { shiftKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('plain tab binding fires on plain Tab', () => {
    const handler = vi.fn();
    keymap.register({ chord: 'tab', handler });
    fire('Tab', { shiftKey: false });
    expect(handler).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 1.2: Run tests to confirm failure**
```bash
npx vitest run src/web/ui/shell/KeyMap.test.ts
```
Expected: 4 FAIL (shift check not implemented).

- [ ] **Step 1.3: Fix `onKey` in `src/web/ui/shell/KeyMap.ts`**

Replace the `onKey` method (lines 62–102) with:
```ts
private onKey = (e: KeyboardEvent): void => {
  const k = e.key.toLowerCase();
  const typing = isTyping(e.target);
  const mod = e.metaKey || e.ctrlKey;
  const shift = e.shiftKey;

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
  }

  for (const b of this.bindings) {
    const p = parse(b.chord);
    if (p.kind === 'single') {
      if (p.key !== k) continue;
      if (p.mod !== mod) continue;
      if (p.shift !== shift) continue;
      if (!p.mod && typing) continue;
      if (b.when && !b.when()) continue;
      e.preventDefault();
      b.handler(e);
      return;
    }
  }

  for (const b of this.bindings) {
    const p = parse(b.chord);
    if (p.kind === 'leader' && p.a === k && !mod && !typing && (!b.when || b.when())) {
      this.pendingLeader = k;
      this.leaderTimer = setTimeout(() => { this.pendingLeader = null; this.leaderTimer = null; }, 1000);
      return;
    }
  }
};
```

- [ ] **Step 1.4: Run tests to confirm pass**
```bash
npx vitest run src/web/ui/shell/KeyMap.test.ts
```
Expected: 4 PASS.

- [ ] **Step 1.5: Commit**
```bash
git add src/web/ui/shell/KeyMap.ts src/web/ui/shell/KeyMap.test.ts
git commit -m "fix(keymap): check shift key when matching single-key bindings"
```

---

## Task 2: Add `useModifierKeyHeld` hook

**Files:**
- Create: `src/web/hooks/useModifierKeyHeld.ts`
- Create: `src/web/hooks/useModifierKeyHeld.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `src/web/hooks/useModifierKeyHeld.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useModifierKeyHeld } from './useModifierKeyHeld.js';

function fireKeydown(opts: { metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...opts })); });
}
function fireKeyup(): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); });
}

describe('useModifierKeyHeld', () => {
  it('returns false initially', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    expect(result.current).toBe(false);
  });

  it('returns true while metaKey is held', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    fireKeydown({ metaKey: true });
    expect(result.current).toBe(true);
    fireKeyup();
    expect(result.current).toBe(false);
  });

  it('returns true while ctrlKey is held', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    fireKeydown({ ctrlKey: true });
    expect(result.current).toBe(true);
    fireKeyup();
    expect(result.current).toBe(false);
  });

  it('resets on window blur', () => {
    const { result } = renderHook(() => useModifierKeyHeld());
    fireKeydown({ metaKey: true });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run tests to confirm failure**
```bash
npx vitest run src/web/hooks/useModifierKeyHeld.test.ts
```
Expected: 4 FAIL (module not found).

- [ ] **Step 2.3: Implement the hook**

Create `src/web/hooks/useModifierKeyHeld.ts`:
```ts
import { useState, useEffect } from 'react';

export function useModifierKeyHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => { if (e.metaKey || e.ctrlKey) setHeld(true); };
    const onUp = (e: KeyboardEvent): void => { if (!e.metaKey && !e.ctrlKey) setHeld(false); };
    const onBlur = (): void => setHeld(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return held;
}
```

- [ ] **Step 2.4: Run tests to confirm pass**
```bash
npx vitest run src/web/hooks/useModifierKeyHeld.test.ts
```
Expected: 4 PASS.

- [ ] **Step 2.5: Commit**
```bash
git add src/web/hooks/useModifierKeyHeld.ts src/web/hooks/useModifierKeyHeld.test.ts
git commit -m "feat: add useModifierKeyHeld hook"
```

---

## Task 3: Create `PaneFocusContext`

**Files:**
- Create: `src/web/ui/shell/PaneFocusContext.tsx`
- Create: `src/web/ui/shell/PaneFocusContext.test.tsx`

- [ ] **Step 3.1: Write failing tests**

Create `src/web/ui/shell/PaneFocusContext.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneFocusProvider, usePaneFocus, usePaneRegistration, useFocusedPane } from './PaneFocusContext.js';
import { keymap } from './KeyMap.js';

beforeEach(() => { keymap._reset(); });

function Pane({ id, order, label }: { id: Parameters<typeof usePaneFocus>[0]; order: number; label: string }) {
  usePaneRegistration(id, order);
  const { isFocused, focus } = usePaneFocus(id);
  return <div data-testid={id} data-focused={String(isFocused)} onClick={focus}>{label}</div>;
}

function FocusDisplay() {
  const f = useFocusedPane();
  return <div data-testid="focused">{f ?? 'none'}</div>;
}

function App({ panes = ['projects-sidebar', 'runs-sidebar', 'run-terminal'] as const }) {
  return (
    <PaneFocusProvider>
      <FocusDisplay />
      {panes.map((id, i) => <Pane key={id} id={id} order={i} label={id} />)}
    </PaneFocusProvider>
  );
}

function fireKey(key: string): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

describe('PaneFocusContext', () => {
  it('starts with no pane focused', () => {
    render(<App />);
    expect(screen.getByTestId('focused').textContent).toBe('none');
    expect(screen.getByTestId('projects-sidebar').dataset.focused).toBe('false');
  });

  it('clicking a pane sets it as focused', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('runs-sidebar'));
    expect(screen.getByTestId('focused').textContent).toBe('runs-sidebar');
    expect(screen.getByTestId('runs-sidebar').dataset.focused).toBe('true');
    expect(screen.getByTestId('projects-sidebar').dataset.focused).toBe('false');
  });

  it('ArrowRight from null focuses first registered pane', () => {
    render(<App />);
    fireKey('ArrowRight');
    expect(screen.getByTestId('focused').textContent).toBe('projects-sidebar');
  });

  it('ArrowRight advances to next horizontal pane', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('projects-sidebar'));
    fireKey('ArrowRight');
    expect(screen.getByTestId('focused').textContent).toBe('runs-sidebar');
  });

  it('ArrowLeft retreats to previous horizontal pane', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('runs-sidebar'));
    fireKey('ArrowLeft');
    expect(screen.getByTestId('focused').textContent).toBe('projects-sidebar');
  });

  it('ArrowRight clamps at last horizontal pane', async () => {
    render(<App />);
    await userEvent.click(screen.getByTestId('run-terminal'));
    fireKey('ArrowRight');
    expect(screen.getByTestId('focused').textContent).toBe('run-terminal');
  });

  it('ArrowDown from run-terminal sets run-bottom', async () => {
    render(<App panes={['run-terminal']} />);
    await userEvent.click(screen.getByTestId('run-terminal'));
    fireKey('ArrowDown');
    expect(screen.getByTestId('focused').textContent).toBe('run-bottom');
  });

  it('ArrowUp from run-bottom returns to run-terminal', async () => {
    render(<App panes={['run-terminal']} />);
    await userEvent.click(screen.getByTestId('run-terminal'));
    fireKey('ArrowDown');
    fireKey('ArrowUp');
    expect(screen.getByTestId('focused').textContent).toBe('run-terminal');
  });
});
```

- [ ] **Step 3.2: Run tests to confirm failure**
```bash
npx vitest run src/web/ui/shell/PaneFocusContext.test.tsx
```
Expected: 8 FAIL (module not found).

- [ ] **Step 3.3: Implement `PaneFocusContext.tsx`**

Create `src/web/ui/shell/PaneFocusContext.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { keymap } from './KeyMap.js';

export type PaneId = 'projects-sidebar' | 'runs-sidebar' | 'run-terminal' | 'run-bottom';

interface PaneEntry { id: PaneId; order: number; }

interface PaneFocusContextValue {
  focusedPane: PaneId | null;
  setFocusedPane: (id: PaneId | null) => void;
  registerPane: (id: PaneId, order: number) => () => void;
}

const PaneFocusContext = createContext<PaneFocusContextValue>({
  focusedPane: null,
  setFocusedPane: () => {},
  registerPane: () => () => {},
});

// Panes navigated by ArrowLeft / ArrowRight (horizontal axis).
const HORIZONTAL: readonly PaneId[] = ['projects-sidebar', 'runs-sidebar', 'run-terminal'];

function isSeparatorEl(el: Element | null): boolean {
  return el?.getAttribute('role') === 'separator';
}

function isInsideTerminal(el: Element | null): boolean {
  return !!el?.closest('[data-pane-id="run-terminal"]');
}

export function PaneFocusProvider({ children }: { children: ReactNode }) {
  const [focusedPane, setFocusedPane] = useState<PaneId | null>(null);
  const [panes, setPanes] = useState<PaneEntry[]>([]);

  // Keep refs so keymap handlers always see fresh state without re-registering.
  const focusedRef = useRef<PaneId | null>(null);
  const panesRef = useRef<PaneEntry[]>([]);
  focusedRef.current = focusedPane;
  panesRef.current = panes;

  const registerPane = useCallback((id: PaneId, order: number): () => void => {
    setPanes((prev) =>
      [...prev.filter((p) => p.id !== id), { id, order }].sort((a, b) => a.order - b.order),
    );
    return () => setPanes((prev) => prev.filter((p) => p.id !== id));
  }, []);

  useEffect(() => {
    const activeEl = (): Element | null => document.activeElement;
    const canNav = (): boolean => !isSeparatorEl(activeEl()) && !isInsideTerminal(activeEl());

    const offRight = keymap.register({
      chord: 'ArrowRight',
      description: 'Focus next pane',
      when: canNav,
      handler: () => {
        const cur = focusedRef.current;
        const horiz = panesRef.current.filter((p) => HORIZONTAL.includes(p.id));
        if (!horiz.length) return;
        if (cur === null) { setFocusedPane(horiz[0].id); return; }
        const idx = horiz.findIndex((p) => p.id === cur);
        if (idx < horiz.length - 1) setFocusedPane(horiz[idx + 1].id);
      },
    });

    const offLeft = keymap.register({
      chord: 'ArrowLeft',
      description: 'Focus previous pane',
      when: canNav,
      handler: () => {
        const cur = focusedRef.current;
        const horiz = panesRef.current.filter((p) => HORIZONTAL.includes(p.id));
        if (!horiz.length) return;
        if (cur === null) { setFocusedPane(horiz[horiz.length - 1].id); return; }
        const idx = horiz.findIndex((p) => p.id === cur);
        if (idx > 0) setFocusedPane(horiz[idx - 1].id);
      },
    });

    const offDown = keymap.register({
      chord: 'ArrowDown',
      when: () => focusedRef.current === 'run-terminal',
      handler: () => setFocusedPane('run-bottom'),
    });

    const offUp = keymap.register({
      chord: 'ArrowUp',
      when: () => focusedRef.current === 'run-bottom',
      handler: () => setFocusedPane('run-terminal'),
    });

    return () => { offRight(); offLeft(); offDown(); offUp(); };
  }, []);

  return (
    <PaneFocusContext.Provider value={{ focusedPane, setFocusedPane, registerPane }}>
      {children}
    </PaneFocusContext.Provider>
  );
}

/** Returns whether this pane is focused and a setter to focus it. */
export function usePaneFocus(id: PaneId): { isFocused: boolean; focus: () => void } {
  const { focusedPane, setFocusedPane } = useContext(PaneFocusContext);
  const focus = useCallback(() => setFocusedPane(id), [id, setFocusedPane]);
  return { isFocused: focusedPane === id, focus };
}

/** Registers this pane in the context while mounted. Order determines ArrowLeft/Right sequence. */
export function usePaneRegistration(id: PaneId, order: number): void {
  const { registerPane } = useContext(PaneFocusContext);
  useEffect(() => registerPane(id, order), [id, order, registerPane]);
}

/** Returns the currently focused pane ID (or null). */
export function useFocusedPane(): PaneId | null {
  return useContext(PaneFocusContext).focusedPane;
}
```

- [ ] **Step 3.4: Run tests to confirm pass**
```bash
npx vitest run src/web/ui/shell/PaneFocusContext.test.tsx
```
Expected: 8 PASS.

- [ ] **Step 3.5: Commit**
```bash
git add src/web/ui/shell/PaneFocusContext.tsx src/web/ui/shell/PaneFocusContext.test.tsx
git commit -m "feat: add PaneFocusContext with arrow-key pane navigation"
```

---

## Task 4: Wrap AppShell with `PaneFocusProvider`

**Files:**
- Modify: `src/web/ui/shell/AppShell.tsx`

- [ ] **Step 4.1: Add import and wrap**

At the top of `src/web/ui/shell/AppShell.tsx`, add:
```ts
import { PaneFocusProvider } from './PaneFocusContext.js';
```

Wrap the returned JSX:
```tsx
return (
  <PaneFocusProvider>
    <div className="h-screen w-screen flex flex-col bg-bg text-text">
      <Topbar breadcrumb={breadcrumb} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex-1 min-h-0 flex">
        {!hideSidebar && <Sidebar projects={projects} collapsed={sidebarCollapsed} />}
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">{children}</main>
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  </PaneFocusProvider>
);
```

- [ ] **Step 4.2: Run full test suite for regressions**
```bash
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 4.3: Commit**
```bash
git add src/web/ui/shell/AppShell.tsx
git commit -m "feat: wrap AppShell with PaneFocusProvider"
```

---

## Task 5: Add `shortcutLabel` prop to `RunRow`

**Files:**
- Modify: `src/web/features/runs/RunRow.tsx`

- [ ] **Step 5.1: Update `RunRow.tsx`**

Replace the entire file content:
```tsx
import { NavLink } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { Kbd } from '@ui/primitives/Kbd.js';
import type { Run } from '@shared/types.js';

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  starting: 'run',
  running: 'run',
  waiting: 'attn',
  awaiting_resume: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'wait',
  resume_failed: 'fail',
};

const MOD_SYMBOL = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl ';

export interface RunRowProps {
  run: Run;
  to: string;
  /** When provided, renders a keyboard shortcut hint badge (e.g. "1" → "⌘1"). */
  shortcutLabel?: string;
}

export function RunRow({ run, to, shortcutLabel }: RunRowProps) {
  const label = run.title || run.branch_name || run.prompt.split('\n')[0] || 'untitled';
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[14px] transition-colors duration-fast ease-out ${
          isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
        }`
      }
    >
      <span className="font-mono text-[13px] w-8 text-text-faint">#{run.id}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {run.tokens_input + run.tokens_output > 0 && (
        <span className="font-mono text-[12px] text-text-faint">{fmt(run.tokens_input + run.tokens_output)}</span>
      )}
      {shortcutLabel && (
        <Kbd className="text-[11px] shrink-0">{MOD_SYMBOL}{shortcutLabel}</Kbd>
      )}
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      <time
        dateTime={new Date(run.state_entered_at).toISOString()}
        title={`entered ${run.state} at ${new Date(run.state_entered_at).toLocaleString()}`}
        className="font-mono text-[13px] text-text-faint"
      >
        {formatRelative(run.state_entered_at)}
      </time>
    </NavLink>
  );
}

function formatRelative(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 10) return 'now';
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}
```

- [ ] **Step 5.2: Run tests**
```bash
npx vitest run
```
Expected: pass.

- [ ] **Step 5.3: Commit**
```bash
git add src/web/features/runs/RunRow.tsx
git commit -m "feat(run-row): add optional shortcutLabel prop for keyboard hints"
```

---

## Task 6: Update `RunsList` — pane focus + mod+1–9 shortcuts

**Files:**
- Modify: `src/web/features/runs/RunsList.tsx`

- [ ] **Step 6.1: Replace `RunsList.tsx` content**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RunsFilter } from './RunsFilter.js';
import { RunRow } from './RunRow.js';
import { useRunsView, applyRunsView } from './useRunsView.js';
import type { StateCounts } from './StateFilterButton.js';
import type { Run, RunState } from '@shared/types.js';
import { useKeyBinding, keymap } from '@ui/shell/KeyMap.js';
import { usePaneRegistration, usePaneFocus } from '@ui/shell/PaneFocusContext.js';
import { useModifierKeyHeld } from '../../hooks/useModifierKeyHeld.js';
import { cn } from '@ui/cn.js';

export interface RunsListProps {
  runs: readonly Run[];
  toHref: (r: Run) => string;
  currentId?: number | null;
}

const ACTIVE_STATES = new Set<RunState>(['starting', 'running', 'waiting', 'awaiting_resume', 'queued']);

const TONE_TEXT: Record<RunState, string> = {
  starting: 'text-run',
  running: 'text-run',
  waiting: 'text-attn',
  awaiting_resume: 'text-warn',
  queued: 'text-text-faint',
  succeeded: 'text-ok',
  failed: 'text-fail',
  cancelled: 'text-text-faint',
  resume_failed: 'text-fail',
};

export function RunsList({ runs, toHref, currentId }: RunsListProps) {
  const [filter, setFilter] = useState('');
  const view = useRunsView();
  const nav = useNavigate();
  const modHeld = useModifierKeyHeld();
  usePaneRegistration('runs-sidebar', 1);
  const { isFocused, focus } = usePaneFocus('runs-sidebar');

  const textFiltered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return runs;
    return runs.filter((r) =>
      String(r.id).includes(q) ||
      (r.title ?? '').toLowerCase().includes(q) ||
      (r.branch_name ?? '').toLowerCase().includes(q) ||
      r.prompt.toLowerCase().includes(q),
    );
  }, [runs, filter]);

  const counts: StateCounts = useMemo(() => {
    const base: StateCounts = {
      starting: 0, running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
      succeeded: 0, failed: 0, cancelled: 0, resume_failed: 0,
    };
    for (const r of textFiltered) base[r.state]++;
    return base;
  }, [textFiltered]);

  const result = useMemo(
    () => applyRunsView(textFiltered, { filter: view.filter, groupByState: view.groupByState }),
    [textFiltered, view.filter, view.groupByState],
  );

  const flatForNav: readonly Run[] = useMemo(() => {
    if (result.mode === 'flat') return [...result.active, ...result.rest];
    return result.groups.flatMap((g) => g.runs);
  }, [result]);

  // First 9 active runs, in the same order they appear in the list.
  const activeRuns = useMemo(
    () => flatForNav.filter((r) => ACTIVE_STATES.has(r.state)).slice(0, 9),
    [flatForNav],
  );

  // Stable refs so keymap handlers registered once can always read fresh data.
  const stateRef = useRef({ flatForNav, currentId, toHref, nav });
  stateRef.current = { flatForNav, currentId, toHref, nav };
  const activeRunsRef = useRef(activeRuns);
  activeRunsRef.current = activeRuns;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  function step(dir: 1 | -1): void {
    const { flatForNav: list, currentId: cur, toHref: href, nav: n } = stateRef.current;
    if (list.length === 0) return;
    const idx = cur == null ? -1 : list.findIndex((r) => r.id === cur);
    const nextIdx = idx < 0 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length;
    n(href(list[nextIdx]));
  }

  useKeyBinding({ chord: 'j', handler: () => step(1), description: 'Next run' }, []);
  useKeyBinding({ chord: 'k', handler: () => step(-1), description: 'Previous run' }, []);

  // Register mod+1–9 once; use refs for fresh data inside handlers.
  useEffect(() => {
    const offs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      keymap.register({
        chord: `mod+${n}`,
        description: n === 1 ? 'Jump to active run 1–9' : undefined,
        when: () => isFocusedRef.current,
        handler: () => {
          const run = activeRunsRef.current[n - 1];
          if (run) stateRef.current.nav(stateRef.current.toHref(run));
        },
      }),
    );
    return () => offs.forEach((off) => off());
  }, []);

  const running = runs.filter((r) => r.state === 'running' || r.state === 'starting').length;

  // Shortcut label for a run: only shown when modifier held, pane focused, run is active.
  const shortcutFor = (r: Run): string | undefined => {
    if (!modHeld || !isFocused) return undefined;
    const idx = activeRuns.indexOf(r);
    return idx >= 0 ? String(idx + 1) : undefined;
  };

  return (
    <div
      className={cn(
        'h-full flex flex-col min-h-0 relative border-t-2',
        isFocused ? 'border-accent' : 'border-transparent',
      )}
      onClick={focus}
    >
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Runs</h2>
        <span className="font-mono text-[12px] text-text-faint">{runs.length} · {running} running</span>
      </div>
      <RunsFilter value={filter} onChange={setFilter} view={view} counts={counts} />
      <div className="flex-1 min-h-0 overflow-auto">
        {result.mode === 'flat' ? (
          <>
            {result.active.length > 0 && (
              <div className="px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-text-faint border-b border-border">
                Active · {result.active.length}
              </div>
            )}
            {result.active.map((r) => (
              <RunRow key={r.id} run={r} to={toHref(r)} shortcutLabel={shortcutFor(r)} />
            ))}
            {result.rest.length > 0 && (
              <div className="px-3 py-1 text-[11px] uppercase tracking-[0.08em] text-text-faint border-b border-border">
                Finished · {result.rest.length}
              </div>
            )}
            {result.rest.map((r) => <RunRow key={r.id} run={r} to={toHref(r)} />)}
          </>
        ) : (
          result.groups.map((g) => (
            <div key={g.state}>
              <div
                data-testid="runs-group-label"
                className={`px-3 py-1 text-[11px] uppercase tracking-[0.08em] border-b border-border bg-surface ${TONE_TEXT[g.state]}`}
              >
                {g.state} · {g.runs.length}
              </div>
              {g.runs.map((r) => (
                <RunRow key={r.id} run={r} to={toHref(r)} shortcutLabel={shortcutFor(r)} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6.2: Run tests**
```bash
npx vitest run
```
Expected: pass.

- [ ] **Step 6.3: Commit**
```bash
git add src/web/features/runs/RunsList.tsx
git commit -m "feat(runs-list): pane focus indicator and mod+1-9 run shortcuts"
```

---

## Task 7: Update `Sidebar` — pane focus + mod+1–9 shortcuts for projects

**Files:**
- Modify: `src/web/ui/shell/Sidebar.tsx`

- [ ] **Step 7.1: Replace `Sidebar.tsx` content**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { cn } from '../cn.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { Kbd } from '../primitives/Kbd.js';
import { sidebarRegistry, type SidebarView } from './sidebarRegistry.js';
import { SidebarUsage } from '../../features/usage/SidebarUsage.js';
import { usePaneRegistration, usePaneFocus } from './PaneFocusContext.js';
import { useModifierKeyHeld } from '../../hooks/useModifierKeyHeld.js';
import { keymap } from './KeyMap.js';

export interface SidebarProject {
  id: number;
  name: string;
  runs: number;
  hasRunning: boolean;
  hasWaiting: boolean;
}

export interface SidebarProps {
  projects: readonly SidebarProject[];
  collapsed?: boolean;
  onCreateProject?: () => void;
}

const COLLAPSED_WIDTH = 52;
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 220;
const STORAGE_KEY = 'fbi-splitpane:shell-sidebar';
const MOD_SYMBOL = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl ';

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return DEFAULT_WIDTH;
  const n = Number(stored);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

export function Sidebar({ projects, collapsed }: SidebarProps) {
  const [views, setViews] = useState<readonly SidebarView[]>([]);
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const nav = useNavigate();
  const modHeld = useModifierKeyHeld();
  usePaneRegistration('projects-sidebar', 0);
  const { isFocused, focus } = usePaneFocus('projects-sidebar');

  // Active projects (hasRunning or hasWaiting), first 9 for shortcuts.
  const activeProjects = projects.filter((p) => p.hasRunning || p.hasWaiting).slice(0, 9);
  const activeProjectsRef = useRef(activeProjects);
  activeProjectsRef.current = activeProjects;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  useEffect(() => {
    const update = () => setViews(sidebarRegistry.list());
    update();
    return sidebarRegistry.subscribe(update);
  }, []);

  // Register mod+1–9 for projects once; use refs inside handlers.
  useEffect(() => {
    const offs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      keymap.register({
        chord: `mod+${n}`,
        description: n === 1 ? 'Jump to active project 1–9' : undefined,
        when: () => isFocusedRef.current,
        handler: () => {
          const project = activeProjectsRef.current[n - 1];
          if (project) nav(`/projects/${project.id}`);
        },
      }),
    );
    return () => offs.forEach((off) => off());
  }, [nav]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (ev: MouseEvent) => {
      if (!asideRef.current) return;
      const rect = asideRef.current.getBoundingClientRect();
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - rect.left));
      setWidth(next);
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setDragging(false);
      setWidth((w) => {
        localStorage.setItem(STORAGE_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth((w) => {
      const delta = e.key === 'ArrowRight' ? 16 : -16;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + delta));
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const asideWidth = collapsed ? COLLAPSED_WIDTH : width;

  // Shortcut label for a project: only when modifier held, pane focused, project is active.
  const shortcutFor = (p: SidebarProject): string | undefined => {
    if (!modHeld || !isFocused) return undefined;
    const idx = activeProjects.indexOf(p);
    return idx >= 0 ? String(idx + 1) : undefined;
  };

  return (
    <>
      <aside
        ref={asideRef}
        style={{ width: asideWidth }}
        className={cn(
          'shrink-0 h-full flex flex-col bg-surface border-t-2',
          isFocused ? 'border-accent' : 'border-transparent',
        )}
        onClick={focus}
      >
        {!collapsed && <Group label="Projects" />}
        {projects.map((p) => {
          const label = shortcutFor(p);
          return (
            <NavLink
              key={p.id}
              to={`/projects/${p.id}`}
              title={collapsed ? p.name : undefined}
              className={({ isActive }) => cn(
                'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[14px] transition-colors duration-fast ease-out',
                collapsed && 'justify-center',
                isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
              )}
            >
              {collapsed ? (
                <span className="relative w-8 h-8 flex items-center justify-center rounded-md text-lg font-semibold">
                  {p.name[0]?.toUpperCase() ?? '·'}
                  {p.hasWaiting ? (
                    <StatusDot tone="attn" aria-label="waiting for input" className="absolute -top-0.5 -right-0.5" />
                  ) : p.hasRunning ? (
                    <StatusDot tone="run" aria-label="running" className="absolute -top-0.5 -right-0.5" />
                  ) : null}
                </span>
              ) : (
                <>
                  {p.hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
                   : p.hasRunning ? <StatusDot tone="run" aria-label="running" />
                   : null}
                  <span className="truncate">{p.name}</span>
                  {label ? (
                    <Kbd className="ml-auto text-[11px] shrink-0">{MOD_SYMBOL}{label}</Kbd>
                  ) : (
                    <span className="ml-auto font-mono text-[12px] text-text-faint">{p.runs}</span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
        {collapsed
          ? <div className="border-t border-border mx-3 my-2" />
          : <Group label="Views" />}
        {views.map((v) => (
          <NavLink
            key={v.id}
            to={v.route}
            title={collapsed ? v.label : undefined}
            className={({ isActive }) => cn(
              'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[14px] transition-colors duration-fast ease-out',
              collapsed && 'justify-center',
              isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
            )}
          >
            {collapsed ? (
              <span className="w-8 h-8 flex items-center justify-center rounded-md text-lg font-semibold">
                {v.icon ?? (v.label[0]?.toUpperCase() ?? '·')}
              </span>
            ) : (
              <>
                {v.icon && <span className="w-4 h-4 flex items-center justify-center shrink-0">{v.icon}</span>}
                <span className="truncate">{v.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <div className="mt-auto">
          <SidebarUsage collapsed={collapsed} />
        </div>
      </aside>

      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-label="Resize sidebar"
          tabIndex={0}
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyDown}
          className={cn(
            'group shrink-0 w-[6px] h-full cursor-col-resize bg-border relative',
            'hover:bg-border-strong focus:outline-none focus-visible:bg-accent/40',
            dragging && 'bg-accent/50',
            'transition-colors duration-fast',
          )}
        >
          <span className={cn(
            'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
            'w-[3px] h-8 rounded-full pointer-events-none',
            'bg-border-strong group-hover:bg-text-faint transition-colors duration-fast',
            dragging && 'bg-accent',
          )} />
        </div>
      )}
      {collapsed && <div className="shrink-0 w-px h-full bg-border-strong" />}
    </>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-3 pt-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</div>;
}
```

- [ ] **Step 7.2: Run tests**
```bash
npx vitest run
```
Expected: pass.

- [ ] **Step 7.3: Commit**
```bash
git add src/web/ui/shell/Sidebar.tsx
git commit -m "feat(sidebar): pane focus indicator and mod+1-9 project shortcuts"
```

---

## Task 8: Register pane focus in `RunDetail`

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 8.1: Add imports**

At the top of `src/web/pages/RunDetail.tsx`, add:
```ts
import { usePaneRegistration, usePaneFocus, useFocusedPane } from '@ui/shell/PaneFocusContext.js';
import { cn } from '@ui/cn.js';
```

- [ ] **Step 8.2: Register panes and wire focus state**

Inside `RunDetailPage`, after the existing hooks, add:
```ts
usePaneRegistration('run-terminal', 2);
usePaneRegistration('run-bottom', 3);
const { isFocused: terminalFocused, focus: focusTerminal } = usePaneFocus('run-terminal');
const { isFocused: bottomFocused, focus: focusBottom } = usePaneFocus('run-bottom');
const focusedPane = useFocusedPane();
```

- [ ] **Step 8.3: Open drawer when `run-bottom` is focused**

Add a `useEffect` after the pane hooks:
```ts
useEffect(() => {
  if (focusedPane === 'run-bottom') setDrawerOpen(true);
}, [focusedPane]);
```

- [ ] **Step 8.4: Apply `data-pane-id` and focus indicator to terminal container**

Find the `div` with `ref={terminalPaneRef}` (currently around line 250). Update it:
```tsx
<div
  ref={terminalPaneRef}
  data-pane-id="run-terminal"
  onClick={focusTerminal}
  className={cn(
    'flex-1 min-h-0 relative flex flex-col overflow-hidden border-t-2',
    'data-[upload-drag-active=true]:ring-2 data-[upload-drag-active=true]:ring-accent data-[upload-drag-active=true]:ring-inset',
    'transition-[box-shadow,border-color] duration-fast ease-out',
    terminalFocused ? 'border-accent' : 'border-transparent',
  )}
>
  <RunTerminal runId={run.id} interactive={interactive} />
</div>
```

- [ ] **Step 8.5: Apply focus indicator to the RunDrawer wrapper**

The `RunDrawer` is rendered as a direct child of the flex column. Wrap it in a `relative` div — an absolute overlay bar avoids adding permanent layout space:
```tsx
<div className="relative" onClick={focusBottom}>
  {bottomFocused && (
    <div className="absolute inset-x-0 top-0 h-0.5 bg-accent z-10 pointer-events-none" aria-hidden="true" />
  )}
  <RunDrawer
    open={drawerOpen}
    onToggle={setDrawerOpen}
    changesCount={changesCount}
    portsCount={run.state === 'running' || run.state === 'waiting' ? ports.length : null}
    shipDot={shipDot}
    height={height}
    onHeightChange={setHeight}
  >
    {(t) =>
      t === 'changes' ? <ChangesTab run={run} project={project} changes={changes} wip={wip} /> :
      t === 'ship'    ? <ShipTab run={run} project={project} changes={changes}
                                 onCreatePr={onCreatePr} creatingPr={creatingPr} onReload={onReload} /> :
      t === 'tunnel'  ? <TunnelTab runId={run.id} runState={run.state}
                                   origin={window.location.origin} ports={ports} /> :
                        <MetaTab run={run} siblings={siblings} />
    }
  </RunDrawer>
</div>
```

- [ ] **Step 8.6: Run tests**
```bash
npx vitest run
```
Expected: pass.

- [ ] **Step 8.7: Commit**
```bash
git add src/web/pages/RunDetail.tsx
git commit -m "feat(run-detail): register run-terminal and run-bottom panes with focus indicator"
```

---

## Task 9: Add Shift+Tab tab cycling to `RunDrawer`

**Files:**
- Modify: `src/web/features/runs/RunDrawer.tsx`

- [ ] **Step 9.1: Update `RunDrawer.tsx`**

Replace the full file:
```tsx
import { useState, type ReactNode } from 'react';
import { Tabs } from '@ui/primitives/Tabs.js';
import { Drawer } from '@ui/primitives/Drawer.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import type { ShipDot } from './ship/computeShipDot.js';

export type RunTab = 'changes' | 'ship' | 'tunnel' | 'meta';

const TAB_ORDER: readonly RunTab[] = ['changes', 'ship', 'tunnel', 'meta'];

export interface RunDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  changesCount: number;
  portsCount: number | null;
  shipDot: ShipDot;
  height: number;
  onHeightChange: (h: number) => void;
  children: (tab: RunTab) => ReactNode;
}

export function RunDrawer({
  open, onToggle, changesCount, portsCount, shipDot,
  height, onHeightChange, children,
}: RunDrawerProps) {
  const [tab, setTab] = useState<RunTab>('changes');

  const pickTab = (next: RunTab): void => {
    setTab(next);
    if (!open) onToggle(true);
  };

  // Shift+Tab cycles through drawer tabs (and opens the drawer if collapsed).
  useKeyBinding({
    chord: 'shift+tab',
    description: 'Cycle drawer tab',
    when: () => open,
    handler: () => {
      setTab((current) => {
        const idx = TAB_ORDER.indexOf(current);
        return TAB_ORDER[(idx + 1) % TAB_ORDER.length];
      });
    },
  }, [open]);

  const shipLabel = (
    <span className="inline-flex items-center gap-1.5">
      ship
      {shipDot && (
        <span
          role="img"
          aria-label={shipDot === 'amber' ? 'branch is stale' : 'ready to ship'}
          className={`inline-block w-1.5 h-1.5 rounded-full ${shipDot === 'amber' ? 'bg-warn' : 'bg-accent'}`}
        />
      )}
    </span>
  );

  return (
    <Drawer
      open={open}
      onToggle={onToggle}
      height={height}
      onHeightChange={onHeightChange}
      header={
        <Tabs
          value={tab}
          onChange={pickTab}
          tabs={[
            { value: 'changes', label: 'changes', count: changesCount },
            { value: 'ship', label: shipLabel },
            { value: 'tunnel', label: 'tunnel', count: portsCount ?? undefined },
            { value: 'meta', label: 'meta' },
          ]}
        />
      }
    >
      <div className="h-full overflow-auto">{children(tab)}</div>
    </Drawer>
  );
}
```

- [ ] **Step 9.2: Run full test suite**
```bash
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 9.3: Commit**
```bash
git add src/web/features/runs/RunDrawer.tsx
git commit -m "feat(run-drawer): shift+tab cycles through drawer tabs"
```

---

## Task 10: Visual smoke-test

- [ ] **Step 10.1: Start the dev server**
```bash
bash scripts/dev.sh
```

- [ ] **Step 10.2: Open the app and verify**

Using the Playwright MCP browser:

1. **Projects sidebar focus** — navigate to any project page; hold Cmd/Ctrl — numbered hints appear on active projects in the left sidebar; the sidebar gets an accent top border when ArrowLeft focuses it; pressing `⌘1` jumps to the first active project.

2. **Runs list focus** — on a project page, press ArrowRight once; the runs list gets the accent top border; hold Cmd/Ctrl — numbered hints appear on active runs; press `⌘1` to jump to run #1.

3. **Run terminal focus** — press ArrowRight again; the terminal pane gets the accent border; press ArrowDown; the bottom drawer opens and gets the accent border; press ArrowUp to return to terminal.

4. **Shift+Tab** — while a run drawer is open, press Shift+Tab repeatedly to cycle through changes → ship → tunnel → meta → changes.

5. **No regressions** — verify j/k still navigates runs, mod+b still toggles sidebar, mod+k still opens command palette.

- [ ] **Step 10.3: Commit any visual fixes found during smoke test**
```bash
git add -p
git commit -m "fix: visual smoke-test adjustments"
```
