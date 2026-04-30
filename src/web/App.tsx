import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Cheatsheet } from '@ui/shell/index.js';
import { sidebarRegistry } from '@ui/shell/sidebarRegistry.js';
import { PlayIcon, GearIcon } from '@ui/primitives/Icons.js';
import { StatusDot } from '@ui/primitives/StatusDot.js';
import { paletteRegistry } from '@ui/shell/paletteRegistry.js';
import { statusRegistry } from '@ui/shell/statusRegistry.js';
import { keymap } from '@ui/shell/KeyMap.js';
import { toggleTheme } from '@ui/theme.js';
import { api } from './lib/api.js';
import { useRunWatcher } from './hooks/useRunWatcher.js';
import { useConnectionState } from './lib/connectionState.js';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Project, Run } from '@shared/types.js';
import { ProjectsPage } from './pages/Projects.js';
import { NewProjectPage } from './pages/NewProject.js';
import { ProjectDetailPage } from './pages/ProjectDetail.js';
import { EditProjectPage } from './pages/EditProject.js';
import { NewRunPage } from './pages/NewRun.js';
import { RunsPage } from './pages/Runs.js';
import { RunDetailPage } from './pages/RunDetail.js';
import { SettingsPage } from './pages/Settings.js';
import { DesignPage } from './pages/Design.js';
import { UsagePage } from './features/usage/UsagePage.js';
import { UsageNotifier } from './features/usage/UsageNotifier.js';

function Shell({ projects, runs, children }: { projects: Project[]; runs: Run[]; children: ReactNode }) {
  const location = useLocation();
  const hideSidebar = location.pathname === '/design';

  const active = runs.filter((r) => r.state === 'running').length;
  const waiting = runs.filter((r) => r.state === 'waiting').length;
  const today = runs.filter((r) => Date.now() - new Date(r.created_at).getTime() < 86400_000).length;

  const projectRows = projects.map((p) => ({
    id: p.id,
    name: p.name,
    runs: runs.filter((r) => r.project_id === p.id).length,
    hasRunning: runs.some((r) => r.project_id === p.id && r.state === 'running'),
    hasWaiting: runs.some((r) => r.project_id === p.id && r.state === 'waiting'),
  }));

  return (
    <AppShell projects={projectRows} hideSidebar={hideSidebar}>
      {children}
      <StatusRegistrations active={active} waiting={waiting} today={today} />
    </AppShell>
  );
}

function StatusRegistrations({ active, waiting, today }: { active: number; waiting: number; today: number }) {
  const conn = useConnectionState();
  const prevConn = useRef(conn);
  useEffect(() => {
    if (prevConn.current === 'disconnected' && conn === 'connected') {
      window.location.reload();
    }
    prevConn.current = conn;
  }, [conn]);

  useEffect(() => {
    const connRender = () => {
      if (conn === 'connected') return <span className="inline-flex items-center gap-1"><StatusDot tone="ok" /><span className="text-ok">connected</span></span>;
      if (conn === 'disconnected') return <span className="inline-flex items-center gap-1"><StatusDot tone="fail" /><span className="text-fail">disconnected</span></span>;
      return <span className="inline-flex items-center gap-1"><StatusDot tone="warn" /><span className="text-warn">connecting…</span></span>;
    };
    const off1 = statusRegistry.register({ id: 'conn', side: 'left', order: 0, render: connRender });
    const off2 = statusRegistry.register({ id: 'active', side: 'left', order: 1, render: () => <>{active} <span className="text-run">running</span></> });
    const off3 = statusRegistry.register({ id: 'today', side: 'left', order: 3, render: () => <>{today} today</> });
    const version = import.meta.env.VITE_VERSION as string | undefined;
    const offVer = version
      ? statusRegistry.register({ id: 'version', side: 'right', order: 100, render: () => <span className="text-text-faint normal-case">{version}</span> })
      : null;
    return () => { off1(); off2(); off3(); offVer?.(); };
  }, [active, today, conn]);

  // Waiting item is mounted only when > 0 so the bar collapses its gap.
  useEffect(() => {
    if (waiting === 0) return;
    return statusRegistry.register({
      id: 'waiting', side: 'left', order: 2,
      render: () => <>{waiting} <span className="text-attn">waiting</span></>,
    });
  }, [waiting]);

  return null;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [notif, setNotif] = useState(false);
  const [cheatsheet, setCheatsheet] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => {});
  }, []);
  useEffect(() => {
    const reload = () => void api.listRuns().then(setRuns).catch(() => {});
    reload();
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void api.getSettings().then((s) => setNotif(s.notifications_enabled));
  }, []);
  useRunWatcher(notif);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<number>('navigate-to-run', (e) => {
      nav(`/runs/${e.payload}`);
    });
    return () => { void unlisten.then((f) => f()); };
  }, [nav]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<string>('navigate', (e) => {
      nav(e.payload);
    });
    return () => { void unlisten.then((f) => f()); };
  }, [nav]);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen('open-cheatsheet', () => {
      setCheatsheet(true);
    });
    return () => { void unlisten.then((f) => f()); };
  }, []);

  const dataRef = useRef({ projects, runs });
  dataRef.current = { projects, runs };

  useEffect(() => {
    const offRuns = sidebarRegistry.register({ id: 'runs', group: 'views', label: 'All runs', route: '/runs', order: 10, icon: <PlayIcon size={16} /> });
    const offSet = sidebarRegistry.register({ id: 'settings', group: 'views', label: 'Settings', route: '/settings', order: 20, icon: <GearIcon size={16} /> });

    const offActions = paletteRegistry.register({
      id: 'actions',
      label: 'Actions',
      items: () => [
        { id: 'new-project', label: 'New project', hint: 'c p', onSelect: () => nav('/projects/new') },
        { id: 'runs', label: 'Go to all runs', hint: 'g r', onSelect: () => nav('/runs') },
        { id: 'settings', label: 'Open settings', hint: 'g s', onSelect: () => nav('/settings') },
        { id: 'toggle-theme', label: 'Toggle theme', onSelect: () => toggleTheme() },
      ],
    });

    const offRunsGroup = paletteRegistry.register({
      id: 'runs',
      label: 'Runs',
      items: (q) => {
        const query = q.toLowerCase().trim();
        return dataRef.current.runs
          .filter((r) => !query || String(r.id).includes(query) || (r.branch_name ?? '').toLowerCase().includes(query) || r.prompt.toLowerCase().includes(query))
          .slice(0, 10)
          .map((r) => ({
            id: `run-${r.id}`,
            label: `#${r.id} ${r.branch_name || r.prompt.split('\n')[0] || 'untitled'}`,
            hint: r.state,
            onSelect: () => nav(`/runs/${r.id}`),
          }));
      },
    });

    const offProjGroup = paletteRegistry.register({
      id: 'projects',
      label: 'Projects',
      items: (q) => {
        const query = q.toLowerCase().trim();
        return dataRef.current.projects
          .filter((p) => !query || p.name.toLowerCase().includes(query) || p.repo_url.toLowerCase().includes(query))
          .map((p) => ({ id: `proj-${p.id}`, label: p.name, hint: p.repo_url, onSelect: () => nav(`/projects/${p.id}`) }));
      },
    });

    const offGR = keymap.register({ chord: 'g r', description: 'Go to runs', handler: () => nav('/runs') });
    const offGS = keymap.register({ chord: 'g s', description: 'Go to settings', handler: () => nav('/settings') });
    const offCP = keymap.register({ chord: 'c p', description: 'Create project', handler: () => nav('/projects/new') });
    const offHelp = keymap.register({ chord: '?', description: 'Show keyboard shortcuts', handler: () => setCheatsheet(true) });

    return () => { offRuns(); offSet(); offActions(); offRunsGroup(); offProjGroup(); offGR(); offGS(); offCP(); offHelp(); };
  }, [nav]);

  return (
    <>
      <Shell projects={projects} runs={runs}>
        <UsageNotifier />
        <Routes>
          <Route path="/" element={<Navigate to="/runs" replace />} />
          <Route path="/projects" element={<ProjectsPage />}>
            <Route path="new" element={<NewProjectPage />} />
          </Route>
          <Route path="/projects/:id" element={<ProjectDetailPage />}>
            <Route path="runs/:rid" element={<RunDetailPage />} />
            <Route path="runs/new" element={<NewRunPage />} />
          </Route>
          <Route path="/projects/:id/edit" element={<EditProjectPage />} />
          <Route path="/runs" element={<RunsPage />}>
            <Route path=":id" element={<RunDetailPage />} />
          </Route>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/design" element={<DesignPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
      <Cheatsheet open={cheatsheet} onClose={() => setCheatsheet(false)} />
    </>
  );
}
