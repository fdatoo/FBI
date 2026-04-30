import type { ChangesPayload, Project } from '@shared/types.js';
import { parseGitHubRepo } from '@shared/parseGitHubRepo.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';

export interface LinksSectionProps {
  changes: ChangesPayload;
  project: Project | null;
  creatingPr: boolean;
  onCreatePr: () => void;
}

export function LinksSection({ changes, project, creatingPr, onCreatePr }: LinksSectionProps) {
  const repo = project ? parseGitHubRepo(project.repo_url) : null;
  const pr = changes.integrations.github?.pr;
  const branchHref = repo && changes.branch_name
    ? `https://github.com/${repo}/tree/${encodeURIComponent(changes.branch_name)}`
    : null;
  const canCreatePr = changes.integrations.github && !pr && !!changes.branch_name;
  const anything = canCreatePr || pr || branchHref || changes.branch_name;
  if (!anything) return null;

  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">Links</h3>
      <div className="flex items-center gap-3 text-[12px]">
        {canCreatePr && (
          <button type="button" onClick={onCreatePr} disabled={creatingPr}
            className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised disabled:opacity-50">
              {creatingPr ? 'Creating PR…' : 'Create PR'}
            </button>
        )}
        {pr && (
          <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
            View PR #{pr.number} <ExternalLink />
          </a>
        )}
        {branchHref && (
          <a href={branchHref} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
            Branch on GitHub <ExternalLink />
          </a>
        )}
        {changes.branch_name && (
          <button type="button"
            onClick={() => { void navigator.clipboard.writeText(changes.branch_name ?? ''); }}
            className="text-text-faint hover:text-text">
              copy branch name
          </button>
        )}
      </div>
    </section>
  );
}
