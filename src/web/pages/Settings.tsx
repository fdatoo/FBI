import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { FormRow, ErrorState, LoadingState } from '@ui/patterns/index.js';
import { Input, Textarea, Toggle, Button, Section } from '@ui/primitives/index.js';
import { ChipInput } from '../components/ChipInput.js';
import { McpServerList } from '../components/McpServerList.js';
import { isTauri } from '@tauri-apps/api/core';
import { setServerUrl } from '../lib/serverConfig.js';
import { setApiBaseUrl } from '../lib/api.js';
import { cn } from '@ui/cn.js';
import { type ThemePref, getThemePref, setThemePref } from '@ui/theme.js';

export function SettingsPage() {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [warnAt, setWarnAt] = useState<number>(0);
  const [gcEnabled, setGcEnabled] = useState<boolean>(false);
  const [lastGc, setLastGc] = useState<{ at: number | null; count: number | null; bytes: number | null }>({ at: null, count: null, bytes: null });
  const [runningGc, setRunningGc] = useState(false);
  const [marketplaces, setMarketplaces] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  const [usageNotif, setUsageNotif] = useState<boolean>(false);
  const [autoResumeEnabled, setAutoResumeEnabled] = useState<boolean>(true);
  const [autoResumeMaxAttempts, setAutoResumeMaxAttempts] = useState<number>(3);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changingServer, setChangingServer] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [themePref, setThemePrefState] = useState<ThemePref>(() => getThemePref());

  useEffect(() => {
    void api.getSettings().then((s) => {
      setPrompt(s.global_prompt);
      setEnabled(s.notifications_enabled);
      setWarnAt(s.concurrency_warn_at);
      setGcEnabled(s.image_gc_enabled);
      setLastGc({ at: s.last_gc_at, count: s.last_gc_count, bytes: s.last_gc_bytes });
      setMarketplaces(s.global_marketplaces);
      setPlugins(s.global_plugins);
      setAutoResumeEnabled(s.auto_resume_enabled);
      setAutoResumeMaxAttempts(s.auto_resume_max_attempts);
      setUsageNotif(s.usage_notifications_enabled);
    }).catch(() => setLoadError(true));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (prompt == null) return;
    setSaving(true); setSaved(false); setError(null);
    try {
      await api.updateSettings({
        global_prompt: prompt,
        notifications_enabled: enabled,
        concurrency_warn_at: warnAt,
        image_gc_enabled: gcEnabled,
        global_marketplaces: marketplaces,
        global_plugins: plugins,
        auto_resume_enabled: autoResumeEnabled,
        auto_resume_max_attempts: autoResumeMaxAttempts,
        usage_notifications_enabled: usageNotif,
      });
      setSaved(true);
    } catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  }

  if (prompt == null) {
    if (loadError && isTauri()) {
      return (
        <div className="max-w-2xl mx-auto p-6 space-y-4">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Settings</h1>
          <ErrorState message="Could not reach the server. Check the URL or switch to a different server." />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={changingServer}
            onClick={async () => {
              setChangingServer(true);
              try {
                await setServerUrl('');
                setApiBaseUrl('');
                window.location.reload();
              } catch {
                setChangingServer(false);
              }
            }}
          >
            Change server
          </Button>
        </div>
      );
    }
    return <LoadingState label="Loading settings…" />;
  }

  return (
    <form onSubmit={submit} className="max-w-2xl mx-auto p-6 space-y-6">
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Settings</h1>

      <Section title="Appearance">
        <FormRow label="Theme" hint="Light and Dark override the system setting.">
          <div role="group" aria-label="Color theme" className="inline-flex rounded-md border border-border overflow-hidden">
            {(['light', 'dark', 'system'] as ThemePref[]).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={themePref === p}
                onClick={() => { setThemePref(p); setThemePrefState(p); }}
                className={cn(
                  'px-4 py-1.5 text-[13px] font-medium capitalize transition-colors duration-fast ease-out',
                  'border-r border-border last:border-r-0',
                  themePref === p
                    ? 'bg-accent-subtle text-accent-strong'
                    : 'text-text-dim hover:bg-surface-raised hover:text-text',
                )}
              >
                {p}
              </button>
            ))}
          </div>
        </FormRow>
      </Section>

      <Section title="Global prompt">
        <FormRow label="Text" hint="Prepended to every run, across every project, before project instructions.">
          <Textarea className="w-full" rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </FormRow>
      </Section>

      <Section title="Notifications">
        <div className="flex items-center gap-3">
          <Toggle checked={enabled} onChange={setEnabled} aria-label="Enable run-completion notifications" />
          <span className="text-[14px] text-text-dim">Enable run-completion notifications</span>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Toggle
            checked={usageNotif}
            onChange={setUsageNotif}
            aria-label="Notify me when Claude usage hits 75% or 90%"
          />
          <span className="text-[14px] text-text-dim">Notify me when Claude usage hits 75% or 90%</span>
        </div>
      </Section>

      <Section title="Auto-resume">
        <div className="flex items-center gap-3 mb-3">
          <Toggle checked={autoResumeEnabled} onChange={setAutoResumeEnabled} aria-label="Enable auto-resume on Claude rate-limit" />
          <span className="text-[14px] text-text-dim">Auto-resume runs that hit the Claude 5-hour rate-limit</span>
        </div>
        <FormRow label="Max attempts" hint="Give up after this many consecutive rate-limit waits.">
          <Input
            type="number"
            min={0}
            max={20}
            value={autoResumeMaxAttempts}
            onChange={(e) => setAutoResumeMaxAttempts(Number(e.target.value))}
            className="w-32"
          />
        </FormRow>
      </Section>

      <Section title="Concurrency">
        <FormRow label="Warn threshold" hint="Warn when starting a run with this many already in flight (0 = never warn).">
          <Input
            type="number"
            min={0}
            value={warnAt}
            onChange={(e) => setWarnAt(Number(e.target.value))}
            className="w-32"
          />
        </FormRow>
      </Section>

      <Section title="Image GC">
        <div className="flex items-center gap-3 mb-3">
          <Toggle checked={gcEnabled} onChange={setGcEnabled} aria-label="Enable nightly image GC" />
          <span className="text-[14px] text-text-dim">Enable nightly image GC (keeps images used in the last 30 days)</span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!gcEnabled || runningGc}
            onClick={async () => {
              setRunningGc(true);
              try {
                const res = await api.runGc();
                setLastGc({ at: Date.now(), count: res.deletedCount, bytes: res.deletedBytes });
              } finally { setRunningGc(false); }
            }}
          >
            {runningGc ? 'Running…' : 'Run GC now'}
          </Button>
          {lastGc.at && (
            <span className="text-[13px] text-text-dim">
              Last: {new Date(lastGc.at).toLocaleString()} — {lastGc.count ?? 0} images, {Math.round((lastGc.bytes ?? 0) / 1e6)} MB
            </span>
          )}
        </div>
      </Section>

      <Section title="Tools">
        <p className="text-[13px] text-text-dim mb-3">Available in every run across all projects.</p>
        <ChipInput
          label="Plugin marketplaces"
          values={marketplaces}
          onChange={setMarketplaces}
          placeholder="https://registry.example.com"
        />
        <div className="mt-3">
          <ChipInput
            label="Plugins"
            values={plugins}
            onChange={setPlugins}
            placeholder="name@marketplace"
          />
        </div>
        <div className="mt-3">
          <McpServerList projectId={null} label="MCP servers" />
        </div>
      </Section>

      {isTauri() && (
        <Section title="Desktop connection">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={changingServer}
            onClick={async () => {
              setChangingServer(true);
              try {
                await setServerUrl('');
                setApiBaseUrl('');
                window.location.reload();
              } catch {
                setChangingServer(false);
              }
            }}
          >
            Change server
          </Button>
        </Section>
      )}

      {error && <ErrorState message={error} />}
      {saved && <p className="text-[14px] text-ok">Saved.</p>}
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
    </form>
  );
}
