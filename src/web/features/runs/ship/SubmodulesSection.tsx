import type { ChangesPayload } from '@shared/types.js';

export interface SubmodulesSectionProps {
  changes: ChangesPayload;
  busy: boolean;
  onPushSubmodule: (path: string) => void;
}

export function SubmodulesSection({ changes, busy, onPushSubmodule }: SubmodulesSectionProps) {
  // Aggregate: unique submodule paths seen in dirty_submodules + all commits' bumps.
  const rows = new Map<string, { path: string; status: string; needsPush: boolean }>();
  for (const s of changes.dirty_submodules) {
    const needsPush = s.unpushed_commits.length > 0;
    const bits: string[] = [];
    if (s.unpushed_commits.length > 0) bits.push(`${s.unpushed_commits.length} local commits unpushed`);
    if (s.dirty.length > 0) bits.push(`${s.dirty.length} dirty files`);
    rows.set(s.path, { path: s.path, status: bits.join(' · ') || 'dirty', needsPush });
  }
  for (const c of changes.commits) {
    for (const b of c.submodule_bumps) {
      if (!rows.has(b.path)) {
        rows.set(b.path, { path: b.path, status: `bumped in ${c.sha.slice(0, 7)}`, needsPush: false });
      }
    }
  }
  if (rows.size === 0) return null;

  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Submodules</h3>
      <div className="space-y-1">
        {Array.from(rows.values()).map((r) => (
          <div key={r.path} className="flex items-center gap-3 px-2 py-1.5 text-[12px]">
            <span className="font-mono text-text">📦 {r.path}</span>
            <span className="text-text-faint">·</span>
            <span className="text-text-dim flex-1">{r.status}</span>
            {r.needsPush && (
              <button type="button" onClick={() => onPushSubmodule(r.path)}
                disabled={busy}
                className="px-2 py-0.5 rounded-md border border-border-strong bg-surface text-[11px] text-text hover:bg-surface-raised disabled:opacity-50">
                  Push submodule
                </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
