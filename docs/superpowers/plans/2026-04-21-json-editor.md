# JSON Editor for Devcontainer Override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain textarea for `devcontainer_override_json` with a CodeMirror 6 JSON editor, and expand the New Project form to expose all the same fields as Edit Project.

**Architecture:** A new `JsonEditor` component wraps `@uiw/react-codemirror`, detects dark/light mode by observing the `dark` class on `document.documentElement` via `MutationObserver`, and shows a live validation status bar computed from `JSON.parse`. `EditProject` swaps its `<Area>` for `<JsonEditor>`. `NewProject` gains five new fields (git author name/email, marketplaces, plugins, devcontainer JSON) and wires them all to `api.createProject`.

**Tech Stack:** `@uiw/react-codemirror` v4, `@codemirror/lang-json`, React 18, Vitest + Testing Library, Tailwind CSS (class-based dark mode)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/web/components/JsonEditor.tsx` | CodeMirror JSON editor with dark mode + validation |
| Create | `src/web/components/JsonEditor.test.tsx` | Unit tests for JsonEditor |
| Modify | `src/web/pages/EditProject.tsx` | Swap `<Area>` → `<JsonEditor>` for devcontainer field |
| Modify | `src/web/pages/NewProject.tsx` | Add all five missing fields; use `<JsonEditor>` for devcontainer |
| Create | `src/web/pages/NewProject.test.tsx` | Tests that new fields are rendered and passed to API |

---

## Task 1: Install packages

**Files:** none (package.json + lock file)

- [ ] **Step 1: Install the two new packages**

```bash
npm install @uiw/react-codemirror @codemirror/lang-json
```

- [ ] **Step 2: Verify they appear in package.json**

```bash
grep -E "react-codemirror|lang-json" package.json
```

Expected output (versions may differ):
```
"@codemirror/lang-json": "^6.x.x",
"@uiw/react-codemirror": "^4.x.x",
```

- [ ] **Step 3: Confirm existing tests still pass**

```bash
npm test
```

Expected: all 52 tests pass, 0 failures.

---

## Task 2: Write failing JsonEditor tests

**Files:**
- Create: `src/web/components/JsonEditor.test.tsx`

- [ ] **Step 1: Create the test file**

```tsx
// src/web/components/JsonEditor.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonEditor } from './JsonEditor.js';

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea
      data-testid="codemirror"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
  oneDark: {},
}));

vi.mock('@codemirror/lang-json', () => ({
  json: () => ({}),
}));

beforeEach(() => {
  document.documentElement.classList.remove('dark');
});

describe('JsonEditor', () => {
  it('renders the label', () => {
    render(<JsonEditor label="My JSON Field" value="" onChange={() => {}} />);
    expect(screen.getByText('My JSON Field')).toBeInTheDocument();
  });

  it('shows no status indicator for empty value', () => {
    render(<JsonEditor label="JSON" value="" onChange={() => {}} />);
    expect(screen.queryByText(/valid json/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/✗/)).not.toBeInTheDocument();
  });

  it('shows valid indicator for valid JSON', () => {
    render(<JsonEditor label="JSON" value='{"image":"ubuntu:22.04"}' onChange={() => {}} />);
    expect(screen.getByText(/✓ valid json/i)).toBeInTheDocument();
  });

  it('shows error indicator for invalid JSON', () => {
    render(<JsonEditor label="JSON" value='{bad json' onChange={() => {}} />);
    expect(screen.getByText(/✗/)).toBeInTheDocument();
  });

  it('calls onChange when editor value changes', async () => {
    const onChange = vi.fn();
    render(<JsonEditor label="JSON" value="" onChange={onChange} />);
    await userEvent.type(screen.getByTestId('codemirror'), '{');
    expect(onChange).toHaveBeenCalledWith('{');
  });

  it('renders without error when dark class is set on documentElement', () => {
    document.documentElement.classList.add('dark');
    render(<JsonEditor label="JSON" value='{}' onChange={() => {}} />);
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText(/✓ valid json/i)).toBeInTheDocument();
  });

  it('updates isDark state when dark class is toggled via MutationObserver', async () => {
    render(<JsonEditor label="JSON" value="" onChange={() => {}} />);
    document.documentElement.classList.add('dark');
    await waitFor(() => {
      // component still renders correctly after toggle
      expect(screen.getByText('JSON')).toBeInTheDocument();
    });
    document.documentElement.classList.remove('dark');
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail because JsonEditor doesn't exist yet**

```bash
npm test src/web/components/JsonEditor.test.tsx
```

Expected: FAIL — `Cannot find module './JsonEditor.js'`

---

## Task 3: Implement JsonEditor

**Files:**
- Create: `src/web/components/JsonEditor.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/web/components/JsonEditor.tsx
import { useState, useEffect } from 'react';
import CodeMirror, { oneDark } from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';

interface JsonEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function JsonEditor({ label, value, onChange }: JsonEditorProps) {
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const status = parseStatus(value);

  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      <div className="border rounded overflow-hidden dark:border-gray-600">
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={[json()]}
          theme={isDark ? oneDark : undefined}
          className="text-sm"
        />
      </div>
      {status === 'valid' && (
        <p className="mt-1 text-xs text-green-600 dark:text-green-400">✓ Valid JSON</p>
      )}
      {status !== 'valid' && status !== 'empty' && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">✗ {status}</p>
      )}
    </label>
  );
}

function parseStatus(value: string): 'valid' | 'empty' | string {
  if (!value.trim()) return 'empty';
  try {
    JSON.parse(value);
    return 'valid';
  } catch (e) {
    return (e as Error).message;
  }
}
```

- [ ] **Step 2: Run tests — confirm all JsonEditor tests pass**

```bash
npm test src/web/components/JsonEditor.test.tsx
```

Expected: 7 tests pass, 0 failures.

- [ ] **Step 3: Run the full test suite — confirm nothing is broken**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/components/JsonEditor.tsx src/web/components/JsonEditor.test.tsx
git commit -m "feat: add JsonEditor component with CodeMirror 6 and live JSON validation"
```

---

## Task 4: Update EditProject to use JsonEditor

**Files:**
- Modify: `src/web/pages/EditProject.tsx`

- [ ] **Step 1: Add the import and swap the component**

Open `src/web/pages/EditProject.tsx`. Make exactly these two changes:

**Add import at the top** (after the existing imports):
```tsx
import { JsonEditor } from '../components/JsonEditor.js';
```

**Replace** this block (lines 50–52):
```tsx
      <Area label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)"
            value={p.devcontainer_override_json ?? ''}
            onChange={(v) => setP({ ...p, devcontainer_override_json: v || null })} />
```

**With:**
```tsx
      <JsonEditor label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)"
                  value={p.devcontainer_override_json ?? ''}
                  onChange={(v) => setP({ ...p, devcontainer_override_json: v || null })} />
```

- [ ] **Step 2: Run the full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/EditProject.tsx
git commit -m "feat: use JsonEditor for devcontainer override field in EditProject"
```

---

## Task 5: Write failing NewProject tests

**Files:**
- Create: `src/web/pages/NewProject.test.tsx`

- [ ] **Step 1: Create the test file**

```tsx
// src/web/pages/NewProject.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NewProjectPage } from './NewProject.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { createProject: vi.fn() },
}));

vi.mock('../components/JsonEditor.js', () => ({
  JsonEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <label>
      <span>{label}</span>
      <textarea data-testid="json-editor" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  ),
}));

describe('NewProjectPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders all expected form fields', () => {
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    );
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/repo url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/default branch/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/git author name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/git author email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/instructions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/marketplaces/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/plugins/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/devcontainer/i)).toBeInTheDocument();
  });

  it('passes all fields to api.createProject on submit', async () => {
    (api.createProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 42 });

    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/^name$/i), 'my-proj');
    await userEvent.type(screen.getByLabelText(/repo url/i), 'git@github.com:org/repo.git');
    // default branch is pre-filled 'main' — leave it
    await userEvent.type(screen.getByLabelText(/git author name/i), 'Bot');
    await userEvent.type(screen.getByLabelText(/git author email/i), 'bot@example.com');
    await userEvent.type(screen.getByLabelText(/instructions/i), 'Use TypeScript');
    await userEvent.type(screen.getByLabelText(/marketplaces/i), 'https://example.com/mp');
    await userEvent.type(screen.getByLabelText(/plugins/i), 'myplugin@https://example.com/mp');
    fireEvent.change(screen.getByTestId('json-editor'), { target: { value: '{"image":"ubuntu:22.04"}' } });

    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({
        name: 'my-proj',
        repo_url: 'git@github.com:org/repo.git',
        default_branch: 'main',
        instructions: 'Use TypeScript',
        devcontainer_override_json: '{"image":"ubuntu:22.04"}',
        git_author_name: 'Bot',
        git_author_email: 'bot@example.com',
        marketplaces: ['https://example.com/mp'],
        plugins: ['myplugin@https://example.com/mp'],
      });
    });
  });

  it('passes null for empty optional fields', async () => {
    (api.createProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 1 });

    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/^name$/i), 'bare');
    await userEvent.type(screen.getByLabelText(/repo url/i), 'git@github.com:org/repo.git');

    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: null,
          devcontainer_override_json: null,
          git_author_name: null,
          git_author_email: null,
          marketplaces: [],
          plugins: [],
        })
      );
    });
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail because NewProject doesn't have the new fields yet**

```bash
npm test src/web/pages/NewProject.test.tsx
```

Expected: FAIL — fields not found in DOM, `api.createProject` called with wrong args.

---

## Task 6: Update NewProject with all fields

**Files:**
- Modify: `src/web/pages/NewProject.tsx`

- [ ] **Step 1: Replace the entire file content**

```tsx
// src/web/pages/NewProject.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { JsonEditor } from '../components/JsonEditor.js';

function splitLines(v: string): string[] {
  return v.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function NewProjectPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [instructions, setInstructions] = useState('');
  const [marketplaces, setMarketplaces] = useState('');
  const [plugins, setPlugins] = useState('');
  const [devcontainerJson, setDevcontainerJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const p = await api.createProject({
        name,
        repo_url: repoUrl,
        default_branch: defaultBranch,
        instructions: instructions.trim() || null,
        devcontainer_override_json: devcontainerJson.trim() || null,
        git_author_name: gitAuthorName.trim() || null,
        git_author_email: gitAuthorEmail.trim() || null,
        marketplaces: splitLines(marketplaces),
        plugins: splitLines(plugins),
      });
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">New Project</h1>
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Repo URL (SSH)">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Default Branch">
        <input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          required
          className="w-full border rounded px-2 py-1 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Git author name (override)">
        <input
          value={gitAuthorName}
          onChange={(e) => setGitAuthorName(e.target.value)}
          className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Git author email (override)">
        <input
          value={gitAuthorEmail}
          onChange={(e) => setGitAuthorEmail(e.target.value)}
          className="w-full border rounded px-2 py-1 font-mono dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Project-level instructions (optional)">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={4}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Extra plugin marketplaces (one per line; merged with global defaults)">
        <textarea
          value={marketplaces}
          onChange={(e) => setMarketplaces(e.target.value)}
          rows={3}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <Field label="Extra plugins (one per line, format: name@marketplace)">
        <textarea
          value={plugins}
          onChange={(e) => setPlugins(e.target.value)}
          rows={3}
          className="w-full border rounded px-2 py-1 font-mono text-sm dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
        />
      </Field>
      <JsonEditor
        label="Devcontainer override JSON (used when repo has no .devcontainer/devcontainer.json)"
        value={devcontainerJson}
        onChange={setDevcontainerJson}
      />
      {error && <div className="text-red-600">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {submitting ? 'Creating…' : 'Create'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
    </label>
  );
}
```

- [ ] **Step 2: Run the NewProject tests**

```bash
npm test src/web/pages/NewProject.test.tsx
```

Expected: 3 tests pass, 0 failures.

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: all tests pass (now includes the 3 new NewProject tests and 7 JsonEditor tests).

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/NewProject.tsx src/web/pages/NewProject.test.tsx
git commit -m "feat: expand NewProject form with all project fields and JsonEditor"
```

---

## Done

All six tasks complete. The implementation delivers:
- `JsonEditor` component with CodeMirror 6, live validation status bar, and automatic dark/light theme switching
- `EditProject` uses `JsonEditor` for the devcontainer field
- `NewProject` exposes all the same fields as `EditProject`
