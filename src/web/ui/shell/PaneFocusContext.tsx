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
    const canNav = (): boolean =>
      !isSeparatorEl(activeEl()) &&
      focusedRef.current !== 'run-bottom';

    const offRight = keymap.register({
      chord: 'mod+ArrowRight',
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
      chord: 'mod+ArrowLeft',
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
      chord: 'mod+ArrowDown',
      description: 'Focus run drawer',
      when: () => focusedRef.current === 'run-terminal',
      handler: () => setFocusedPane('run-bottom'),
    });

    const offUp = keymap.register({
      chord: 'mod+ArrowUp',
      description: 'Focus terminal',
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
