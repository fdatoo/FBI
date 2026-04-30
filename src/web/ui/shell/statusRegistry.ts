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
