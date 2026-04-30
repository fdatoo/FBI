import { useCallback, useState } from 'react';
import type { MergeStrategy } from '@shared/types.js';

const KEY = 'fbi.mergeStrategy';

function readInitial(projectDefault: MergeStrategy): MergeStrategy {
  if (typeof window === 'undefined') return projectDefault;
  const raw = window.localStorage.getItem(KEY);
  if (raw === 'merge' || raw === 'rebase' || raw === 'squash') return raw;
  return projectDefault;
}

export interface UseMergeStrategy {
  strategy: MergeStrategy;
  setStrategy: (s: MergeStrategy) => void;
}

export function useMergeStrategy(projectDefault: MergeStrategy): UseMergeStrategy {
  const [strategy, setStrategyState] = useState<MergeStrategy>(() => readInitial(projectDefault));
  const setStrategy = useCallback((s: MergeStrategy) => {
    setStrategyState(s);
    try { window.localStorage.setItem(KEY, s); } catch { /* quota */ }
  }, []);
  return { strategy, setStrategy };
}
