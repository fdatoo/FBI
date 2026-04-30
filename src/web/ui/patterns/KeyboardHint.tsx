import { Kbd } from '../primitives/Kbd.js';

export interface KeyboardHintProps {
  keys: readonly string[];
  label?: string;
}

export function KeyboardHint({ keys, label }: KeyboardHintProps) {
  return (
    <span className="inline-flex items-center gap-1 text-[12px] text-text-faint">
      {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
      {label && <span>{label}</span>}
    </span>
  );
}
