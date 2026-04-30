import { useEffect, useState } from 'react';
import type { UsageState } from '@shared/types.js';
import { usageStore } from './usageStore.js';

export function useUsage(): UsageState | null {
  const [s, setS] = useState<UsageState | null>(() => usageStore.getSnapshot());
  useEffect(() => {
    usageStore.ensureStarted();
    return usageStore.onSnapshot(setS);
  }, []);
  return s;
}

export function useUsageUpdatedAt(): number | null {
  const [t, setT] = useState<number | null>(() => usageStore.getLastUpdatedAt());
  useEffect(() => {
    usageStore.ensureStarted();
    return usageStore.onUpdatedAt(setT);
  }, []);
  return t;
}

export function __resetUsageStoreForTest(): void {
  usageStore._resetForTest();
}
