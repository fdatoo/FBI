import { useState, useEffect } from 'react';

export function useModifierKeyHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => { if (e.metaKey || e.ctrlKey) setHeld(true); };
    const onUp = (e: KeyboardEvent): void => { if (!e.metaKey && !e.ctrlKey) setHeld(false); };
    const onBlur = (): void => setHeld(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return held;
}
