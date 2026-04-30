import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Project, Run, ChangesPayload } from '@shared/types.js';
import type { WipResponse } from '../features/runs/ChangesTab.js';
import { api, apiBase } from '../lib/api.js';
import { LoadingState } from '@ui/patterns/LoadingState.js';
import { ErrorState } from '@ui/patterns/index.js';
import { RunHeader } from '../features/runs/RunHeader.js';
import { RunTerminal } from '../features/runs/RunTerminal.js';
import { RunDrawer } from '../features/runs/RunDrawer.js';
import { ChangesTab } from '../features/runs/ChangesTab.js';
import { MetaTab } from '../features/runs/MetaTab.js';
import { TunnelTab } from '../features/runs/TunnelTab.js';
import { ShipTab } from '../features/runs/ship/ShipTab.js';
import { computeShipDot } from '../features/runs/ship/computeShipDot.js';
import { useBottomPaneHeight } from '../features/runs/useBottomPaneHeight.js';
import type { ListeningPort } from '@shared/types.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import { subscribeState, subscribeTitle, subscribeChanges } from '../features/runs/usageBus.js';
import { UploadTray, type UploadTrayFile } from '../components/UploadTray.js';
import { ContinueRunDialog } from '../components/ContinueRunDialog.js';
import { acquireShell, releaseShell } from '../lib/shellRegistry.js';
import { contextMenuRegistry } from '@ui/shell/contextMenuRegistry.js';
import { usePaneRegistration, usePaneFocus } from '@ui/shell/PaneFocusContext.js';
import { cn } from '@ui/cn.js';

export function RunDetailPage() {
  const params = useParams();
  const runId = Number(params.rid ?? params.id);
  const urlPid = params.id && params.rid ? Number(params.id) : null;
  const nav = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [changes, setChanges] = useState<ChangesPayload | null>(null);
  const [wip, setWip] = useState<WipResponse | null>(null);
  const [siblings, setSiblings] = useState<Run[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [creatingPr, setCreatingPr] = useState(false);
  const [drawerOpen, setDrawerOpenRaw] = useState(() => {
    try { return localStorage.getItem('fbi.drawerOpen') !== 'false'; } catch { return true; }
  });
  const setDrawerOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setDrawerOpenRaw((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      try { localStorage.setItem('fbi.drawerOpen', String(value)); } catch { /* */ }
      return value;
    });
  };
  const [error, setError] = useState<string | null>(null);
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [attached, setAttached] = useState<UploadTrayFile[]>([]);
  const [continueOpen, setContinueOpen] = useState(false);
  const terminalPaneRef = useRef<HTMLDivElement | null>(null);
  const { height, setHeight } = useBottomPaneHeight();

  useKeyBinding({ chord: 'mod+j', handler: () => setDrawerOpen((v) => !v), description: 'Toggle run drawer' }, []);

  usePaneRegistration('run-terminal', 2);
  usePaneRegistration('run-bottom', 3);
  const { isFocused: terminalFocused, focus: focusTerminal } = usePaneFocus('run-terminal');
  const { isFocused: bottomFocused, focus: focusBottom } = usePaneFocus('run-bottom');

  useEffect(() => {
    if (bottomFocused) setDrawerOpen(true);
  }, [bottomFocused]);

  useEffect(() => {
    let alive = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      try {
        const r = await api.getRun(runId);
        if (alive) setRun(r);
      } catch (err) {
        const msg = String(err);
        if (msg.includes('HTTP 404') || msg.includes(' 404 ')) {
          if (alive) {
            setError(`Run #${runId} not found`);
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
          }
        }
      }
    };
    void load();
    intervalId = setInterval(load, 3000);
    return () => { alive = false; if (intervalId !== null) clearInterval(intervalId); };
  }, [runId]);

  useEffect(() => {
    if (!run) return;
    void api.getRunSiblings(run.id).then(setSiblings).catch(() => setSiblings([]));
    void api.getProject(run.project_id).then(setProject).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    if (urlPid == null) return;
    if (run.project_id === urlPid) return;
    nav(`/projects/${run.project_id}/runs/${run.id}`, { replace: true });
  // run?.id and run?.project_id cover all fields accessed; run object ref excluded intentionally.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.project_id, urlPid, nav]);

  useEffect(() => {
    return subscribeState((id, frame) => {
      if (id !== runId) return;
      setRun((r) => r ? {
        ...r,
        state: frame.state,
        state_entered_at: frame.state_entered_at,
        next_resume_at: frame.next_resume_at,
        resume_attempts: frame.resume_attempts,
        last_limit_reset_at: frame.last_limit_reset_at,
      } : r);
    });
  }, [runId]);

  useEffect(() => {
    return subscribeTitle((id, frame) => {
      setRun((r) => r && r.id === id ? { ...r, title: frame.title, title_locked: frame.title_locked } : r);
    });
  }, []);

  useEffect(() => {
    return subscribeChanges((id, payload) => {
      if (id !== runId) return;
      setChanges((prev) => {
        // WS update brings live working-tree + branch-base only. If nothing
        // has been fetched yet, ignore it — we let the initial /changes poll
        // populate commits + integrations + branch_name. Otherwise patch the
        // live fields onto the polled state so a late WS frame never clobbers
        // the authoritative fields it doesn't carry (esp. branch_name).
        if (!prev) return prev;
        return {
          ...prev,
          branch_base: payload.branch_base,
          uncommitted: payload.uncommitted,
        };
      });
    });
  }, [runId]);

  // Changes: poll every 10s regardless of run state, so commits/PR/CI stay
  // current both during and after the run.
  useEffect(() => {
    if (!run) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try { const c = await api.getRunChanges(run.id); if (alive) setChanges(c); } catch { /* */ }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  useEffect(() => {
    if (!run) return;
    const live = run.state === 'running' || run.state === 'waiting';
    if (live) { setWip(null); return; }
    let alive = true;
    const load = async () => {
      try { const r = await api.getRunWip(run.id); if (alive) setWip(r); }
      catch { /* silent */ }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);

  useEffect(() => {
    if (!run) return;
    const containerLive = run.state === 'running' || run.state === 'waiting';
    if (!containerLive) {
      setPorts([]);
      return;
    }
    let alive = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const { ports: p } = await api.getRunListeningPorts(run.id);
        if (alive) setPorts(p);
      } catch { /* transient errors retained the last-known list */ }
    };
    const start = () => {
      if (interval != null) return;
      void tick();
      interval = setInterval(tick, 2000);
    };
    const stop = () => {
      if (interval != null) { clearInterval(interval); interval = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    document.addEventListener('visibilitychange', onVis);
    if (document.visibilityState === 'visible') start();
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state]);

  useEffect(() => {
    if (!run) return;
    return contextMenuRegistry.register('run-detail', () => [
      {
        id: 'copy-run-id',
        label: 'Copy run ID',
        onSelect: () => void navigator.clipboard.writeText(`#${run.id}`),
      },
      ...(run.branch_name
        ? [{
            id: 'copy-branch',
            label: 'Copy branch name',
            onSelect: () => void navigator.clipboard.writeText(run.branch_name!),
          }]
        : []),
    ]);
  }, [run]);

  if (error) return <ErrorState message={error} />;
  if (!run) return <LoadingState label="Loading run…" />;
  const interactive = run.state === 'running' || run.state === 'queued' || run.state === 'waiting' || run.state === 'starting';

  async function cancel() {
    if (!confirm('Cancel this run?')) return;
    try { await api.deleteRun(runId); } catch { /* ignore */ }
  }
  async function remove() {
    if (!confirm('Delete this run and its transcript?')) return;
    try { await api.deleteRun(runId); nav(-1); } catch { /* ignore */ }
  }

  function openContinueDialog(): void {
    if (!run) return;
    setContinueOpen(true);
  }

  async function onContinueConfirm(params: {
    model: string | null;
    effort: string | null;
    subagent_model: string | null;
  }): Promise<void> {
    if (!run) return;
    try {
      const newRun = await api.continueRun(run.id, params);
      nav(`/projects/${newRun.project_id}/runs/${newRun.id}`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const m = raw.match(/^HTTP \d+:\s*(.+)$/);
      let shown = raw;
      if (m) {
        try {
          const parsed = JSON.parse(m[1]) as { message?: string };
          if (parsed.message) shown = parsed.message;
        } catch { /* leave raw */ }
      }
      alert(shown);
    }
  }

  async function onCreatePr(): Promise<void> {
    if (!run) return;
    setCreatingPr(true);
    try {
      await api.createRunPr(run.id);
      const c = await api.getRunChanges(run.id);
      setChanges(c);
    } catch (e) { alert(String(e)); }
    finally { setCreatingPr(false); }
  }

  async function onReload(): Promise<void> {
    if (!run) return;
    try { const c = await api.getRunChanges(run.id); setChanges(c); } catch { /* */ }
  }

  const changesCount = (changes?.uncommitted.length ?? 0) + (changes?.commits.length ?? 0);
  const shipDot = changes ? computeShipDot(changes) : null;

  return (
    <div
      className="h-full flex flex-col min-h-0"
      data-context-id="run-detail"
      data-context-run-id={String(run.id)}
    >
      <RunHeader run={run} onCancel={cancel} onDelete={remove} onContinue={openContinueDialog} onRenamed={setRun} />
      <div className="flex-1 min-h-0 flex flex-col">
        <div
          ref={terminalPaneRef}
          data-pane-id="run-terminal"
          onClick={focusTerminal}
          className={cn(
            'flex-1 min-h-0 relative flex flex-col overflow-hidden border-t-2',
            'data-[upload-drag-active=true]:ring-2 data-[upload-drag-active=true]:ring-accent data-[upload-drag-active=true]:ring-inset',
            'transition-[box-shadow,border-color] duration-fast ease-out',
            terminalFocused ? 'border-accent' : 'border-transparent',
          )}
        >
          <RunTerminal runId={run.id} interactive={interactive} />
        </div>
        <div className="px-3 py-2 border-t border-border">
          <UploadTray
            disabled={run.state !== 'waiting' && run.state !== 'running'}
            disabledReason="Uploads are available while the run is active."
            dropZoneRef={terminalPaneRef}
            upload={async (file) => {
              const res = await api.uploadRunFile(run.id, file);
              setAttached(prev => [...prev, { filename: res.filename, size: res.size }]);
              return { filename: res.filename, size: res.size };
            }}
            onUploaded={(filename) => {
              const text = `@/fbi/uploads/${filename} `;
              const shell = acquireShell(run.id);
              shell.send(new TextEncoder().encode(text));
              releaseShell(run.id);
            }}
            maxFileBytes={100 * 1024 * 1024}
            maxTotalBytes={1024 * 1024 * 1024}
            totalBytes={attached.reduce((n, f) => n + f.size, 0)}
          />
        </div>
        <div className="relative" onClick={focusBottom}>
          {bottomFocused && (
            <div className="absolute inset-x-0 top-0 h-0.5 bg-accent z-10 pointer-events-none" aria-hidden="true" />
          )}
          <RunDrawer
            open={drawerOpen}
            onToggle={setDrawerOpen}
            changesCount={changesCount}
            portsCount={run.state === 'running' || run.state === 'waiting' ? ports.length : null}
            shipDot={shipDot}
            height={height}
            onHeightChange={setHeight}
          >
            {(t) =>
              t === 'changes' ? <ChangesTab run={run} project={project} changes={changes} wip={wip} /> :
              t === 'ship'    ? <ShipTab run={run} project={project} changes={changes}
                                         onCreatePr={onCreatePr} creatingPr={creatingPr} onReload={onReload} /> :
              t === 'tunnel'  ? <TunnelTab runId={run.id} runState={run.state}
                                           origin={apiBase() || window.location.origin} ports={ports} /> :
                                <MetaTab run={run} siblings={siblings} />
            }
          </RunDrawer>
        </div>
      </div>
      {run && (
        <ContinueRunDialog
          run={run}
          open={continueOpen}
          onClose={() => setContinueOpen(false)}
          onSubmit={onContinueConfirm}
        />
      )}
    </div>
  );
}
