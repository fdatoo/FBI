# Ship Tab Git Error Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the actual error message when a git operation fails infrastructure-wise, and style it visually as an error.

**Architecture:** Four small sequential changes — shared type → server capture → hook exposes error kind → component applies error styling. No new abstractions; `msgIsError: boolean` is added to the hook return value alongside the existing `msg`.

**Tech Stack:** TypeScript, React, Vitest, @testing-library/react

---

## File Map

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `message?: string` to `git-unavailable` variant |
| `src/server/api/runs.ts` | Capture exception message in `catch` block |
| `src/server/api/runs.test.ts` | Add test: `execHistoryOp` throws → response contains message |
| `src/web/features/runs/useHistoryOp.ts` | Add `msgIsError: boolean` to hook return |
| `src/web/features/runs/useHistoryOp.test.ts` | New: test hook message/error-kind mapping |
| `src/web/features/runs/ship/ShipTab.tsx` | Apply `fail` tokens when `msgIsError` |

---

### Task 1: Update the shared type

**Files:**
- Modify: `src/shared/types.ts:243`

- [ ] **Step 1: Update the `git-unavailable` variant**

In `src/shared/types.ts`, change line 243 from:
```ts
  | { kind: 'git-unavailable' };
```
to:
```ts
  | { kind: 'git-unavailable'; message?: string };
```

- [ ] **Step 2: Run TypeScript check to confirm no errors**

```bash
npx tsc --noEmit
```
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add optional message to git-unavailable HistoryResult"
```

---

### Task 2: Capture the exception message on the server

**Files:**
- Modify: `src/server/api/runs.ts:595-599`
- Test: `src/server/api/runs.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/server/api/runs.test.ts`, inside the `describe('POST /api/runs/:id/history'` block (after the existing `push-submodule` test around line 629), add:

```ts
it('returns git-unavailable with message when execHistoryOp throws', async () => {
  const { dir, projects, runs, run } = setupRun();
  const app = Fastify();
  registerRunsRoutes(app, {
    runs, projects, streams: new RunStreamRegistry(), runsDir: dir, draftUploadsDir: dir,
    launch: async () => {}, cancel: async () => {},
    fireResumeNow: () => {}, continueRun: async () => {},
    markStartingForContinueRequest: () => {},
    gh: stubGh,
    orchestrator: {
      ...stubOrchestrator,
      execHistoryOp: async () => { throw new Error('Docker daemon not running'); },
    },
    wipRepo: stubWipRepo,
  });
  const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/history`, payload: { op: 'merge' } });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { kind: string; message: string };
  expect(body.kind).toBe('git-unavailable');
  expect(body.message).toBe('Docker daemon not running');
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run src/server/api/runs.test.ts
```
Expected: the new test FAILS — `body.message` is undefined because the server hasn't been updated yet.

- [ ] **Step 3: Update the server catch block**

In `src/server/api/runs.ts`, find the `catch` around line 598:
```ts
    } catch {
      return { kind: 'git-unavailable' } satisfies HistoryResult;
    }
```

Replace with:
```ts
    } catch (e) {
      return { kind: 'git-unavailable', message: e instanceof Error ? e.message : String(e) } satisfies HistoryResult;
    }
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npx vitest run src/server/api/runs.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/runs.ts src/server/api/runs.test.ts
git commit -m "feat: include exception message in git-unavailable server response"
```

---

### Task 3: Expose `msgIsError` from `useHistoryOp`

**Files:**
- Modify: `src/web/features/runs/useHistoryOp.ts`
- Create: `src/web/features/runs/useHistoryOp.test.tsx`

- [ ] **Step 1: Write failing tests for the hook**

Create `src/web/features/runs/useHistoryOp.test.tsx`:

```ts
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useHistoryOp } from './useHistoryOp.js';
import * as apiModule from '../../lib/api.js';

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe('useHistoryOp', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('sets msgIsError=false and msg on complete result', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'complete', sha: 'abc1234' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Done (abc1234)');
    expect(result.current.msgIsError).toBe(false);
  });

  it('sets msgIsError=true and msg on git-unavailable without message', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'git-unavailable' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Git operation unavailable');
    expect(result.current.msgIsError).toBe(true);
  });

  it('sets msgIsError=true and includes message on git-unavailable with message', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'git-unavailable', message: 'Docker daemon not running' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Git unavailable: Docker daemon not running');
    expect(result.current.msgIsError).toBe(true);
  });

  it('sets msgIsError=true on git-error result', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'git-error', message: 'not a git repo' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Git: not a git repo');
    expect(result.current.msgIsError).toBe(true);
  });

  it('sets msgIsError=true on invalid result', async () => {
    vi.spyOn(apiModule.api, 'postRunHistory').mockResolvedValue({ kind: 'invalid', message: 'op required' });
    const { result } = renderHook(() => useHistoryOp(1), { wrapper });
    await act(async () => { await result.current.run({ op: 'sync' }); });
    expect(result.current.msg).toBe('Invalid: op required');
    expect(result.current.msgIsError).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run src/web/features/runs/useHistoryOp.test.tsx
```
Expected: FAIL — `msgIsError` is not yet returned by the hook.

- [ ] **Step 3: Update `useHistoryOp.ts`**

Replace the entire file `src/web/features/runs/useHistoryOp.ts` with:

```ts
import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import type { HistoryOp, HistoryResult } from '@shared/types.js';

export function useHistoryOp(runId: number, onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const nav = useNavigate();

  const run = useCallback(async (op: HistoryOp): Promise<void> => {
    setBusy(true);
    setMsg(null);
    setMsgIsError(false);
    try {
      const r: HistoryResult = await api.postRunHistory(runId, op);
      if (r.kind === 'complete') {
        setMsg(r.sha ? `Done (${r.sha.slice(0, 7)})` : 'Done');
        setMsgIsError(false);
        onDone?.();
      } else if (r.kind === 'agent' || r.kind === 'conflict') {
        const label = r.kind === 'conflict' ? 'Conflict — delegated' : 'Delegated to agent';
        setMsg(`${label} (run #${r.child_run_id}) — click to view`);
        setMsgIsError(false);
        setTimeout(() => nav(`/runs/${r.child_run_id}`), 1200);
      } else if (r.kind === 'agent-busy') {
        setMsg('Agent not available — try again when the run is live.');
        setMsgIsError(false);
      } else if (r.kind === 'invalid') {
        setMsg(`Invalid: ${r.message}`);
        setMsgIsError(true);
      } else if (r.kind === 'git-error') {
        setMsg(`Git: ${r.message}`);
        setMsgIsError(true);
      } else if (r.kind === 'git-unavailable') {
        setMsg(r.message ? `Git unavailable: ${r.message}` : 'Git operation unavailable');
        setMsgIsError(true);
      }
    } catch (e) {
      setMsg(String(e));
      setMsgIsError(true);
    } finally {
      setBusy(false);
    }
  }, [runId, onDone, nav]);

  return { busy, msg, msgIsError, run };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/web/features/runs/useHistoryOp.test.tsx
```
Expected: all 5 tests pass.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/web/features/runs/useHistoryOp.ts src/web/features/runs/useHistoryOp.test.tsx
git commit -m "feat: expose msgIsError from useHistoryOp, improve git-unavailable message"
```

---

### Task 4: Apply error styling in ShipTab

**Files:**
- Modify: `src/web/features/runs/ship/ShipTab.tsx`

- [ ] **Step 1: Update ShipTab to use `msgIsError`**

In `src/web/features/runs/ship/ShipTab.tsx`, line 22, the hook call currently is:
```ts
  const { busy, msg, run: runOp } = useHistoryOp(run.id, onReload);
```

Change to:
```ts
  const { busy, msg, msgIsError, run: runOp } = useHistoryOp(run.id, onReload);
```

Then on line 39, the message paragraph currently is:
```tsx
      {msg && <p className="px-4 py-1 text-[12px] text-text-dim bg-surface-raised border-y border-border">{msg}</p>}
```

Replace with:
```tsx
      {msg && (
        <p className={`px-4 py-1 text-[12px] border-y ${
          msgIsError
            ? 'text-fail bg-fail-subtle border-fail/30'
            : 'text-text-dim bg-surface-raised border-border'
        }`}>
          {msg}
        </p>
      )}
```

- [ ] **Step 2: Run TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no output (exit 0).

- [ ] **Step 3: Run the full test suite**

```bash
npx vitest run
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/features/runs/ship/ShipTab.tsx
git commit -m "feat: style Ship tab error messages with fail tokens"
```
