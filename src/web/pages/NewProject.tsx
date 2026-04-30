import { useState, useId, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button, Section, Select } from '@ui/primitives/index.js';
import { ErrorState } from '@ui/patterns/index.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { ChipInput } from '../components/ChipInput.js';
import { api } from '../lib/api.js';

export function NewProjectPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [instructions, setInstructions] = useState('');
  const [marketplaces, setMarketplaces] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [devcontainerJson, setDevcontainerJson] = useState('');
  const [mergeStrategy, setMergeStrategy] = useState<'merge' | 'rebase' | 'squash'>('squash');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nameId = useId();
  const repoUrlId = useId();
  const defaultBranchId = useId();
  const gitAuthorNameId = useId();
  const gitAuthorEmailId = useId();
  const instructionsId = useId();
  const mergeStrategyId = useId();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const p = await api.createProject({
        name, repo_url: repoUrl, default_branch: defaultBranch,
        instructions: instructions.trim() || null,
        devcontainer_override_json: devcontainerJson.trim() || null,
        git_author_name: gitAuthorName.trim() || null,
        git_author_email: gitAuthorEmail.trim() || null,
        marketplaces,
        plugins,
        mem_mb: null, cpus: null, pids_limit: null, default_merge_strategy: mergeStrategy,
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">New project</h1>

      <Section title="Identity">
        <FormRow label="Name" htmlFor={nameId}><Input id={nameId} className="w-full" value={name} onChange={(e) => setName(e.target.value)} required /></FormRow>
        <FormRow label="Repo URL (SSH)" htmlFor={repoUrlId}><Input id={repoUrlId} className="w-full" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required /></FormRow>
        <FormRow label="Default branch" htmlFor={defaultBranchId}><Input id={defaultBranchId} className="w-full" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} required /></FormRow>
      </Section>

      <Section title="Git (overrides)">
        <FormRow label="Author name" htmlFor={gitAuthorNameId}><Input id={gitAuthorNameId} className="w-full" value={gitAuthorName} onChange={(e) => setGitAuthorName(e.target.value)} /></FormRow>
        <FormRow label="Author email" htmlFor={gitAuthorEmailId}><Input id={gitAuthorEmailId} className="w-full" value={gitAuthorEmail} onChange={(e) => setGitAuthorEmail(e.target.value)} /></FormRow>
      </Section>

      <Section title="Default merge strategy">
        <FormRow label="When shipping to main" htmlFor={mergeStrategyId}>
          <Select id={mergeStrategyId} value={mergeStrategy} onChange={(e) => setMergeStrategy(e.target.value as 'merge' | 'rebase' | 'squash')}>
            <option value="merge">Merge commit — preserves branch history</option>
            <option value="rebase">Rebase &amp; fast-forward — linear history</option>
            <option value="squash">Squash &amp; merge — single commit on main</option>
          </Select>
        </FormRow>
      </Section>

      <Section title="Agent">
        <FormRow label="Project-level instructions" htmlFor={instructionsId} hint="Prepended after the global prompt, before the run prompt.">
          <Textarea id={instructionsId} className="w-full" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </FormRow>
      </Section>

      <Section title="Plugins">
        <ChipInput
          label="Extra marketplaces (merged with global defaults)"
          values={marketplaces}
          onChange={setMarketplaces}
          placeholder="add marketplace…"
        />
        <ChipInput
          label="Extra plugins (name@marketplace)"
          values={plugins}
          onChange={setPlugins}
          placeholder="add plugin…"
        />
      </Section>

      <Section title="Devcontainer">
        <JsonEditor
          label="Override JSON (used when repo has no .devcontainer/devcontainer.json)"
          value={devcontainerJson}
          onChange={setDevcontainerJson}
        />
      </Section>

      {error && <ErrorState message={error} />}
      <Button type="submit" disabled={submitting}>{submitting ? 'Creating…' : 'Create project'}</Button>
    </form>
  );
}
