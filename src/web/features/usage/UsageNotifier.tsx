import { useEffect, useRef } from 'react';
import { usageStore } from './usageStore.js';
import { api } from '../../lib/api.js';

const LABEL: Record<string, string> = { five_hour: '5-hour', weekly: 'weekly', sonnet_weekly: 'Sonnet weekly' };

export function UsageNotifier() {
  const enabled = useRef({ global: false, usage: false });
  useEffect(() => {
    void api.getSettings().then((s) => {
      enabled.current = {
        global: s.notifications_enabled,
        usage: s.usage_notifications_enabled,
      };
    }).catch(() => {});
    return usageStore.onThreshold((m) => {
      if (!enabled.current.global || !enabled.current.usage) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const label = LABEL[m.bucket_id] ?? m.bucket_id;
      new Notification(`Claude usage ${m.threshold}%`, { body: `${label} bucket at ${m.threshold}%` });
    });
  }, []);
  return null;
}
