import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { EmptyState, LoadingState, ErrorState } from '@ui/patterns/index.js';
import { KeyboardHint } from '@ui/patterns/KeyboardHint.js';
import type { Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { RunsList } from '../features/runs/RunsList.js';
import { subscribeToRunRefresh } from '../hooks/useRunWatcher.js';
import { getLastRunGlobal, setLastRunGlobal } from '../features/runs/lastRun.js';
import { useIsNarrow } from '../hooks/useIsNarrow.js';

export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useParams();
  const nav = useNavigate();
  const narrow = useIsNarrow();
  const hasChildRoute = Boolean(params.id);

  // Auto-redirect only on initial mount (fresh page load, not client-side back-nav).
  // Once the user clears a run (navigates from /runs/:id back to /runs), respect it.
  const autoRedirectAllowedRef = useRef(true);
  const prevIdRef = useRef<string | undefined>(params.id);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.listRuns()
      .then((r) => { if (!cancelled) setRuns(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    load();
    const t = setInterval(load, 5000);
    const unsub = subscribeToRunRefresh(() => { void load(); });
    return () => { cancelled = true; clearInterval(t); unsub(); };
  }, []);

  // Remember the current run id whenever it changes.
  // If the user clears the id (navigates to /runs), disable further auto-redirects this mount.
  useEffect(() => {
    if (params.id) {
      setLastRunGlobal(Number(params.id));
    } else if (prevIdRef.current) {
      // User navigated from /runs/:id back to /runs — respect that.
      autoRedirectAllowedRef.current = false;
    }
    prevIdRef.current = params.id;
  }, [params.id]);

  // Auto-redirect to the last-viewed run on fresh mount.
  useEffect(() => {
    if (!autoRedirectAllowedRef.current) return;
    if (params.id) return;
    if (!runs || runs.length === 0) return;
    const lastId = getLastRunGlobal();
    if (lastId == null) return;
    if (!runs.some((r) => r.id === lastId)) return;
    autoRedirectAllowedRef.current = false;
    nav(`/runs/${lastId}`, { replace: true });
  }, [runs, params.id, nav]);

  if (error) return <ErrorState message={error} />;
  if (!runs) return <LoadingState label="Loading runs…" />;

  // Narrow: show only master or only detail (stacked).
  if (narrow) {
    if (hasChildRoute) {
      return (
        <div className="h-full flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border bg-surface shrink-0">
            <Link to="/runs" className="text-[13px]">← Back to runs</Link>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <Outlet />
          </div>
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 overflow-auto">
        <RunsList runs={runs} toHref={(r) => `/runs/${r.id}`} currentId={null} />
      </div>
    );
  }

  return (
    <SplitPane
      leftWidth="360px"
      storageKey="runs"
      left={<RunsList runs={runs} toHref={(r) => `/runs/${r.id}`} currentId={params.id ? Number(params.id) : null} />}
      right={
        params.id ? <Outlet /> : (
          <div className="h-full flex items-center justify-center">
            <div className="max-w-md mx-auto w-full">
              <EmptyState
                title="Select a run"
                description="Pick a run from the list, or create a new one."
                hint={<KeyboardHint keys={['j', '/', 'k']} label="navigate" />}
              />
            </div>
          </div>
        )
      }
    />
  );
}
