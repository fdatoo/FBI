export type Theme = 'dark' | 'light';
export type ThemePref = 'dark' | 'light' | 'system';
const STORAGE_KEY = 'fbi-theme';

export function getStoredTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'dark' || v === 'light' ? v : null;
}

export function setStoredTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'dark' || v === 'light' || v === 'system' ? v : 'system';
}

export function setThemePref(pref: ThemePref): void {
  localStorage.setItem(STORAGE_KEY, pref);
  applyThemePref(pref);
}

export function applyThemePref(pref: ThemePref): void {
  applyTheme(pref === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : pref);
}

export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function resolveInitialTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return systemPrefersLight() ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}

export function toggleTheme(): Theme {
  const current: Theme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const next: Theme = current === 'light' ? 'dark' : 'light';
  setStoredTheme(next);
  applyTheme(next);
  return next;
}

export function subscribeSystemTheme(handler: (theme: Theme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const listener = (e: MediaQueryListEvent) => handler(e.matches ? 'light' : 'dark');
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

// Inline script string — injected into index.html to prevent flash on load.
export const NO_FLASH_SCRIPT = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var m=window.matchMedia('(prefers-color-scheme: light)').matches;if(s==='light'||(s!=='dark'&&m)){document.documentElement.classList.add('light');}}catch(e){}})();`;
