import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { cn } from '../cn.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { Kbd } from '../primitives/Kbd.js';
import { sidebarRegistry, type SidebarView } from './sidebarRegistry.js';
import { SidebarUsage } from '../../features/usage/SidebarUsage.js';
import { usePaneRegistration, usePaneFocus } from './PaneFocusContext.js';
import { useModifierKeyHeld } from '../../hooks/useModifierKeyHeld.js';
import { keymap } from './KeyMap.js';

export interface SidebarProject {
  id: number;
  name: string;
  runs: number;
  hasRunning: boolean;
  hasWaiting: boolean;
}

export interface SidebarProps {
  projects: readonly SidebarProject[];
  collapsed?: boolean;
  onCreateProject?: () => void;
}

const COLLAPSED_WIDTH = 52;
const MIN_WIDTH = 180;
const MAX_WIDTH = 360;
const DEFAULT_WIDTH = 220;
const STORAGE_KEY = 'fbi-splitpane:shell-sidebar';
const MOD_SYMBOL = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl ';

function readStoredWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === null) return DEFAULT_WIDTH;
  const n = Number(stored);
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

export function Sidebar({ projects, collapsed }: SidebarProps) {
  const [views, setViews] = useState<readonly SidebarView[]>([]);
  const [width, setWidth] = useState<number>(readStoredWidth);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const nav = useNavigate();
  const modHeld = useModifierKeyHeld();
  usePaneRegistration('projects-sidebar', 0);
  const { isFocused, focus } = usePaneFocus('projects-sidebar');

  // Active projects (hasRunning or hasWaiting), first 9 for shortcuts.
  const activeProjects = projects.filter((p) => p.hasRunning || p.hasWaiting).slice(0, 9);
  const activeProjectsRef = useRef(activeProjects);
  activeProjectsRef.current = activeProjects;
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;

  useEffect(() => {
    const update = () => setViews(sidebarRegistry.list());
    update();
    return sidebarRegistry.subscribe(update);
  }, []);

  // Register mod+1–9 for projects once; use refs inside handlers.
  useEffect(() => {
    const offs = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      keymap.register({
        chord: `mod+${n}`,
        description: n === 1 ? 'Jump to active project 1–9' : undefined,
        when: () => isFocusedRef.current,
        handler: () => {
          const project = activeProjectsRef.current[n - 1];
          if (project) nav(`/projects/${project.id}`);
        },
      }),
    );
    return () => offs.forEach((off) => off());
  }, [nav]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (ev: MouseEvent) => {
      if (!asideRef.current) return;
      const rect = asideRef.current.getBoundingClientRect();
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - rect.left));
      setWidth(next);
    };
    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setDragging(false);
      setWidth((w) => {
        localStorage.setItem(STORAGE_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth((w) => {
      const delta = e.key === 'ArrowRight' ? 16 : -16;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w + delta));
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const asideWidth = collapsed ? COLLAPSED_WIDTH : width;

  // Shortcut label for a project: only when modifier held, pane focused, project is active.
  const shortcutFor = (p: SidebarProject): string | undefined => {
    if (!modHeld || !isFocused) return undefined;
    const idx = activeProjects.indexOf(p);
    return idx >= 0 ? String(idx + 1) : undefined;
  };

  return (
    <>
      <aside
        ref={asideRef}
        style={{ width: asideWidth }}
        className={cn(
          'shrink-0 h-full flex flex-col bg-surface border-t-2',
          isFocused ? 'border-accent' : 'border-transparent',
        )}
        onClick={focus}
      >
        {!collapsed && <Group label="Projects" />}
        {projects.map((p) => {
          const label = shortcutFor(p);
          return (
            <NavLink
              key={p.id}
              to={`/projects/${p.id}`}
              title={collapsed ? p.name : undefined}
              className={({ isActive }) => cn(
                'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[14px] transition-colors duration-fast ease-out',
                collapsed && 'justify-center',
                isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
              )}
            >
              {collapsed ? (
                <span className="relative w-8 h-8 flex items-center justify-center rounded-md text-lg font-semibold">
                  {p.name[0]?.toUpperCase() ?? '·'}
                  {p.hasWaiting ? (
                    <StatusDot tone="attn" aria-label="waiting for input" className="absolute -top-0.5 -right-0.5" />
                  ) : p.hasRunning ? (
                    <StatusDot tone="run" aria-label="running" className="absolute -top-0.5 -right-0.5" />
                  ) : null}
                </span>
              ) : (
                <>
                  {p.hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
                   : p.hasRunning ? <StatusDot tone="run" aria-label="running" />
                   : null}
                  <span className="truncate">{p.name}</span>
                  {label ? (
                    <Kbd className="ml-auto text-[11px] shrink-0">{MOD_SYMBOL}{label}</Kbd>
                  ) : (
                    <span className="ml-auto font-mono text-[12px] text-text-faint">{p.runs}</span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
        {collapsed
          ? <div className="border-t border-border mx-3 my-2" />
          : <Group label="Views" />}
        {views.map((v) => (
          <NavLink
            key={v.id}
            to={v.route}
            title={collapsed ? v.label : undefined}
            className={({ isActive }) => cn(
              'flex items-center gap-2 px-2 py-1 mx-1 rounded-md text-[14px] transition-colors duration-fast ease-out',
              collapsed && 'justify-center',
              isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text',
            )}
          >
            {collapsed ? (
              <span className="w-8 h-8 flex items-center justify-center rounded-md text-lg font-semibold">
                {v.icon ?? (v.label[0]?.toUpperCase() ?? '·')}
              </span>
            ) : (
              <>
                {v.icon && <span className="w-4 h-4 flex items-center justify-center shrink-0">{v.icon}</span>}
                <span className="truncate">{v.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <div className="mt-auto">
          <SidebarUsage collapsed={collapsed} />
        </div>
      </aside>

      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-label="Resize sidebar"
          tabIndex={0}
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyDown}
          className={cn(
            'group shrink-0 w-[6px] h-full cursor-col-resize bg-border relative',
            'hover:bg-border-strong focus:outline-none focus-visible:bg-accent/40',
            dragging && 'bg-accent/50',
            'transition-colors duration-fast',
          )}
        >
          <span className={cn(
            'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
            'w-[3px] h-8 rounded-full pointer-events-none',
            'bg-border-strong group-hover:bg-text-faint transition-colors duration-fast',
            dragging && 'bg-accent',
          )} />
        </div>
      )}
      {collapsed && <div className="shrink-0 w-px h-full bg-border-strong" />}
    </>
  );
}

function Group({ label }: { label: string }) {
  return <div className="px-3 pt-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</div>;
}
