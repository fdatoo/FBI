import type { ReactNode } from 'react';

export interface SidebarView {
  id: string;
  group: 'views';
  label: string;
  route: string;
  order?: number;
  /** Optional icon rendered in collapsed sidebar mode. Falls back to the first letter of `label`. */
  icon?: ReactNode;
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
