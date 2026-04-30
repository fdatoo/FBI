import { Link } from 'react-router-dom';
import { Button } from '@ui/primitives/Button.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import type { Project } from '@shared/types.js';

export interface ProjectHeaderProps { project: Project; }

export function ProjectHeader({ project }: ProjectHeaderProps) {
  return (
    <div className="px-3 py-2 border-b border-border bg-surface flex items-center gap-2">
      <div className="min-w-0">
        <h1 className="text-[16px] font-semibold truncate">{project.name}</h1>
        <p className="text-[12px] text-text-faint truncate"><CodeBlock>{project.repo_url}</CodeBlock></p>
      </div>
      <div className="ml-auto flex gap-1.5">
        <Link to={`/projects/${project.id}/edit`}><Button variant="ghost" size="sm">Edit</Button></Link>
        <Link to={`/projects/${project.id}/runs/new`}><Button size="sm">New run</Button></Link>
      </div>
    </div>
  );
}
