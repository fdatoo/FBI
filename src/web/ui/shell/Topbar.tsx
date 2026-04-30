import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Kbd } from '../primitives/Kbd.js';

export interface TopbarProps {
  breadcrumb: ReactNode;
  onOpenPalette: () => void;
}

export function Topbar({ breadcrumb, onOpenPalette }: TopbarProps) {
  const inTauri = isTauri();
  const dragProps = inTauri ? { 'data-tauri-drag-region': '' } : {};

  // macOS hides the native traffic lights in fullscreen — drop the spacer
  // when fullscreen so the FBI logo doesn't sit awkwardly in dead space.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    const sync = () => void win.isFullscreen().then(setFullscreen);
    sync();
    let unlisten: (() => void) | undefined;
    void win.onResized(sync).then((u) => { unlisten = u; });
    return () => unlisten?.();
  }, [inTauri]);

  return (
    <header
      className="h-[36px] flex items-center gap-2 px-3 border-b border-border-strong bg-surface select-none"
      {...dragProps}
    >
      {inTauri && !fullscreen && <div className="w-[68px] shrink-0" />}
      <span className="font-semibold text-[15px] tracking-tight shrink-0">▮ FBI</span>
      <span className="font-mono text-[13px] text-text-faint truncate">{breadcrumb}</span>
      <button
        type="button"
        onClick={onOpenPalette}
        className="ml-auto flex items-center gap-1 text-[13px] text-text-faint hover:text-text shrink-0"
        aria-label="Open command palette"
      >
        <Kbd>⌘</Kbd><Kbd>K</Kbd><span>search</span>
      </button>
    </header>
  );
}
