import { useEffect } from 'react';

export interface Binding {
  chord: string;
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
  // Check both the event target and the active element, because some environments
  // dispatch the event on window even when an input is focused.
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const el = (active ?? target) as HTMLElement | null;
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
    // Capture phase so global shortcuts fire before element handlers (e.g. xterm's
    // textarea listener which calls stopPropagation on keys it handles).
    window.addEventListener('keydown', this.onKey, true);
    this.attached = true;
  }

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
}

export const keymap = new KeyMap();

export function useKeyBinding(binding: Binding | null, deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!binding) return;
    return keymap.register(binding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
