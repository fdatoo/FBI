import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { paletteRegistry, type PaletteGroup, type PaletteItem } from './paletteRegistry.js';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<readonly PaletteGroup[]>([]);
  const [items, setItems] = useState<Record<string, readonly PaletteItem[]>>({});

  useEffect(() => {
    const update = () => setGroups(paletteRegistry.list());
    update();
    return paletteRegistry.subscribe(update);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all(
      groups.map(async (g) => [g.id, await g.items(query)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setItems(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [open, query, groups]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center pt-[15vh] bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <Command
        label="Command palette"
        className="w-full max-w-xl bg-surface-raised border border-border-strong rounded-lg shadow-popover overflow-hidden"
      >
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Type to search actions, runs, projects…"
          className="w-full px-4 py-3 bg-transparent font-mono text-[15px] text-text placeholder:text-text-faint border-b border-border outline-none"
        />
        <Command.List className="max-h-80 overflow-auto py-1">
          <Command.Empty className="px-4 py-3 text-[14px] text-text-faint">No results.</Command.Empty>
          {groups.map((g) => {
            const rows = items[g.id] ?? [];
            if (rows.length === 0) return null;
            return (
              <Command.Group key={g.id} heading={g.label} className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-text-faint">
                {rows.map((it) => (
                  <Command.Item
                    key={it.id}
                    value={`${it.label} ${it.keywords?.join(' ') ?? ''}`}
                    onSelect={() => { it.onSelect(); onClose(); }}
                    className="flex items-center gap-2 px-4 py-1.5 text-[14px] text-text-dim aria-selected:bg-accent-subtle aria-selected:text-accent-strong cursor-pointer"
                  >
                    <span className="flex-1 min-w-0 truncate">{it.label}</span>
                    {it.hint && <span className="font-mono text-[13px] text-text-faint">{it.hint}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
      </Command>
    </div>,
    document.body,
  );
}
