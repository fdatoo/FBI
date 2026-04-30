import { useEffect, useState } from 'react';

const BREAKPOINT = 768;

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.innerWidth < BREAKPOINT
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}
