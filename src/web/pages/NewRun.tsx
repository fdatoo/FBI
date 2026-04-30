import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { ModelParamsCollapse, type ModelParamsValue } from '../components/ModelParamsCollapse.js';
import { MockModeCollapse, type MockModeValue } from '../components/MockModeCollapse.js';
import { RecentPromptsDropdown } from '../components/RecentPromptsDropdown.js';
import { UploadTray, type UploadTrayFile } from '../components/UploadTray.js';
import { FormRow } from '@ui/patterns/FormRow.js';
import { Input, Textarea, Button } from '@ui/primitives/index.js';
import { ErrorState } from '@ui/patterns/ErrorState.js';
import { useKeyBinding } from '@ui/shell/KeyMap.js';
import { UsageWarning } from '../features/usage/UsageWarning.js';

const PER_FILE = 100 * 1024 * 1024;
const PER_RUN = 1024 * 1024 * 1024;

const LS_KEY = 'fbi.newRun.lastModelParams';

function loadModelParams(): ModelParamsValue {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { model: null, effort: null, subagent_model: null };
    const parsed = JSON.parse(raw) as Partial<ModelParamsValue>;
    return {
      model: parsed.model ?? null,
      effort: parsed.effort ?? null,
      subagent_model: parsed.subagent_model ?? null,
    };
  } catch {
    return { model: null, effort: null, subagent_model: null };
  }
}

export function NewRunPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [branch, setBranch] = useState(searchParams.get('branch') ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [attached, setAttached] = useState<UploadTrayFile[]>([]);
  const [modelParams, setModelParams] = useState<ModelParamsValue>(loadModelParams);
  const [mockMode, setMockMode] = useState<MockModeValue>({ mock: false, mock_scenario: null });
  const [scenarios, setScenarios] = useState<string[] | null>(null);

  useEffect(() => {
    api.fetchQuanticoScenarios()
      .then((r) => setScenarios(r.scenarios))
      .catch(() => setScenarios(null)); // capability off → 404 → leave null
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  function insertAtCursor(el: HTMLTextAreaElement | null, text: string): void {
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${lead}${text}${after}`;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    setter?.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const pos = start + lead.length + text.length;
    el.setSelectionRange(pos, pos);
    el.focus();
  }

  async function doCreateRun(force?: boolean) {
    const run = await api.createRun(
      pid,
      prompt,
      branch || undefined,
      draftToken ?? undefined,
      modelParams,
      force,
      mockMode,
    );
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(modelParams));
    } catch {
      // storage unavailable — harmless, move on
    }
    nav(`/projects/${pid}/runs/${run.id}`);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      await doCreateRun();
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.body?.['error'] === 'branch_in_use'
      ) {
        const message = typeof err.body?.['message'] === 'string'
          ? err.body['message']
          : 'This branch is already in use by another run.';
        if (window.confirm(`${message}\nProceed anyway?`)) {
          try {
            await doCreateRun(true);
          } catch (retryErr) {
            setError(String(retryErr));
          }
        }
        // user cancelled — leave form as-is, no error shown
        return;
      }
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const submitRef = useRef(submit);
  submitRef.current = submit;
  useKeyBinding({ chord: 'mod+enter', handler: () => void submitRef.current(), description: 'Submit run' }, []);

  if (!Number.isFinite(pid)) return <ErrorState message="Invalid project ID." />;

  return (
    <form onSubmit={submit} className="max-w-3xl mx-auto p-6 space-y-4">
      <UsageWarning />
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">New run</h1>
      <RecentPromptsDropdown projectId={pid} onPick={setPrompt} />
      <FormRow label="Branch name" hint="Leave blank to let Claude choose.">
        <Input className="w-full" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/branch-name" />
      </FormRow>
      <ModelParamsCollapse value={modelParams} onChange={setModelParams} />
      <MockModeCollapse value={mockMode} onChange={setMockMode} scenarios={scenarios} />
      <FormRow label="Prompt">
        <div
          ref={dropZoneRef}
          className="relative rounded-md data-[upload-drag-active=true]:ring-2 data-[upload-drag-active=true]:ring-accent transition-[box-shadow] duration-fast ease-out"
        >
          <Textarea
            ref={textareaRef}
            className="w-full" rows={12} autoFocus
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what Claude should do…"
          />
        </div>
        <UploadTray
          dropZoneRef={dropZoneRef}
          upload={async (file) => {
            const res = await api.uploadDraftFile(file, draftToken);
            setDraftToken(res.draft_token);
            setAttached(prev => [...prev, { filename: res.filename, size: res.size }]);
            return { filename: res.filename, size: res.size };
          }}
          onUploaded={(filename) => {
            insertAtCursor(textareaRef.current, `@/fbi/uploads/${filename} `);
          }}
          maxFileBytes={PER_FILE}
          maxTotalBytes={PER_RUN}
          totalBytes={attached.reduce((n, f) => n + f.size, 0)}
        />
      </FormRow>
      {error && <ErrorState message={error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>{submitting ? 'Starting…' : 'Start run'}</Button>
        <span className="text-[13px] text-text-faint">⌘⏎ to submit</span>
      </div>
    </form>
  );
}
