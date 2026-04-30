import { NavLink } from 'react-router-dom';
import type { Project, Run } from '@shared/types.js';
import { StatusDot } from '@ui/primitives/StatusDot.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';

export interface ProjectListProps {
  projects: readonly Project[];
  runs: readonly Run[];
}

export function ProjectList({ projects, runs }: ProjectListProps) {
  return (
    <div className="flex flex-col">
      <h2 className="px-3 pt-2 pb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Projects</h2>
      {projects.map((p) => {
        const hasRunning = runs.some((r) => r.project_id === p.id && (r.state === 'running' || r.state === 'starting'));
        const hasWaiting = runs.some((r) => r.project_id === p.id && r.state === 'waiting');
        const count = runs.filter((r) => r.project_id === p.id).length;
        return (
          <NavLink
            key={p.id}
            to={`/projects/${p.id}`}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[14px] transition-colors duration-fast ease-out ${
                isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
              }`
            }
          >
            {hasWaiting ? <StatusDot tone="attn" aria-label="waiting for input" />
             : hasRunning ? <StatusDot tone="run" aria-label="running" />
             : null}
            <div className="min-w-0">
              <div className="truncate">{p.name}</div>
              <div className="text-[12px] text-text-faint truncate"><CodeBlock>{p.repo_url}</CodeBlock></div>
            </div>
            <span className="ml-auto font-mono text-[12px] text-text-faint">{count}</span>
          </NavLink>
        );
      })}
    </div>
  );
}
