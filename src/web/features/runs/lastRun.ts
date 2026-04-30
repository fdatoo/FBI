const GLOBAL_KEY = 'fbi-last-run-id';
const projectKey = (pid: number) => `fbi-last-run-id:project:${pid}`;

function read(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function write(key: string, id: number | null): void {
  try {
    if (id == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(id));
  } catch { /* ignore */ }
}

export function getLastRunGlobal(): number | null { return read(GLOBAL_KEY); }
export function setLastRunGlobal(id: number | null): void { write(GLOBAL_KEY, id); }

export function getLastRunForProject(pid: number): number | null { return read(projectKey(pid)); }
export function setLastRunForProject(pid: number, id: number | null): void { write(projectKey(pid), id); }
