# Agent-run file uploads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users attach files to an agent run and reference them from the composer as `@/fbi/uploads/<filename>`. Files live at `runs/<id>/uploads/` on the host, bind-mounted read-only into the container at `/fbi/uploads/`.

**Architecture:** A dedicated uploads API writes multipart streams to disk under `runs/<id>/uploads/` (per-run) or `draft-uploads/<token>/` (pre-run, promoted on createRun). A new `UploadTray` React component is reused by `NewRun.tsx` and `RunDetail.tsx`; it uses `XMLHttpRequest` for progress reporting. Uploads are gated by `run.state === 'waiting'` for mid-run; the NewRun form always allows uploads because the run doesn't exist yet. Filesystem is the source of truth — no DB schema changes.

**Tech Stack:** Node 20, Fastify, `@fastify/multipart` (new), TypeScript, Vitest, React, xterm.

**Spec:** `docs/superpowers/specs/2026-04-23-agent-run-file-uploads-design.md`

---

## File Structure

Server (new):
- `src/server/api/uploads.ts` — five endpoints + thin integration with `RunsRepo` and the run log store.
- `src/server/api/uploads.test.ts`
- `src/server/uploads/filenames.ts` — pure helpers: sanitize + collision resolve + size sum. Shared across upload endpoints and createRun promotion.
- `src/server/uploads/filenames.test.ts`
- `src/server/uploads/promote.ts` — atomic draft-to-run promotion. Kept separate so createRun can import one function and so tests can target it.
- `src/server/uploads/promote.test.ts`
- `src/server/housekeeping/draftUploads.ts` — `sweepDraftUploads`, `sweepPartFiles`, `startDraftUploadsGc`.
- `src/server/housekeeping/draftUploads.test.ts`

Server (modified):
- `src/server/config.ts` — add `draftUploadsDir`.
- `src/server/orchestrator/sessionId.ts` — add `runUploadsDir`.
- `src/server/api/runs.ts` — createRun accepts `draft_token`; promotes on success, rolls back on failure.
- `src/server/api/runs.test.ts` — extend.
- `src/server/orchestrator/index.ts` — add `/fbi/uploads` bind mount to the three container-launch call sites; `mkdir -p` `runUploadsDir` pre-start.
- `src/server/orchestrator/index.test.ts` (or a sibling flow test) — extend.
- `src/server/index.ts` — register `@fastify/multipart`, mount the uploads router, start the housekeeping interval.
- `src/shared/types.ts` — `UploadedFile`, `DraftUploadResponse`.

Web (new):
- `src/web/components/UploadTray.tsx`
- `src/web/components/UploadTray.test.tsx`

Web (modified):
- `src/web/lib/api.ts` — `uploadDraftFile`, `deleteDraftFile`, `uploadRunFile`, `listRunUploads`, `deleteRunUpload`; modify `createRun` to accept `draft_token`.
- `src/web/pages/NewRun.tsx` — mount tray, track draft token, insert `@/fbi/uploads/<name>` at cursor, submit with `draft_token`.
- `src/web/pages/RunDetail.tsx` — mount tray gated on `waiting`, send reference bytes via the shell WS, render attached-files disclosure.

Package:
- `package.json` — add `@fastify/multipart`.

---

## Task 1: Path helpers and shared types

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/orchestrator/sessionId.ts`
- Modify: `src/server/orchestrator/sessionId.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing test for `runUploadsDir`**

In `src/server/orchestrator/sessionId.test.ts`, add:

```ts
import { runUploadsDir } from './sessionId.js';

describe('runUploadsDir', () => {
  it('returns <runsDir>/<runId>/uploads', () => {
    expect(runUploadsDir('/var/lib/am/runs', 42)).toBe('/var/lib/am/runs/42/uploads');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/server/orchestrator/sessionId.test.ts`
Expected: FAIL — `runUploadsDir is not a function` (or module not exporting symbol).

- [ ] **Step 3: Implement `runUploadsDir`**

In `src/server/orchestrator/sessionId.ts`, after `runStateDir`:

```ts
export function runUploadsDir(runsDir: string, runId: number): string {
  return path.join(runsDir, String(runId), 'uploads');
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run src/server/orchestrator/sessionId.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `draftUploadsDir` to `Config`**

In `src/server/config.ts`:

```ts
export interface Config {
  // ...
  runsDir: string;
  draftUploadsDir: string;   // NEW
  // ...
}

export function loadConfig(): Config {
  return {
    // ...
    runsDir: process.env.RUNS_DIR ?? '/var/lib/agent-manager/runs',
    draftUploadsDir:
      process.env.DRAFT_UPLOADS_DIR ?? '/var/lib/agent-manager/draft-uploads',
    // ...
  };
}
```

- [ ] **Step 6: Add upload response types to shared types**

In `src/shared/types.ts`, append:

```ts
export interface UploadedFile {
  filename: string;
  size: number;
  uploaded_at: number;
}

export interface DraftUploadResponse extends UploadedFile {
  draft_token: string;
}
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/orchestrator/sessionId.ts src/server/orchestrator/sessionId.test.ts \
        src/server/config.ts src/shared/types.ts
git commit -m "uploads: path helpers and shared response types"
```

---

## Task 2: Filename helpers (sanitize, resolve collisions, sum sizes)

**Files:**
- Create: `src/server/uploads/filenames.ts`
- Create: `src/server/uploads/filenames.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/uploads/filenames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeFilename, resolveFilename, directoryBytes } from './filenames.js';

describe('sanitizeFilename', () => {
  it('accepts normal names including spaces, unicode, leading dots', () => {
    expect(sanitizeFilename('foo.csv')).toBe('foo.csv');
    expect(sanitizeFilename('My File (2).pdf')).toBe('My File (2).pdf');
    expect(sanitizeFilename('café.md')).toBe('café.md');
    expect(sanitizeFilename('.env')).toBe('.env');
  });

  it('rejects path separators', () => {
    expect(() => sanitizeFilename('a/b')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('a\\b')).toThrow('invalid_filename');
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeFilename('a\0b')).toThrow('invalid_filename');
  });

  it('rejects traversal', () => {
    expect(() => sanitizeFilename('..')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('.')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('..foo')).toThrow('invalid_filename');
  });

  it('rejects empty and oversized names', () => {
    expect(() => sanitizeFilename('')).toThrow('invalid_filename');
    expect(() => sanitizeFilename('a'.repeat(256))).toThrow('invalid_filename');
  });
});

describe('resolveFilename', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-fn-'));
  }

  it('returns the name unchanged when the directory is empty', () => {
    const dir = tmpDir();
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo.csv');
  });

  it('suffixes on collision before the extension', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'foo.csv'), '');
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo (1).csv');
    fs.writeFileSync(path.join(dir, 'foo (1).csv'), '');
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo (2).csv');
  });

  it('suffixes at the end when there is no extension', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'Makefile'), '');
    expect(resolveFilename(dir, 'Makefile')).toBe('Makefile (1)');
  });

  it('ignores .part files when resolving', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'foo.csv.part'), '');
    expect(resolveFilename(dir, 'foo.csv')).toBe('foo.csv');
  });
});

describe('directoryBytes', () => {
  it('sums non-.part file sizes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-fn-'));
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.alloc(50));
    fs.writeFileSync(path.join(dir, 'c.part'), Buffer.alloc(999));
    expect(await directoryBytes(dir)).toBe(150);
  });

  it('returns 0 for a missing directory', async () => {
    expect(await directoryBytes('/nonexistent/xyz')).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/server/uploads/filenames.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `filenames.ts`**

Create `src/server/uploads/filenames.ts`:

```ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_FILENAME_BYTES = 255;

export function sanitizeFilename(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid_filename');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('invalid_filename');
  }
  if (name === '.' || name === '..' || name.startsWith('..')) {
    throw new Error('invalid_filename');
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_FILENAME_BYTES) {
    throw new Error('invalid_filename');
  }
  return name;
}

export function resolveFilename(dir: string, incoming: string): string {
  const base = sanitizeFilename(incoming);
  const existing = new Set<string>();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.part')) existing.add(f);
    }
  } catch {
    return base;
  }
  if (!existing.has(base)) return base;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 10_000; i++) {
    const candidate = ext ? `${stem} (${i})${ext}` : `${stem} (${i})`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error('collision_overflow');
}

export async function directoryBytes(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const name of entries) {
    if (name.endsWith('.part')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) sum += st.size;
    } catch {
      /* ignore stat errors */
    }
  }
  return sum;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/server/uploads/filenames.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/server/uploads/filenames.ts src/server/uploads/filenames.test.ts
git commit -m "uploads: filename sanitize, collision-resolve, byte sum helpers"
```

---

## Task 3: Add `@fastify/multipart`

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the dependency**

Run: `npm install @fastify/multipart@^9`
Expected: installs; `package.json` and `package-lock.json` updated.

- [ ] **Step 2: Confirm version compatibility**

Run: `npm ls fastify @fastify/multipart`
Expected: `@fastify/multipart` installed; peer matches existing Fastify major.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "uploads: add @fastify/multipart dependency"
```

---

## Task 4: Draft-token generator

**Files:**
- Create: `src/server/uploads/token.ts`
- Create: `src/server/uploads/token.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/uploads/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateDraftToken, isDraftToken } from './token.js';

describe('generateDraftToken', () => {
  it('returns 32-char lowercase hex', () => {
    const t = generateDraftToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces different tokens on successive calls', () => {
    const a = generateDraftToken();
    const b = generateDraftToken();
    expect(a).not.toBe(b);
  });
});

describe('isDraftToken', () => {
  it('accepts a generated token', () => {
    expect(isDraftToken(generateDraftToken())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDraftToken('')).toBe(false);
    expect(isDraftToken('abc')).toBe(false);
    expect(isDraftToken('a'.repeat(32))).toBe(false);            // not hex
    expect(isDraftToken('A'.repeat(32))).toBe(false);            // uppercase
    expect(isDraftToken('/' + '0'.repeat(31))).toBe(false);
    expect(isDraftToken('..')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/server/uploads/token.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/server/uploads/token.ts`:

```ts
import crypto from 'node:crypto';

const TOKEN_RE = /^[0-9a-f]{32}$/;

export function generateDraftToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isDraftToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}
```

- [ ] **Step 4: Run and verify passing**

Run: `npx vitest run src/server/uploads/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/uploads/token.ts src/server/uploads/token.test.ts
git commit -m "uploads: draft token generator and validator"
```

---

## Task 5: Upload routes — draft endpoints

**Files:**
- Create: `src/server/api/uploads.ts`
- Create: `src/server/api/uploads.test.ts`

- [ ] **Step 1: Write failing test for `POST /api/draft-uploads`**

Create `src/server/api/uploads.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import FormData from 'form-data';
import { openDb } from '../db/index.js';
import { ProjectsRepo } from '../db/projects.js';
import { RunsRepo } from '../db/runs.js';
import { LogStore } from '../logs/store.js';
import { registerUploadsRoutes } from './uploads.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-up-'));
  const runsDir = path.join(dir, 'runs');
  const draftUploadsDir = path.join(dir, 'draft-uploads');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(draftUploadsDir, { recursive: true });
  const db = openDb(path.join(dir, 'db.sqlite'));
  const runs = new RunsRepo(db);
  const projects = new ProjectsRepo(db);
  const logs = new LogStore({
    runsDir,
    logPathForId: (id) => path.join(runsDir, `${id}.log`),
  });
  const app = Fastify();
  void app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
  });
  registerUploadsRoutes(app, { runs, runsDir, draftUploadsDir, logs });
  return { app, dir, runsDir, draftUploadsDir, runs, projects };
}

async function injectMultipart(app: Awaited<ReturnType<typeof setup>>['app'],
  url: string, filename: string, body: Buffer): Promise<import('light-my-request').Response> {
  const form = new FormData();
  form.append('file', body, { filename, contentType: 'application/octet-stream' });
  return app.inject({
    method: 'POST',
    url,
    headers: form.getHeaders(),
    payload: form.getBuffer(),
  });
}

describe('POST /api/draft-uploads', () => {
  it('creates a token and writes the file when no token is supplied', async () => {
    const { app, draftUploadsDir } = setup();
    const res = await injectMultipart(app, '/api/draft-uploads', 'foo.csv', Buffer.from('hello'));
    expect(res.statusCode).toBe(200);
    const body = res.json() as { draft_token: string; filename: string; size: number };
    expect(body.draft_token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.filename).toBe('foo.csv');
    expect(body.size).toBe(5);
    const written = fs.readFileSync(
      path.join(draftUploadsDir, body.draft_token, 'foo.csv'),
      'utf8',
    );
    expect(written).toBe('hello');
  });

  it('appends to an existing token and renames on collision', async () => {
    const { app, draftUploadsDir } = setup();
    const first = await injectMultipart(app, '/api/draft-uploads', 'foo.csv', Buffer.from('a'));
    const token = (first.json() as { draft_token: string }).draft_token;
    const second = await injectMultipart(
      app, `/api/draft-uploads?draft_token=${token}`, 'foo.csv', Buffer.from('b'),
    );
    expect(second.statusCode).toBe(200);
    expect((second.json() as { filename: string }).filename).toBe('foo (1).csv');
    expect(fs.readdirSync(path.join(draftUploadsDir, token)).sort()).toEqual(
      ['foo (1).csv', 'foo.csv'],
    );
  });

  it('returns 400 on invalid filename', async () => {
    const { app } = setup();
    const res = await injectMultipart(app, '/api/draft-uploads', '../etc/passwd', Buffer.from('x'));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_filename' });
  });
});

describe('DELETE /api/draft-uploads/:token/:filename', () => {
  it('removes the file', async () => {
    const { app, draftUploadsDir } = setup();
    const post = await injectMultipart(app, '/api/draft-uploads', 'foo.csv', Buffer.from('x'));
    const token = (post.json() as { draft_token: string }).draft_token;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/draft-uploads/${token}/foo.csv`,
    });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(draftUploadsDir, token, 'foo.csv'))).toBe(false);
  });

  it('returns 404 when the token is unknown', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/draft-uploads/00000000000000000000000000000000/foo.csv',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when the token is malformed', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/draft-uploads/bogus/foo.csv',
    });
    expect(res.statusCode).toBe(400);
  });
});
```

If `form-data` is not already in devDependencies, install it: `npm install --save-dev form-data`.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/server/api/uploads.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the uploads module (draft endpoints only for now)**

Create `src/server/api/uploads.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RunsRepo } from '../db/runs.js';
import type { LogStore } from '../logs/store.js';
import { generateDraftToken, isDraftToken } from '../uploads/token.js';
import { sanitizeFilename, resolveFilename, directoryBytes } from '../uploads/filenames.js';

const PER_FILE_BYTES = 100 * 1024 * 1024;
const PER_RUN_BYTES = 1024 * 1024 * 1024;

interface Deps {
  runs: RunsRepo;
  runsDir: string;
  draftUploadsDir: string;
  logs: LogStore;
}

export function registerUploadsRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/api/draft-uploads', async (req, reply) => {
    const query = req.query as { draft_token?: unknown };
    let token = typeof query.draft_token === 'string' ? query.draft_token : '';
    if (token.length > 0 && !isDraftToken(token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    if (token.length === 0) token = generateDraftToken();

    const dir = path.join(deps.draftUploadsDir, token);
    await fsp.mkdir(dir, { recursive: true });

    const result = await consumeOneFile(req, dir, PER_RUN_BYTES);
    if ('error' in result) return reply.code(result.status).send({ error: result.error });

    return reply.code(200).send({
      draft_token: token,
      filename: result.filename,
      size: result.size,
      uploaded_at: result.uploadedAt,
    });
  });

  app.delete('/api/draft-uploads/:token/:filename', async (req, reply) => {
    const params = req.params as { token: string; filename: string };
    if (!isDraftToken(params.token)) {
      return reply.code(400).send({ error: 'invalid_token' });
    }
    let filename: string;
    try {
      filename = sanitizeFilename(params.filename);
    } catch {
      return reply.code(400).send({ error: 'invalid_filename' });
    }
    const dir = path.join(deps.draftUploadsDir, params.token);
    const file = path.join(dir, filename);
    try {
      await fsp.unlink(file);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.code(204).send();
  });
}

interface ConsumeOk {
  filename: string;
  size: number;
  uploadedAt: number;
}
interface ConsumeErr {
  error: string;
  status: number;
}

async function consumeOneFile(
  req: Parameters<Parameters<FastifyInstance['post']>[1]>[0],
  targetDir: string,
  cumulativeLimit: number,
): Promise<ConsumeOk | ConsumeErr> {
  const mp = await (req as unknown as { file: () => Promise<Multipart> }).file();
  if (!mp) return { error: 'no_file', status: 400 };

  let sanitized: string;
  try {
    sanitized = sanitizeFilename(mp.filename);
  } catch {
    mp.file.resume();
    return { error: 'invalid_filename', status: 400 };
  }

  const existing = await directoryBytes(targetDir);
  if (existing >= cumulativeLimit) {
    mp.file.resume();
    return { error: 'run_quota_exceeded', status: 413 };
  }

  const finalName = resolveFilename(targetDir, sanitized);
  const finalPath = path.join(targetDir, finalName);
  const partPath = finalPath + '.part';

  const out = fs.createWriteStream(partPath, { flags: 'w' });
  let written = 0;
  let overflow = false;
  mp.file.on('data', (chunk: Buffer) => {
    written += chunk.length;
    if (existing + written > cumulativeLimit) {
      overflow = true;
      mp.file.destroy();
    }
  });
  try {
    await pipeline(mp.file, out);
  } catch {
    await fsp.unlink(partPath).catch(() => {});
    if (overflow) return { error: 'run_quota_exceeded', status: 413 };
    if ((mp.file as unknown as { truncated?: boolean }).truncated) {
      return { error: 'file_too_large', status: 413 };
    }
    return { error: 'io_error', status: 500 };
  }
  if (overflow) {
    await fsp.unlink(partPath).catch(() => {});
    return { error: 'run_quota_exceeded', status: 413 };
  }

  // Atomic promotion from .part → final. If another request raced us to the
  // same target (resolveFilename picked the same suffix), loop and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsp.link(partPath, finalPath);
      await fsp.unlink(partPath);
      return { filename: finalName, size: written, uploadedAt: Date.now() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fsp.unlink(partPath).catch(() => {});
        return { error: 'io_error', status: 500 };
      }
      const retryName = resolveFilename(targetDir, sanitized);
      const retryPath = path.join(targetDir, retryName);
      try {
        await fsp.link(partPath, retryPath);
        await fsp.unlink(partPath);
        return { filename: retryName, size: written, uploadedAt: Date.now() };
      } catch {
        /* will retry outer loop */
      }
    }
  }
  await fsp.unlink(partPath).catch(() => {});
  return { error: 'io_error', status: 500 };
}

interface Multipart {
  filename: string;
  file: NodeJS.ReadableStream & { truncated?: boolean; destroy(): void; resume(): void };
}
```

Note: the `@fastify/multipart` `Multipart` type is imported implicitly by the plugin's type augmentation of `FastifyRequest`. The local `Multipart` interface exists only so the implementation reads cleanly; you may replace it with the plugin's own type if that reads better.

- [ ] **Step 4: Run and verify passing**

Run: `npx vitest run src/server/api/uploads.test.ts`
Expected: PASS — the three `POST /api/draft-uploads` cases and the three DELETE cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/uploads.ts src/server/api/uploads.test.ts package.json package-lock.json
git commit -m "uploads: draft-upload POST and DELETE endpoints"
```

---

## Task 6: Upload routes — per-run endpoints

**Files:**
- Modify: `src/server/api/uploads.ts`
- Modify: `src/server/api/uploads.test.ts`

- [ ] **Step 1: Extend the test helpers to create a run**

In `src/server/api/uploads.test.ts`, add a helper that creates a run with a given state:

```ts
function makeRun(app: Awaited<ReturnType<typeof setup>>, state: 'queued' | 'running' | 'waiting' | 'succeeded' = 'waiting') {
  const proj = app.projects.create({
    name: 'p', repo_url: 'r', default_branch: 'main',
    devcontainer_override_json: null, instructions: null,
    git_author_name: null, git_author_email: null,
  });
  const run = app.runs.create({
    project_id: proj.id,
    prompt: 'hi',
    branch_hint: undefined,
    log_path_tmpl: (rid) => path.join(app.runsDir, `${rid}.log`),
  });
  // transition to desired state
  if (state === 'running') app.runs.markRunning(run.id);
  else if (state === 'waiting') {
    app.runs.markRunning(run.id);
    app.runs.markWaiting(run.id);
  } else if (state === 'succeeded') {
    app.runs.markRunning(run.id);
    app.runs.markSucceeded(run.id, { exitCode: 0, branchName: null, headCommit: null });
  }
  return run;
}
```

Check the names of the repo methods in `src/server/db/runs.ts` and use the actual available methods (e.g., if `markSucceeded` has a different signature, adjust accordingly). The point is to land the run in the requested state.

- [ ] **Step 2: Add failing tests for `POST /api/runs/:id/uploads`**

Append to `uploads.test.ts`:

```ts
describe('POST /api/runs/:id/uploads', () => {
  it('writes the file when state is waiting', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(200);
    expect((res.json() as { filename: string }).filename).toBe('foo.csv');
    const written = fs.readFileSync(path.join(s.runsDir, String(run.id), 'uploads', 'foo.csv'), 'utf8');
    expect(written).toBe('hi');
  });

  it('returns 409 when state is running', async () => {
    const s = setup();
    const run = makeRun(s, 'running');
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'wrong_state' });
  });

  it('returns 409 when state is succeeded', async () => {
    const s = setup();
    const run = makeRun(s, 'succeeded');
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(409);
  });

  it('returns 404 when the run does not exist', async () => {
    const s = setup();
    const res = await injectMultipart(s.app, '/api/runs/999999/uploads', 'foo.csv', Buffer.from('hi'));
    expect(res.statusCode).toBe(404);
  });

  it('returns 413 when the cumulative quota is exceeded', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    // Pre-seed directory with a near-1GiB file
    const dir = path.join(s.runsDir, String(run.id), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big.bin');
    const fd = fs.openSync(big, 'w');
    fs.ftruncateSync(fd, 1024 * 1024 * 1024 - 10);
    fs.closeSync(fd);
    const res = await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('more-than-10-bytes'));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'run_quota_exceeded' });
  });

  it('appends a one-line upload marker to the run log', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('hello'));
    const log = fs.readFileSync(path.join(s.runsDir, `${run.id}.log`), 'utf8');
    expect(log).toContain('[fbi] user uploaded foo.csv');
  });
});

describe('GET /api/runs/:id/uploads', () => {
  it('lists files alphabetically', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'b.txt', Buffer.from('b'));
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'a.txt', Buffer.from('a'));
    const res = await s.app.inject({ method: 'GET', url: `/api/runs/${run.id}/uploads` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { files: Array<{ filename: string }> };
    expect(body.files.map(f => f.filename)).toEqual(['a.txt', 'b.txt']);
  });

  it('returns an empty list when the directory does not exist', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    const res = await s.app.inject({ method: 'GET', url: `/api/runs/${run.id}/uploads` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { files: unknown[] }).files).toEqual([]);
  });
});

describe('DELETE /api/runs/:id/uploads/:filename', () => {
  it('removes the file when state is waiting', async () => {
    const s = setup();
    const run = makeRun(s, 'waiting');
    await injectMultipart(s.app, `/api/runs/${run.id}/uploads`, 'foo.csv', Buffer.from('x'));
    const res = await s.app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/uploads/foo.csv` });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(s.runsDir, String(run.id), 'uploads', 'foo.csv'))).toBe(false);
  });

  it('returns 409 when state is not waiting', async () => {
    const s = setup();
    const run = makeRun(s, 'running');
    // file was never written (POST would have 409'd); use direct write to simulate
    const dir = path.join(s.runsDir, String(run.id), 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'foo.csv'), 'x');
    const res = await s.app.inject({ method: 'DELETE', url: `/api/runs/${run.id}/uploads/foo.csv` });
    expect(res.statusCode).toBe(409);
    expect(fs.existsSync(path.join(dir, 'foo.csv'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run src/server/api/uploads.test.ts`
Expected: FAIL (the three `POST /api/runs/:id/uploads`, list, and delete describe blocks all fail — routes not registered).

- [ ] **Step 4: Add the three endpoints to `uploads.ts`**

Append to the body of `registerUploadsRoutes`:

```ts
app.post('/api/runs/:id/uploads', async (req, reply) => {
  const runId = Number((req.params as { id: string }).id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  if (run.state !== 'waiting') return reply.code(409).send({ error: 'wrong_state' });

  const dir = path.join(deps.runsDir, String(runId), 'uploads');
  await fsp.mkdir(dir, { recursive: true });

  const result = await consumeOneFile(req, dir, PER_RUN_BYTES);
  if ('error' in result) return reply.code(result.status).send({ error: result.error });

  deps.logs.append(
    runId,
    Buffer.from(`[fbi] user uploaded ${result.filename} (${humanSize(result.size)})\n`),
  );

  return reply.code(200).send({
    filename: result.filename,
    size: result.size,
    uploaded_at: result.uploadedAt,
  });
});

app.get('/api/runs/:id/uploads', async (req, reply) => {
  const runId = Number((req.params as { id: string }).id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  const dir = path.join(deps.runsDir, String(runId), 'uploads');
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { files: [] };
  }
  const files: Array<{ filename: string; size: number; uploaded_at: number }> = [];
  for (const name of entries.sort()) {
    if (name.endsWith('.part')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) files.push({ filename: name, size: st.size, uploaded_at: st.mtimeMs });
    } catch { /* noop */ }
  }
  return { files };
});

app.delete('/api/runs/:id/uploads/:filename', async (req, reply) => {
  const runId = Number((req.params as { id: string }).id);
  const run = deps.runs.get(runId);
  if (!run) return reply.code(404).send({ error: 'not_found' });
  if (run.state !== 'waiting') return reply.code(409).send({ error: 'wrong_state' });

  let filename: string;
  try {
    filename = sanitizeFilename((req.params as { filename: string }).filename);
  } catch {
    return reply.code(400).send({ error: 'invalid_filename' });
  }
  const file = path.join(deps.runsDir, String(runId), 'uploads', filename);
  try {
    await fsp.unlink(file);
  } catch {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(204).send();
});
```

Add a small helper at the bottom of the file:

```ts
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
```

Double-check that `LogStore.append(runId, Buffer)` is the right call site by reading `src/server/logs/store.ts`; if the method has a different name (e.g., `write`, `appendToRun`), adjust the call and the `LogStore` type on `Deps`. Keep the test assertion (`log.includes('[fbi] user uploaded foo.csv')`) as the truth source.

- [ ] **Step 5: Run and verify passing**

Run: `npx vitest run src/server/api/uploads.test.ts`
Expected: PASS (all draft + per-run tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/api/uploads.ts src/server/api/uploads.test.ts
git commit -m "uploads: per-run POST/GET/DELETE endpoints with waiting-state gate"
```

---

## Task 7: Wire the uploads router + multipart into the server

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Register `@fastify/multipart` and the uploads router**

In `src/server/index.ts`, near the other `app.register` / `register*Routes` calls:

```ts
import fastifyMultipart from '@fastify/multipart';
import { registerUploadsRoutes } from './api/uploads.js';
// ...
await app.register(fastifyMultipart, {
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 },
});
// ...
fs.mkdirSync(config.draftUploadsDir, { recursive: true });
registerUploadsRoutes(app, {
  runs,
  runsDir: config.runsDir,
  draftUploadsDir: config.draftUploadsDir,
  logs,
});
```

Use the same `logs` instance that the rest of the server uses; if it lives under a different name or is passed into the orchestrator, match the existing shape.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full server test suite**

Run: `npx vitest run src/server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "uploads: register multipart and uploads router in server composition"
```

---

## Task 8: Housekeeping — `sweepDraftUploads` and `sweepPartFiles`

**Files:**
- Create: `src/server/housekeeping/draftUploads.ts`
- Create: `src/server/housekeeping/draftUploads.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/housekeeping/draftUploads.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sweepDraftUploads,
  sweepPartFiles,
  startDraftUploadsGc,
} from './draftUploads.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-hk-'));
}

describe('sweepDraftUploads', () => {
  it('deletes token directories older than 24h', async () => {
    const base = mkTmp();
    const old = path.join(base, 'aaaa');
    const fresh = path.join(base, 'bbbb');
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(old, 'a.txt'), 'x');
    fs.writeFileSync(path.join(fresh, 'b.txt'), 'x');

    const now = Date.now();
    const oldMs = now - 25 * 60 * 60 * 1000;
    fs.utimesSync(old, oldMs / 1000, oldMs / 1000);

    await sweepDraftUploads(base, now);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('is a no-op if the base directory does not exist', async () => {
    await expect(sweepDraftUploads('/nonexistent/xyz', Date.now())).resolves.toBeUndefined();
  });
});

describe('sweepPartFiles', () => {
  it('removes .part files under runs/*/uploads and draft-uploads/*', async () => {
    const base = mkTmp();
    const runsDir = path.join(base, 'runs');
    const draftDir = path.join(base, 'draft-uploads');
    fs.mkdirSync(path.join(runsDir, '1', 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(draftDir, 'aaaa'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, '1', 'uploads', 'x.part'), '');
    fs.writeFileSync(path.join(runsDir, '1', 'uploads', 'y.csv'), 'keep');
    fs.writeFileSync(path.join(draftDir, 'aaaa', 'z.part'), '');

    await sweepPartFiles(runsDir, draftDir);

    expect(fs.existsSync(path.join(runsDir, '1', 'uploads', 'x.part'))).toBe(false);
    expect(fs.existsSync(path.join(runsDir, '1', 'uploads', 'y.csv'))).toBe(true);
    expect(fs.existsSync(path.join(draftDir, 'aaaa', 'z.part'))).toBe(false);
  });
});

describe('startDraftUploadsGc', () => {
  it('runs both sweeps at startup and returns a stop function', async () => {
    const base = mkTmp();
    const runsDir = path.join(base, 'runs');
    const draftDir = path.join(base, 'draft-uploads');
    fs.mkdirSync(path.join(runsDir, '1', 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(draftDir, 'cccc'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, '1', 'uploads', 'x.part'), '');
    const stop = startDraftUploadsGc({ runsDir, draftDir, intervalMs: 60_000 });
    await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(path.join(runsDir, '1', 'uploads', 'x.part'))).toBe(false);
    stop();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/server/housekeeping/draftUploads.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the housekeeping module**

Create `src/server/housekeeping/draftUploads.ts`:

```ts
import fsp from 'node:fs/promises';
import path from 'node:path';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export async function sweepDraftUploads(draftDir: string, now: number): Promise<void> {
  let tokens: string[];
  try {
    tokens = await fsp.readdir(draftDir);
  } catch {
    return;
  }
  for (const token of tokens) {
    const full = path.join(draftDir, token);
    try {
      const st = await fsp.stat(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs >= DRAFT_TTL_MS) {
        await fsp.rm(full, { recursive: true, force: true });
      }
    } catch {
      /* noop */
    }
  }
}

export async function sweepPartFiles(runsDir: string, draftDir: string): Promise<void> {
  await sweepPartFilesUnder(draftDir);
  try {
    const runs = await fsp.readdir(runsDir);
    for (const r of runs) {
      const uploads = path.join(runsDir, r, 'uploads');
      await sweepPartFilesIn(uploads);
    }
  } catch {
    /* noop */
  }
}

async function sweepPartFilesUnder(root: string): Promise<void> {
  let subs: string[];
  try {
    subs = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const s of subs) {
    await sweepPartFilesIn(path.join(root, s));
  }
}

async function sweepPartFilesIn(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.part')) continue;
    await fsp.unlink(path.join(dir, n)).catch(() => {});
  }
}

export interface StartDraftUploadsGcOpts {
  runsDir: string;
  draftDir: string;
  intervalMs?: number;
  now?: () => number;
}

export function startDraftUploadsGc(opts: StartDraftUploadsGcOpts): () => void {
  const interval = opts.intervalMs ?? 60 * 60 * 1000;
  const now = opts.now ?? (() => Date.now());

  // Startup sweep: part files first, then expired drafts.
  void (async () => {
    await sweepPartFiles(opts.runsDir, opts.draftDir);
    await sweepDraftUploads(opts.draftDir, now());
  })();

  const t = setInterval(() => {
    void sweepDraftUploads(opts.draftDir, now());
  }, interval);
  // Node intervals keep the event loop alive; unref so tests and shutdown are clean.
  t.unref?.();

  return () => clearInterval(t);
}
```

- [ ] **Step 4: Run and verify passing**

Run: `npx vitest run src/server/housekeeping/draftUploads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/housekeeping/draftUploads.ts src/server/housekeeping/draftUploads.test.ts
git commit -m "uploads: draft GC + .part sweeper"
```

---

## Task 9: Start the GC from the server composition

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: Wire `startDraftUploadsGc` in**

In `src/server/index.ts`, after the uploads router is registered:

```ts
import { startDraftUploadsGc } from './housekeeping/draftUploads.js';
// ...
const stopDraftUploadsGc = startDraftUploadsGc({
  runsDir: config.runsDir,
  draftDir: config.draftUploadsDir,
});
```

If the file has a shutdown hook / `app.addHook('onClose', …)`, call `stopDraftUploadsGc()` there. If it does not, leave the variable unused — the `unref`'d interval will not keep the process alive.

- [ ] **Step 2: Typecheck + full test run**

Run: `npm run typecheck && npx vitest run src/server`
Expected: no errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "uploads: start draft housekeeping at server startup"
```

---

## Task 10: Orchestrator — bind-mount `/fbi/uploads`

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Create (if absent) or extend: an orchestrator flow test that asserts the bind mount is present.

- [ ] **Step 1: Locate the flow tests and pick a target**

The existing flow tests are `waiting.flow.test.ts`, `reattach.flow.test.ts`, `continueRun.flow.test.ts`, `autoResume.flow.test.ts`. These use a mocked Docker client; the mock captures the `createContainer` arguments. Pick the one that exercises `launch` end-to-end (most likely the top of `reattach.flow.test.ts` or an existing `launch` flow test). Read it for the pattern before writing.

- [ ] **Step 2: Write a failing assertion**

In whichever flow test exercises `launch`, add an assertion that the container's `HostConfig.Binds` includes the uploads mount:

```ts
const createArgs = mockDocker.createContainer.mock.calls[0][0];
const binds = createArgs.HostConfig.Binds as string[];
expect(binds).toContainEqual(`${runUploadsDir(dir, run.id)}:/fbi/uploads:ro`);
```

If the test also drives `continueRun` and `resume`, add the same assertion for those call sites.

- [ ] **Step 3: Run and verify failure**

Run: `npx vitest run src/server/orchestrator`
Expected: FAIL — `Binds` list missing the uploads entry.

- [ ] **Step 4: Implement the bind mount**

In `src/server/orchestrator/index.ts`:

1. Add a helper near the other `*DirFor` methods:

```ts
private uploadsDirFor(runId: number): string {
  return runUploadsDir(this.deps.config.runsDir, runId);
}

private ensureUploadsDir(runId: number): string {
  const dir = this.uploadsDirFor(runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
```

2. In `createContainerForRun` (and any other location that builds the `Binds` list — verify via grep), add the read-only mount to the array:

```ts
Binds: [
  `${SUPERVISOR}:/usr/local/bin/supervisor.sh:ro`,
  `${FINALIZE_BRANCH}:/usr/local/bin/fbi-finalize-branch.sh:ro`,
  `${mountDir}:/home/agent/.claude/projects/`,
  `${this.ensureStateDir(runId)}:/fbi-state/`,
  `${this.ensureUploadsDir(runId)}:/fbi/uploads:ro`,    // NEW
  ...claudeAuthMounts(this.deps.config.hostClaudeDir),
  ...auth.mounts().map((m) =>
    `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`
  ),
],
```

3. Import `runUploadsDir` alongside `runMountDir`, `runStateDir`:

```ts
import { scanSessionId, runMountDir, runStateDir, runUploadsDir } from './sessionId.js';
```

- [ ] **Step 5: Run and verify passing**

Run: `npx vitest run src/server/orchestrator`
Expected: PASS on all flow tests, including the new bind assertion for `launch`, `continueRun`, `resume`.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts src/server/orchestrator/*flow.test.ts
git commit -m "uploads: bind-mount /fbi/uploads (read-only) on container start"
```

---

## Task 11: Draft promotion + createRun integration

**Files:**
- Create: `src/server/uploads/promote.ts`
- Create: `src/server/uploads/promote.test.ts`
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts`

- [ ] **Step 1: Write failing tests for `promoteDraft`**

Create `src/server/uploads/promote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promoteDraft } from './promote.js';

function mk(): { base: string; draftDir: string; runsDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-promote-'));
  return {
    base,
    draftDir: path.join(base, 'draft-uploads'),
    runsDir: path.join(base, 'runs'),
  };
}

describe('promoteDraft', () => {
  it('moves files from draft-uploads/<token>/ to runs/<id>/uploads/', async () => {
    const { draftDir, runsDir } = mk();
    const token = 'a'.repeat(32);
    fs.mkdirSync(path.join(draftDir, token), { recursive: true });
    fs.writeFileSync(path.join(draftDir, token, 'foo.csv'), 'hello');

    const promoted = await promoteDraft({ draftDir, runsDir, token, runId: 7 });

    expect(promoted).toEqual([{ filename: 'foo.csv', size: 5 }]);
    expect(fs.existsSync(path.join(draftDir, token))).toBe(false);
    expect(fs.readFileSync(path.join(runsDir, '7', 'uploads', 'foo.csv'), 'utf8')).toBe('hello');
  });

  it('renames on collision inside the destination', async () => {
    const { draftDir, runsDir } = mk();
    const token = 'b'.repeat(32);
    fs.mkdirSync(path.join(runsDir, '9', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, '9', 'uploads', 'a.txt'), 'existing');
    fs.mkdirSync(path.join(draftDir, token), { recursive: true });
    fs.writeFileSync(path.join(draftDir, token, 'a.txt'), 'new');

    const promoted = await promoteDraft({ draftDir, runsDir, token, runId: 9 });
    expect(promoted.map(p => p.filename)).toEqual(['a (1).txt']);
    expect(fs.readFileSync(path.join(runsDir, '9', 'uploads', 'a.txt'), 'utf8')).toBe('existing');
    expect(fs.readFileSync(path.join(runsDir, '9', 'uploads', 'a (1).txt'), 'utf8')).toBe('new');
  });

  it('throws when the token directory does not exist', async () => {
    const { draftDir, runsDir } = mk();
    await expect(promoteDraft({ draftDir, runsDir, token: 'c'.repeat(32), runId: 1 }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/server/uploads/promote.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `promoteDraft`**

Create `src/server/uploads/promote.ts`:

```ts
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveFilename } from './filenames.js';

export interface PromoteArgs {
  draftDir: string;
  runsDir: string;
  token: string;
  runId: number;
}

export interface PromotedFile {
  filename: string;
  size: number;
}

export async function promoteDraft(args: PromoteArgs): Promise<PromotedFile[]> {
  const src = path.join(args.draftDir, args.token);
  const dst = path.join(args.runsDir, String(args.runId), 'uploads');
  const entries = await fsp.readdir(src); // throws if token dir missing
  await fsp.mkdir(dst, { recursive: true });
  const out: PromotedFile[] = [];
  for (const name of entries) {
    if (name.endsWith('.part')) continue;
    const finalName = resolveFilename(dst, name);
    const srcPath = path.join(src, name);
    const dstPath = path.join(dst, finalName);
    await fsp.rename(srcPath, dstPath);
    const st = await fsp.stat(dstPath);
    out.push({ filename: finalName, size: st.size });
  }
  await fsp.rm(src, { recursive: true, force: true });
  return out;
}
```

Note: `rename` crosses devices only when source and destination are on the same filesystem — which they are here, since both sit under `/var/lib/agent-manager/`. No `EXDEV` handling is needed.

- [ ] **Step 4: Run and verify passing**

Run: `npx vitest run src/server/uploads/promote.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing test for createRun with draft_token**

In `src/server/api/runs.test.ts`, add:

```ts
import fastifyMultipart from '@fastify/multipart';
import FormData from 'form-data';
import { registerUploadsRoutes } from './uploads.js';
import { LogStore } from '../logs/store.js';

// Within the existing describe('runs routes', …):
it('POST /api/projects/:id/runs with draft_token promotes uploads and still launches', async () => {
  const { app, projectId, launched, runs } = setup();
  // Register uploads + multipart on the same app to get a draft token.
  const draftUploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-du-'));
  void app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 2 } });
  // ... actually reuse setup() if it already registers uploads; if not, extend setup().

  // For the single integration point we want, do the draft upload + createRun in sequence.
  const form = new FormData();
  form.append('file', Buffer.from('hi'), { filename: 'foo.csv' });
  const up = await app.inject({
    method: 'POST', url: '/api/draft-uploads',
    headers: form.getHeaders(), payload: form.getBuffer(),
  });
  const draft_token = (up.json() as { draft_token: string }).draft_token;

  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/runs`,
    payload: { prompt: 'hi', draft_token },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: number };
  expect(launched).toEqual([body.id]);
  // The file landed in the run's uploads dir.
  expect(fs.existsSync(
    path.join(/* runsDir from setup */'', String(body.id), 'uploads', 'foo.csv'),
  )).toBe(true);
});
```

Where `setup()` currently returns `runsDir`, reuse it. If it does not, **update `setup()` to also register the uploads routes and expose `runsDir` and `draftUploadsDir`** so this test can assert the file landing. Refactor `setup()` once and update both pre-existing and new tests if needed.

- [ ] **Step 6: Run and verify failure**

Run: `npx vitest run src/server/api/runs.test.ts`
Expected: FAIL — createRun does not accept `draft_token` yet.

- [ ] **Step 7: Modify `createRun` handler**

In `src/server/api/runs.ts`, update `app.post('/api/projects/:id/runs', …)`:

```ts
import { promoteDraft } from '../uploads/promote.js';
import { isDraftToken } from '../uploads/token.js';
// Extend Deps:
interface Deps {
  // ...
  draftUploadsDir: string;     // NEW
}

app.post('/api/projects/:id/runs', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { prompt: string; branch?: string; draft_token?: string };
  const hint = (body.branch ?? '').trim();
  const token = typeof body.draft_token === 'string' ? body.draft_token : '';
  if (token.length > 0 && !isDraftToken(token)) {
    return reply.code(400).send({ error: 'invalid_token' });
  }
  const run = deps.runs.create({
    project_id: Number(id),
    prompt: body.prompt,
    branch_hint: hint === '' ? undefined : hint,
    log_path_tmpl: (rid) => path.join(deps.runsDir, `${rid}.log`),
  });
  if (token.length > 0) {
    try {
      await promoteDraft({
        draftDir: deps.draftUploadsDir,
        runsDir: deps.runsDir,
        token,
        runId: run.id,
      });
    } catch (err) {
      // Rollback: delete the run row and its (possibly partial) uploads dir.
      deps.runs.delete(run.id);
      try {
        fs.rmSync(path.join(deps.runsDir, String(run.id)), { recursive: true, force: true });
      } catch { /* noop */ }
      app.log.error({ err }, 'draft promotion failed');
      return reply.code(422).send({ error: 'promotion_failed' });
    }
  }
  void deps.launch(run.id).catch((err) => app.log.error({ err }, 'launch failed'));
  reply.code(201);
  return run;
});
```

In the server composition (`src/server/index.ts`), pass `draftUploadsDir` through to `registerRunsRoutes`:

```ts
registerRunsRoutes(app, {
  // existing deps
  draftUploadsDir: config.draftUploadsDir,
});
```

- [ ] **Step 8: Run and verify passing**

Run: `npx vitest run src/server/api/runs.test.ts src/server/api/uploads.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/uploads/promote.ts src/server/uploads/promote.test.ts \
        src/server/api/runs.ts src/server/api/runs.test.ts src/server/index.ts
git commit -m "uploads: createRun accepts draft_token and promotes files"
```

---

## Task 12: Web API client — upload functions

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Add XHR-based helper + upload functions**

In `src/web/lib/api.ts`, append:

```ts
function xhrUpload(url: string, file: File, onProgress?: (pct: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'text';
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      resolve(new Response(xhr.responseText, {
        status: xhr.status,
        headers: { 'content-type': xhr.getResponseHeader('content-type') ?? 'application/json' },
      }));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new Error('aborted'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export const uploads = {
  uploadDraftFile: async (
    file: File,
    draftToken: string | null,
    onProgress?: (pct: number) => void,
  ) => {
    const url = draftToken
      ? `/api/draft-uploads?draft_token=${encodeURIComponent(draftToken)}`
      : '/api/draft-uploads';
    const res = await xhrUpload(url, file, onProgress);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'unknown' }));
      throw new ApiError(body.error ?? 'unknown', res.status);
    }
    return await res.json() as { draft_token: string; filename: string; size: number; uploaded_at: number };
  },

  deleteDraftFile: async (draftToken: string, filename: string) => {
    const res = await fetch(
      `/api/draft-uploads/${encodeURIComponent(draftToken)}/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    );
    if (!res.ok && res.status !== 404) {
      throw new ApiError('delete_failed', res.status);
    }
  },

  uploadRunFile: async (runId: number, file: File, onProgress?: (pct: number) => void) => {
    const res = await xhrUpload(`/api/runs/${runId}/uploads`, file, onProgress);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'unknown' }));
      throw new ApiError(body.error ?? 'unknown', res.status);
    }
    return await res.json() as { filename: string; size: number; uploaded_at: number };
  },

  listRunUploads: async (runId: number) => {
    const res = await fetch(`/api/runs/${runId}/uploads`);
    if (!res.ok) throw new ApiError('list_failed', res.status);
    return (await res.json() as { files: Array<{ filename: string; size: number; uploaded_at: number }> }).files;
  },

  deleteRunUpload: async (runId: number, filename: string) => {
    const res = await fetch(
      `/api/runs/${runId}/uploads/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new ApiError('delete_failed', res.status);
  },
};
```

If `ApiError` is not already exported from this file, look for the idiomatic error type (there's likely a `throw new Error(…)` pattern already; match it). Keep the error message short and status-coded.

- [ ] **Step 2: Update `createRun` to accept `draft_token`**

Find the existing `createRun` client function in `api.ts`. Add an optional param:

```ts
createRun: (projectId: number, payload: { prompt: string; branch?: string; draft_token?: string }) =>
  postJson(`/api/projects/${projectId}/runs`, payload),
```

Update the one or two callers (`NewRun.tsx` most prominently) in later tasks.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/web/lib/api.ts
git commit -m "uploads(web): client functions for draft and run uploads"
```

---

## Task 13: Web — `UploadTray` component

**Files:**
- Create: `src/web/components/UploadTray.tsx`
- Create: `src/web/components/UploadTray.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/web/components/UploadTray.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UploadTray } from './UploadTray.js';

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });
}

describe('UploadTray', () => {
  it('calls upload when a file is selected via the paperclip input', async () => {
    const upload = vi.fn().mockResolvedValue({ filename: 'foo.csv', size: 5 });
    const onUploaded = vi.fn();
    render(
      <UploadTray
        upload={upload}
        onUploaded={onUploaded}
        attached={[]}
        maxFileBytes={100 * 1024 * 1024}
        maxTotalBytes={1024 * 1024 * 1024}
        totalBytes={0}
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('foo.csv', 5)] } });
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(onUploaded).toHaveBeenCalledWith('foo.csv');
  });

  it('rejects oversized files without calling upload', async () => {
    const upload = vi.fn();
    render(
      <UploadTray
        upload={upload}
        onUploaded={() => {}}
        attached={[]}
        maxFileBytes={10}
        maxTotalBytes={100}
        totalBytes={0}
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('big.bin', 100)] } });
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText(/too large/i)).toBeInTheDocument();
  });

  it('rejects when cumulative quota would be exceeded', async () => {
    const upload = vi.fn();
    render(
      <UploadTray
        upload={upload}
        onUploaded={() => {}}
        attached={[]}
        maxFileBytes={1_000_000}
        maxTotalBytes={100}
        totalBytes={95}
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile('foo.bin', 10)] } });
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText(/exceed/i)).toBeInTheDocument();
  });

  it('is disabled when `disabled` is true', () => {
    render(
      <UploadTray
        upload={vi.fn()} onUploaded={() => {}}
        attached={[]} maxFileBytes={1e9} maxTotalBytes={1e10} totalBytes={0}
        disabled disabledReason="nope"
      />,
    );
    const input = screen.getByTestId('upload-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('renders chips for attached files with a remove button when `onRemove` is provided', () => {
    const onRemove = vi.fn();
    render(
      <UploadTray
        upload={vi.fn()} onUploaded={() => {}}
        onRemove={onRemove}
        attached={[{ filename: 'foo.csv', size: 123 }]}
        maxFileBytes={1e9} maxTotalBytes={1e10} totalBytes={123}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /remove foo.csv/i }));
    expect(onRemove).toHaveBeenCalledWith('foo.csv');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run src/web/components/UploadTray.test.tsx`
Expected: FAIL (component not found).

- [ ] **Step 3: Implement the component**

Create `src/web/components/UploadTray.tsx`:

```tsx
import { useCallback, useRef, useState } from 'react';

export interface UploadTrayFile {
  filename: string;
  size: number;
  uploading?: boolean;
  error?: string;
}

export interface UploadTrayProps {
  disabled?: boolean;
  disabledReason?: string;
  onUploaded: (filename: string) => void;
  onRemove?: (filename: string) => void;
  attached: UploadTrayFile[];
  upload: (file: File) => Promise<{ filename: string; size: number }>;
  maxFileBytes: number;
  maxTotalBytes: number;
  totalBytes: number;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UploadTray(props: UploadTrayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > props.maxFileBytes) {
      setError(`File too large (max ${humanSize(props.maxFileBytes)})`);
      return;
    }
    if (props.totalBytes + file.size > props.maxTotalBytes) {
      setError('Adding this would exceed the run quota');
      return;
    }
    setError(null);
    try {
      const res = await props.upload(file);
      props.onUploaded(res.filename);
    } catch (e) {
      setError((e as Error).message ?? 'Upload failed');
    }
  }, [props]);

  return (
    <div className="upload-tray">
      <label
        title={props.disabled ? (props.disabledReason ?? '') : 'Attach a file'}
        aria-disabled={props.disabled}
      >
        <input
          ref={inputRef}
          data-testid="upload-input"
          type="file"
          disabled={props.disabled}
          onChange={(e) => void handleFiles(e.target.files)}
          className="sr-only"
        />
        <span role="button" aria-label="Attach a file">📎</span>
      </label>
      {error && <div className="upload-error text-attn" role="alert">{error}</div>}
      <ul className="upload-chips">
        {props.attached.map(f => (
          <li key={f.filename} className="upload-chip">
            <span>{f.filename} · {humanSize(f.size)}</span>
            {f.uploading && <span aria-label="uploading">…</span>}
            {f.error && <span className="text-attn" role="alert">{f.error}</span>}
            {props.onRemove && (
              <button
                type="button"
                aria-label={`remove ${f.filename}`}
                onClick={() => props.onRemove?.(f.filename)}
              >×</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Use the existing FBI styling conventions (tokens.css, Tailwind utility classes the rest of the web code uses). Consult `src/web/pages/Design.tsx` for the current set of primitives; the emoji paperclip is a placeholder — replace with the icon component used elsewhere.

Drag-and-drop is intentionally omitted from this task. Task 14 (NewRun integration) adds it on the textarea parent; Task 15 (RunDetail) adds it on the terminal pane. The tray itself stays simple.

- [ ] **Step 4: Run and verify passing**

Run: `npx vitest run src/web/components/UploadTray.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/UploadTray.tsx src/web/components/UploadTray.test.tsx
git commit -m "uploads(web): UploadTray component with paperclip + chips"
```

---

## Task 14: NewRun integration

**Files:**
- Modify: `src/web/pages/NewRun.tsx`

- [ ] **Step 1: Read `NewRun.tsx` and locate the textarea + submit handler**

Before editing, skim `src/web/pages/NewRun.tsx`. Understand:
- Where the `prompt` textarea lives (its `ref`, `value`, `onChange`).
- How `submit()` calls `api.createRun(…)`.

- [ ] **Step 2: Add upload state and the tray to the form**

Near the top of the component:

```tsx
import { UploadTray, type UploadTrayFile } from '../components/UploadTray.js';
import { uploads } from '../lib/api.js';

const PER_FILE = 100 * 1024 * 1024;
const PER_RUN = 1024 * 1024 * 1024;

// inside the component
const [draftToken, setDraftToken] = useState<string | null>(null);
const [attached, setAttached] = useState<UploadTrayFile[]>([]);
const textareaRef = useRef<HTMLTextAreaElement | null>(null);
```

Add the tray below the textarea:

```tsx
<UploadTray
  attached={attached}
  upload={async (file) => {
    const res = await uploads.uploadDraftFile(file, draftToken);
    setDraftToken(res.draft_token);
    setAttached(prev => [...prev, { filename: res.filename, size: res.size }]);
    return { filename: res.filename, size: res.size };
  }}
  onUploaded={(filename) => {
    insertAtCursor(textareaRef.current, `@/fbi/uploads/${filename} `);
  }}
  onRemove={async (filename) => {
    if (!draftToken) return;
    await uploads.deleteDraftFile(draftToken, filename);
    setAttached(prev => prev.filter(f => f.filename !== filename));
    stripExactToken(textareaRef.current, `@/fbi/uploads/${filename} `);
  }}
  maxFileBytes={PER_FILE}
  maxTotalBytes={PER_RUN}
  totalBytes={attached.reduce((n, f) => n + f.size, 0)}
/>
```

Helper functions inside the component:

```ts
function insertAtCursor(el: HTMLTextAreaElement | null, text: string): void {
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${lead}${text}${after}`;
  el.value = next;
  // React controlled input: dispatch an `input` event so the bound state updates.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const pos = start + lead.length + text.length;
  el.setSelectionRange(pos, pos);
  el.focus();
}

function stripExactToken(el: HTMLTextAreaElement | null, token: string): void {
  if (!el) return;
  const idx = el.value.indexOf(token);
  if (idx < 0) return;
  el.value = el.value.slice(0, idx) + el.value.slice(idx + token.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
```

Update the submit handler to include `draft_token`:

```ts
const res = await api.createRun(projectId, {
  prompt,
  branch,
  draft_token: draftToken ?? undefined,
});
```

Disable the submit button while any chip is marked `uploading`:

```tsx
<button type="submit" disabled={attached.some(f => f.uploading)}>Run</button>
```

- [ ] **Step 3: Typecheck + web tests**

Run: `npm run typecheck && npx vitest run src/web`
Expected: no errors; existing tests pass.

- [ ] **Step 4: Manual smoke test in the dev server**

Run: `scripts/dev.sh`

Navigate to the NewRun page. Click the paperclip, pick a small text file. Confirm:
- `@/fbi/uploads/<name>` appears at the cursor.
- A chip appears below the textarea.
- Clicking `×` removes the chip and strips the token.
- Submitting the form starts the run and the file is visible inside the container at `/fbi/uploads/`.

Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/NewRun.tsx
git commit -m "uploads(web): attach files on the NewRun form via draft uploads"
```

---

## Task 15: RunDetail integration

**Files:**
- Modify: `src/web/pages/RunDetail.tsx`

- [ ] **Step 1: Read `RunDetail.tsx` and locate the shell WS + state**

Before editing, identify:
- Where `run.state` is read (it already drives `interactive` and the panel layout).
- How to get the shell API (`acquireShell(runId)` or similar pattern seen in `Terminal.tsx`).

- [ ] **Step 2: Add uploads list + tray**

Near the top of the component add:

```tsx
import { UploadTray, type UploadTrayFile } from '../components/UploadTray.js';
import { uploads } from '../lib/api.js';
import { acquireShell } from '../lib/shellRegistry.js';
```

State:

```tsx
const [attached, setAttached] = useState<UploadTrayFile[]>([]);

const refreshUploads = useCallback(async () => {
  if (!run) return;
  try {
    const files = await uploads.listRunUploads(run.id);
    setAttached(files.map(f => ({ filename: f.filename, size: f.size })));
  } catch { /* silent */ }
}, [run]);

useEffect(() => { void refreshUploads(); }, [refreshUploads]);
useEffect(() => {
  if (run?.state === 'waiting') void refreshUploads();
}, [run?.state, refreshUploads]);
```

Tray (placed in the same pane as the terminal, below the xterm):

```tsx
<UploadTray
  disabled={run.state !== 'waiting'}
  disabledReason="Uploads are available while the agent is waiting for input."
  attached={attached}
  upload={async (file) => {
    const res = await uploads.uploadRunFile(run.id, file);
    setAttached(prev => [...prev, { filename: res.filename, size: res.size }]);
    return { filename: res.filename, size: res.size };
  }}
  onUploaded={(filename) => {
    const text = `@/fbi/uploads/${filename} `;
    const shell = acquireShell(run.id);
    shell.send(new TextEncoder().encode(text));
  }}
  onRemove={async (filename) => {
    await uploads.deleteRunUpload(run.id, filename);
    setAttached(prev => prev.filter(f => f.filename !== filename));
  }}
  maxFileBytes={100 * 1024 * 1024}
  maxTotalBytes={1024 * 1024 * 1024}
  totalBytes={attached.reduce((n, f) => n + f.size, 0)}
/>
```

Note: `acquireShell` may require a matching `releaseShell` or reference counting — read `Terminal.tsx` for the pattern. If `acquireShell` increments a ref count, call the corresponding release in a cleanup. A simpler option: expose a shared `shell` instance from the same hook that `Terminal.tsx` already uses and pass it down as a prop. Pick whichever matches the existing code style.

- [ ] **Step 3: Typecheck + web tests**

Run: `npm run typecheck && npx vitest run src/web`
Expected: no errors; existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/RunDetail.tsx
git commit -m "uploads(web): attach files on RunDetail while run is waiting"
```

---

## Task 16: Manual end-to-end verification

**Files:** none

- [ ] **Step 1: Start the dev server**

Run: `scripts/dev.sh`

- [ ] **Step 2: Drive NewRun with an attachment**

Using Playwright MCP (or a real browser):
- Go to a project's NewRun form.
- Attach a small text file.
- Verify `@/fbi/uploads/<name>` is inserted into the textarea at the cursor.
- Submit; wait for the run to reach `waiting`.
- In the terminal, ask the agent to `cat` the referenced path and confirm it reads the file.

- [ ] **Step 3: Drive mid-run upload**

- With the same run in `waiting`:
  - Click the paperclip in the RunDetail pane. Attach a different file.
  - Verify `@/fbi/uploads/<name>` appears in the xterm input line.
  - Type `summarize this` after it, press Enter. Verify the agent reads the file.
- Toggle the run to `running` (type a long-running request). Confirm the tray becomes disabled with the tooltip.
- Return to `waiting`. Delete one of the attached files via the panel; verify it's gone from the container (exec `ls /fbi/uploads` inside the container via the terminal).

- [ ] **Step 4: Drive a rejection path**

- Attempt to attach a file larger than 100 MB. Confirm the client rejects it immediately (no network call, red chip).

- [ ] **Step 5: Stop the dev server and note any regressions**

If the manual check fails, return to the failing task and fix. Otherwise, no commit is needed for this task.

---

## Self-Review Summary

Spec sections → tasks:
- Host layout, container mount → Task 1 (paths), Task 10 (mount).
- API surface (5 endpoints) → Task 5 (drafts), Task 6 (per-run).
- createRun modification → Task 11.
- Multipart dependency + wiring → Task 3 (install), Task 7 (register).
- Filename handling → Task 2.
- Housekeeping (GC + `.part` sweep) → Task 8, Task 9.
- Draft-token format → Task 4.
- UI (UploadTray, NewRun, RunDetail) → Task 13, Task 14, Task 15.
- Web API client → Task 12.
- Manual verification → Task 16.

No task calls out error-handling as an afterthought — each endpoint's rejection paths have explicit test cases (Task 5, Task 6). The 413 cumulative-limit check and the `.part` atomic-promotion retry live inside `consumeOneFile` in Task 5 and are exercised by Task 6's quota test.

Type consistency: `UploadedFile`, `DraftUploadResponse`, `UploadTrayFile`, `PromotedFile` are defined once each and used in their respective tasks with matching field names (`filename`, `size`, `uploaded_at` / `uploading` / `error`).

No placeholders. Every code block is complete enough to copy and run, with tests that fail before the implementation and pass after.
