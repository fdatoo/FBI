import { useEffect, useState } from 'react';
import { statusRegistry, type StatusItem } from './statusRegistry.js';

export function StatusBar() {
  const [left, setLeft] = useState<readonly StatusItem[]>([]);
  const [right, setRight] = useState<readonly StatusItem[]>([]);
  useEffect(() => {
    const update = () => {
      setLeft(statusRegistry.list('left'));
      setRight(statusRegistry.list('right'));
    };
    update();
    return statusRegistry.subscribe(update);
  }, []);
  return (
    <footer className="h-[22px] flex items-center gap-2 sm:gap-4 px-2 sm:px-3 border-t border-border-strong bg-surface font-mono text-[12px] uppercase tracking-[0.06em] text-text-faint overflow-hidden">
      {left.map((i) => <span key={i.id} className="shrink-0">{i.render()}</span>)}
      <span className="ml-auto flex items-center gap-2 sm:gap-3 shrink-0">
        {right.map((i) => <span key={i.id}>{i.render()}</span>)}
      </span>
    </footer>
  );
}
