import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import type { HistoryOp, HistoryResult } from '@shared/types.js';

export function useHistoryOp(runId: number, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const nav = useNavigate();

  const run = useCallback(async (op: HistoryOp): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setMsgIsError(false);
    try {
      const r: HistoryResult = await api.postRunHistory(runId, op);
      if (r.kind === 'complete') {
        setMsg(r.sha ? `Done (${r.sha.slice(0, 7)})` : 'Done');
        setMsgIsError(false);
        onDone?.();
      } else if (r.kind === 'agent' || r.kind === 'conflict') {
        const label = r.kind === 'conflict' ? 'Conflict — delegated' : 'Delegated to agent';
        setMsg(`${label} (run #${r.child_run_id}) — click to view`);
        setMsgIsError(false);
        setTimeout(() => nav(`/runs/${r.child_run_id}`), 1200);
      } else if (r.kind === 'agent-busy') {
        setMsg('Agent not available — try again when the run is live.');
        setMsgIsError(false);
      } else if (r.kind === 'invalid') {
        setMsg(`Invalid: ${r.message}`);
        setMsgIsError(true);
      } else if (r.kind === 'git-error') {
        setMsg(`Git: ${r.message}`);
        setMsgIsError(true);
      } else if (r.kind === 'git-unavailable') {
        setMsg(r.message ? `Git unavailable: ${r.message}` : 'Git operation unavailable');
        setMsgIsError(true);
      }
    } catch (e) {
      setMsg(String(e));
      setMsgIsError(true);
    } finally {
      setBusy(false);
    }
  }, [runId, onDone, nav]);

  return { busy, msg, msgIsError, run };
}
