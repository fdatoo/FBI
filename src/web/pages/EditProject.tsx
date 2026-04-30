import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button, Section, Select } from '@ui/primitives/index.js';
import { ErrorState, LoadingState } from '@ui/patterns/index.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { SecretsEditor } from '../components/SecretsEditor.js';
import { ChipInput } from '../components/ChipInput.js';
import type { Project } from '@shared/types.js';

export function EditProjectPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getProject(pid).then((p) => {
      setProject(p);
      setName(p.name);
      setRepoUrl(p.repo_url);
      setDefaultBranch(p.default_branch);
      setGitAuthorName(p.git_author_name ?? '');
      setGitAuthorEmail(p.git_author_email ?? '');
      setInstructions(p.instructions ?? '');
      setMarketplaces(p.marketplaces ?? []);
      setPlugins(p.plugins ?? []);
      setDevcontainerJson(p.devcontainer_override_json ?? '');
      setMergeStrategy(p.default_merge_strategy);
    });
  }, [pid]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await api.updateProject(pid, {
        name, repo_url: repoUrl, default_branch: defaultBranch,
        instructions: instructions.trim() || null,
        devcontainer_override_json: devcontainerJson.trim() || null,
        git_author_name: gitAuthorName.trim() || null,
        git_author_email: gitAuthorEmail.trim() || null,
        marketplaces, plugins,
        default_merge_strategy: mergeStrategy,
      });
      nav(`/projects/${pid}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!project) return <LoadingState label="Loading project…" />;

  return (
    <form onSubmit={submit} className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Edit project</h1>

      <Section title="Identity">
        <FormRow label="Name"><Input className="w-full" value={name} onChange={(e) => setName(e.target.value)} required /></FormRow>
        <FormRow label="Repo URL (SSH)"><Input className="w-full" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} required /></FormRow>
        <FormRow label="Default branch"><Input className="w-full" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} required /></FormRow>
      </Section>

      <Section title="Git (overrides)">
        <FormRow label="Author name"><Input className="w-full" value={gitAuthorName} onChange={(e) => setGitAuthorName(e.target.value)} /></FormRow>
        <FormRow label="Author email"><Input className="w-full" value={gitAuthorEmail} onChange={(e) => setGitAuthorEmail(e.target.value)} /></FormRow>
      </Section>

      <Section title="Default merge strategy">
        <FormRow label="When shipping to main">
          <Select value={mergeStrategy} onChange={(e) => setMergeStrategy(e.target.value as 'merge' | 'rebase' | 'squash')}>
            <option value="merge">Merge commit — preserves branch history</option>
            <option value="rebase">Rebase &amp; fast-forward — linear history</option>
            <option value="squash">Squash &amp; merge — single commit on main</option>
          </Select>
        </FormRow>
      </Section>

      <Section title="Agent">
        <FormRow label="Project-level instructions" hint="Prepended after the global prompt, before the run prompt.">
          <Textarea className="w-full" rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
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
          label="Override JSON"
          value={devcontainerJson}
          onChange={setDevcontainerJson}
        />
      </Section>

      <Section title="Secrets">
        <SecretsEditor projectId={pid} />
      </Section>

      {error && <ErrorState message={error} />}
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
    </form>
  );
}
