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
  useKeyBinding({
    chord: 'shift+tab',
    description: 'Cycle drawer tab',
    handler: () => {
      if (!open) onToggle(true);
      setTab((current) => {
        const idx = TAB_ORDER.indexOf(current);
        return TAB_ORDER[(idx + 1) % TAB_ORDER.length];
      });
    },
  }, [open, onToggle]);
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
