export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect: () => void;
}

export type ContextItemFactory = (el: HTMLElement) => readonly ContextMenuItem[];

class Registry {
  private factories = new Map<string, ContextItemFactory>();

  register(contextId: string, factory: ContextItemFactory): () => void {
    this.factories.set(contextId, factory);
    return () => { this.factories.delete(contextId); };
  }

  resolve(contextId: string, el: HTMLElement): readonly ContextMenuItem[] {
    return this.factories.get(contextId)?.(el) ?? [];
  }

  _reset(): void { this.factories.clear(); }
}

export const contextMenuRegistry = new Registry();
