import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { contextMenuRegistry, type ContextMenuItem } from './contextMenuRegistry.js';

interface MenuState {
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
}

function textItems(): ContextMenuItem[] {
  return [
    {
      id: 'copy', label: 'Copy', shortcut: '⌘C',
      onSelect: () => {
        const sel = window.getSelection()?.toString() ?? '';
        if (sel) void navigator.clipboard.writeText(sel);
      },
    },
    { id: 'select-all', label: 'Select All', shortcut: '⌘A', onSelect: () => { document.execCommand('selectAll'); } },
  ];
}

export function ContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [];

      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-context-id]');
      if (el?.dataset.contextId) {
        items.push(...contextMenuRegistry.resolve(el.dataset.contextId, el));
      }

      const target = e.target as HTMLElement;
      const isEditable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as HTMLElement).isContentEditable;
      const hasSelection = (window.getSelection()?.toString().length ?? 0) > 0;
      if (isEditable || hasSelection) {
        if (items.length > 0) items.push({ id: 'sep-text', label: '', separator: true, onSelect: () => {} });
        items.push(...textItems());
      }

      if (items.length === 0) return;

      const menuW = 200;
      const menuH = items.length * 32 + 8;
      const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
      const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
      setMenu({ x, y, items });
    };

    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu) return null;

  return createPortal(
    <div
      style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 'var(--z-palette)' } as React.CSSProperties}
      className="bg-surface-raised border border-border-strong rounded-lg shadow-popover py-1 min-w-[180px]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.items.map((item) =>
        item.separator ? (
          <div key={item.id} className="my-1 border-t border-border" />
        ) : (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            onClick={() => { item.onSelect(); setMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text hover:bg-accent-subtle hover:text-accent-strong disabled:opacity-40 flex justify-between items-center gap-4"
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="text-text-faint font-mono">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>,
    document.body,
  );
}
