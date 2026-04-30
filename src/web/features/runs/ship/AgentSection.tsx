// src/web/features/runs/ship/AgentSection.tsx
export interface AgentSectionProps {
  busy: boolean;
  commitsCount: number;
  onPolish: () => void;
}

export function AgentSection({ busy, commitsCount, onPolish }: AgentSectionProps) {
  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Agent actions</h3>
      <div className="flex items-start gap-3 px-2 py-2">
        <div className="flex-shrink-0">
          <button type="button" onClick={onPolish}
            disabled={busy || commitsCount === 0}
            className="px-3 py-1 rounded-md border border-attn/50 bg-attn-subtle text-[12px] text-attn hover:bg-attn-subtle/70 disabled:opacity-50">
              ✦ Polish commit messages
            </button>
        </div>
        <div className="text-[12px] text-text-dim flex-1 pt-1">
          Spawn an agent sub-run that rewrites each commit&apos;s subject and body without touching code.
        </div>
      </div>
    </section>
  );
}
