import { Terminal } from '../../components/Terminal.js';

export function RunTerminal({ runId, interactive }: { runId: number; interactive: boolean }) {
  return (
    <div className="flex-1 min-h-0 bg-surface-sunken">
      <Terminal runId={runId} interactive={interactive} />
    </div>
  );
}
