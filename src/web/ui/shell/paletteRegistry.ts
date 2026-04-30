export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  keywords?: string[];
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
