import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { SplitPane } from '@ui/patterns/SplitPane.js';
import { LoadingState, EmptyState } from '@ui/patterns/index.js';
import { Button } from '@ui/primitives/Button.js';
import type { Project, Run } from '@shared/types.js';
import { api } from '../lib/api.js';
import { ProjectList } from '../features/projects/ProjectList.js';
import { useIsNarrow } from '../hooks/useIsNarrow.js';

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const location = useLocation();
  const atIndex = location.pathname.replace(/\/$/, '') === '/projects';
  const narrow = useIsNarrow();

  useEffect(() => {
    void api.listProjects().then(setProjects);
    void api.listRuns().then(setRuns);
  }, []);

  if (!projects) return <LoadingState label="Loading projects…" />;

  // Narrow: show only master list or only detail (stacked).
  if (narrow) {
    if (!atIndex) {
      return (
        <div className="h-full flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border bg-surface shrink-0">
            <Link to="/projects" className="text-[13px]">← Back to projects</Link>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <Outlet />
          </div>
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 overflow-auto">
        <div className="flex flex-col h-full">
          <ProjectList projects={projects} runs={runs} />
          {projects.length === 0 && (
            <div className="p-4"><EmptyState title="No projects yet" action={<Link to="/projects/new"><Button>Create project</Button></Link>} /></div>
          )}
        </div>
      </div>
    );
  }

  return (
    <SplitPane
      leftWidth="320px"
      storageKey="projects"
      left={
        <div className="flex flex-col h-full">
          <ProjectList projects={projects} runs={runs} />
          {projects.length === 0 && (
            <div className="p-4"><EmptyState title="No projects yet" action={<Link to="/projects/new"><Button>Create project</Button></Link>} /></div>
          )}
        </div>
      }
      right={
        atIndex ? (
          <div className="h-full flex items-center justify-center">
            <div className="max-w-md mx-auto w-full">
              <EmptyState title="Select a project" description="Pick a project, or create one." />
            </div>
          </div>
        ) : <Outlet />
      }
    />
  );
}
