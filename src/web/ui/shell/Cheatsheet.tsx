import { Dialog } from '@ui/primitives/Dialog.js';
import { Kbd } from '@ui/primitives/Kbd.js';
import { keymap } from './KeyMap.js';

export interface CheatsheetProps {
  open: boolean;
  onClose: () => void;
}

function displayKey(token: string): string {
  const t = token.toLowerCase();
  if (t === 'mod' || t === 'cmd') return navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  if (t === 'ctrl') return 'Ctrl';
  if (t === 'shift') return '⇧';
  if (t === 'alt' || t === 'opt') return '⌥';
  if (t === 'enter') return '⏎';
  if (t === 'escape') return 'Esc';
  return token;
}

export function Cheatsheet({ open, onClose }: CheatsheetProps) {
  const bindings = keymap.list().filter((b) => b.description);
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <ul className="space-y-1.5">
        {bindings.map((b, i) => (
          <li key={i} className="flex items-center justify-between text-[14px]">
            <span className="text-text-dim">{b.description}</span>
            <span className="flex gap-1">
              {b.chord.split(/\s+|\+/).map((k, j) => <Kbd key={j}>{displayKey(k)}</Kbd>)}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
