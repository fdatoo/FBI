# Agent-run file uploads

Let users attach files to an agent run and reference them from the
composer. Files land at `/fbi/uploads/<filename>` inside the container
(read-only bind mount); the composer inserts a literal absolute-path
reference `@/fbi/uploads/<filename>` into the pending draft so the agent
reads the file when the user submits their next message.

Uploads are allowed only while the run is in a state where the composer
would be valid to submit: on the `NewRun` form (run not yet created), and
on `RunDetail` when `run.state === 'waiting'`.

## Why

FBI runs today are text-in, text-out: the only way to get context into an
agent is to type it or reference something already in the repo. Users
frequently want to hand the agent a CSV, a PDF, a screenshot, or a log
file they captured elsewhere. Doing this by pasting into the TUI is
impractical (size, binary data) and shelling out to copy files into the
mount dir is an escape hatch, not a feature.

This feature makes file attachments first-class, with a minimal surface:
a single per-run directory, a symmetric upload affordance on NewRun and
the mid-run composer, and a conventional `@path` reference inserted into
the user's draft.

## Scope

In scope:
- Host path `runs/<run-id>/uploads/` bind-mounted read-only into the
  container at `/fbi/uploads/`.
- New REST endpoints for draft uploads (pre-run) and per-run uploads
  (mid-run).
- `@fastify/multipart` dependency for multipart request parsing.
- UI: an `UploadTray` component with a paperclip button and drag-and-drop
  target, used by both `NewRun.tsx` and `RunDetail.tsx`.
- Insertion of `@/fbi/uploads/<filename>` at the textarea cursor (NewRun)
  or into the shell WS byte stream (RunDetail) on successful upload.
- Filename collision rule and server-side size enforcement.
- Draft-upload garbage collection.

Out of scope:
- Changes to how Claude is launched or how prompts are injected at
  startup.
- A new DB table for upload metadata. The filesystem is the source of
  truth; if per-file metadata becomes necessary later, a table can be
  added without breaking the API shape.
- Object storage, multi-machine deployment, or uploader attribution
  (FBI is single-user).
- MIME-type filtering or file-type-aware previews. The agent decides
  what to do with whatever bytes arrive.
- A CLI surface for uploads. Web-only for now.
- Compression, virus scanning, or de-duplication.
- Writeable mounts. The agent must not be able to mutate source files
  the user uploaded.

## Constraints

- **Single Fastify process**, no worker pool. Multipart writes are
  streamed to disk (not buffered in memory) so a 100 MB upload does not
  spike RSS.
- **Per-file limit 100 MB, per-run cumulative limit 1 GB, no file-count
  cap.** Enforced server-side; surfaced client-side as an immediate
  rejection before the upload begins.
- **Read-only container mount.** The agent cannot modify, rename, or
  delete uploaded files. (Delete is a server operation via the
  `DELETE /api/runs/:id/uploads/:filename` endpoint.)
- **No new DB schema.** Directory listings are authoritative.

## Host layout

```
/var/lib/agent-manager/
  runs/<run-id>/
    claude-projects/       # workspace (existing)
    state/                 # existing
    uploads/               # NEW — bind-mounted RO to /fbi/uploads/
      foo.csv
      bar.png
  draft-uploads/           # NEW — holds pre-run uploads
    <draft-token>/
      prompt.pdf
```

`draft-uploads/` is flat; each `<draft-token>` subdirectory owns whatever
the user attaches before submitting the NewRun form. On submit, its
contents are moved into the new run's `uploads/` directory.

## Container layout

Launch args (Docker bind mounts) add one line to the existing set:

```
-v <host>/runs/<id>/uploads:/fbi/uploads:ro
```

The mount is created on every container launch for the run — `launch`,
`continueRun`, `resume`. If `runs/<id>/uploads/` does not yet exist on
the host, the orchestrator creates it empty before starting the
container. The directory existence invariant keeps the bind mount
well-defined even for runs that never had an upload.

## API surface

### New endpoints

| Method | Path | Body | Response | Notes |
|---|---|---|---|---|
| `POST` | `/api/draft-uploads` | `multipart/form-data` with one `file` field; optional `draft_token` query parameter to append to an existing draft | `{ draft_token, filename, size, uploaded_at }` | Creates a new `draft_token` if none supplied. One file per request. |
| `DELETE` | `/api/draft-uploads/:token/:filename` | — | `204` | Removes a file the user un-attached before submit. `404` if token or filename unknown. |
| `POST` | `/api/runs/:id/uploads` | `multipart/form-data` with one `file` field | `{ filename, size, uploaded_at }` | `409` unless `run.state === 'waiting'`. One file per request. |
| `GET` | `/api/runs/:id/uploads` | — | `{ files: [{ filename, size, uploaded_at }] }` | Lists all files currently in the run's `uploads/` dir. Cheap directory read; no auth beyond existing API access. |
| `DELETE` | `/api/runs/:id/uploads/:filename` | — | `204` | Only allowed while `state === 'waiting'`. Deletes the host file; the read-only mount reflects the removal immediately. |

### Modified endpoint

- **`POST /api/projects/:id/runs`** (create run): body gains an optional
  `draft_token: string` field. When present and non-empty, the server:
  1. Creates the run row as today.
  2. Creates `runs/<new-id>/uploads/`.
  3. Atomically renames each file from `draft-uploads/<token>/` into
     `runs/<new-id>/uploads/`, applying the same collision rule used on
     mid-run upload.
  4. Removes the now-empty `draft-uploads/<token>/` directory.
  5. Starts the container.
  Failure during step 3 rolls back by deleting the partially-populated
  `runs/<new-id>/uploads/` and returns `422`. The run row is also rolled
  back (deleted) — a run with a broken upload state is worse than no run.

### Multipart configuration

Add dependency: `@fastify/multipart` (pinned to a version compatible
with the current Fastify major). Register globally with:

```ts
fastify.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MiB
    files: 1,
    fields: 2,                    // for future use (notes, etc.)
  },
});
```

The per-run 1 GiB cumulative limit is enforced in the handler by
`statSum(uploadsDir)` before accepting the write. If a stream exceeds
the per-file limit mid-write, the handler aborts, deletes the partial
file, and returns `413`.

Uploads are written to `<filename>.part` first, then renamed to the
final filename on successful completion. At server startup, a sweep
deletes any stale `*.part` files under `runs/*/uploads/` and
`draft-uploads/*/`.

## Filename handling

### Validation

- Reject if the incoming filename contains any of `/`, `\`, `\0`.
- Reject if it is exactly `.` or `..`, or starts with `..`.
- Reject if its length exceeds 255 bytes after UTF-8 encoding.
- Reject empty filenames.
- Allowed: leading dots (e.g., `.env` is a legitimate upload); Unicode;
  spaces.

All rejections return `400` with `{ error: 'invalid_filename' }`.

### Collision rule

If the sanitized filename already exists in the target directory, append
a numeric suffix before the final extension: `foo.csv` → `foo (1).csv` →
`foo (2).csv`. If there is no extension, append at the end:
`Makefile` → `Makefile (1)`. Server returns the **final, post-collision
filename** in the response; the UI inserts that name into the draft.

Rationale: overwrite silently breaks earlier references in the
transcript (an older `@/fbi/uploads/foo.csv` would now point at
different bytes), and rejecting is annoying for the common case of a
user redoing a selection.

### Absolute-path reference

The reference inserted by the UI is always the **post-collision
absolute path**: `@/fbi/uploads/<final-filename>`. The leading `@`
triggers Claude Code's file-reference handling; the absolute path
removes any dependency on the agent remembering where uploads live.

## UI

### `UploadTray` component

New shared component at `src/web/components/UploadTray.tsx`. Props:

```ts
interface UploadTrayProps {
  disabled?: boolean;
  disabledReason?: string;            // tooltip when disabled
  onUploaded: (filename: string) => void;     // final, post-collision
  onRemove?: (filename: string) => void;      // null if remove not supported
  attached: Array<{ filename: string; size: number; uploading?: boolean; error?: string }>;
  upload: (file: File) => Promise<{ filename: string; size: number }>;
  maxFileBytes: number;               // 100 MiB
  maxTotalBytes: number;              // 1 GiB
  totalBytes: number;                 // current sum across `attached`
}
```

Visuals:
- A paperclip button at the bottom-left of the composer's container.
- A drop target overlay that appears on the parent (textarea or xterm
  container) when `dataTransfer.types.includes('Files')` during a drag.
- Chips below the composer, one per `attached` entry, showing the
  filename, human-readable size, a remove `×` (if `onRemove`), and a
  spinner or red error badge when `uploading` or `error` is set.

Progress is wired via `XMLHttpRequest` (not `fetch`) so
`xhr.upload.onprogress` can drive a per-chip progress bar during
transfer. Large files will otherwise look frozen. This is a
deliberate, localized deviation from `src/web/lib/api.ts`'s
fetch-based convention — the upload functions wrap XHR but expose a
promise-returning API indistinguishable from the other client
functions.

### `NewRun.tsx`

- Mount `UploadTray` below the prompt textarea.
- Hold local state:
  ```ts
  const [draftToken, setDraftToken] = useState<string | null>(null);
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  ```
- On first upload, `draftToken` is assigned from the server response
  and reused for subsequent uploads in the same form session.
- `upload(file)` POSTs to `/api/draft-uploads?draft_token=<token>`. On
  resolve, insert `@/fbi/uploads/<final-filename>` at the current
  textarea selection, with a leading space if the cursor is at a
  non-whitespace boundary. Focus returns to the textarea.
- `onRemove(filename)` DELETEs the file server-side; on success, strips
  the matching `@/fbi/uploads/<filename>` token from the textarea
  **only if** still exactly present (we do not attempt to edit a
  reference the user has modified or interleaved with other text).
- Form submit: if `draftToken` is set and any files are attached,
  include it as `draft_token` in the existing createRun JSON body.
  Disable the submit button while any chip is `uploading`.
- If the user navigates away with attached files, the draft token and
  its files remain server-side until the GC sweep.

### `RunDetail.tsx`

- Mount `UploadTray` adjacent to the xterm, inside the same pane so the
  drop target aligns with the terminal.
- Enabled only when `run.state === 'waiting'`; otherwise greyed with
  tooltip: *"Uploads are available while the agent is waiting for
  input."*
- `upload(file)` POSTs to `/api/runs/:id/uploads`. On resolve, write
  the literal bytes `@/fbi/uploads/<final-filename> ` into the shell
  WS:
  ```ts
  shell.send(new TextEncoder().encode('@/fbi/uploads/' + finalFilename + ' '));
  ```
  Claude Code's input buffer displays the characters as if typed; the
  user continues composing and presses Enter when ready. The xterm
  retains focus.
- An "Attached files" disclosure (default collapsed) fed by
  `GET /api/runs/:id/uploads`, reloaded on:
  - Mount
  - After a successful upload
  - After a successful delete
  - On every WS `state` frame whose `state === 'waiting'` (covers the
    common case of a user coming back to a run that has accumulated
    files in another session).
- Delete buttons in the disclosure are enabled only while
  `state === 'waiting'`.

### Client-side limits

- Reject `file.size > 100 MiB` before starting the upload (red error
  chip, no network call).
- Reject when `totalBytes + file.size > 1 GiB` (same).
- Server enforces the same limits authoritatively; client check is UX.

### Keyboard

No new keybinding in v1. The paperclip button is a standard focusable
button; drag-and-drop covers the power-user path. A `⌘⇧A` binding can
be added in a follow-up if desired.

## Server-side changes

### New file: `src/server/api/uploads.ts`

Houses all five new endpoints. Pure I/O: validate, write, respond. No
orchestrator coupling except reading `runs.state` through the existing
`RunsRepo`.

Shared helpers:

```ts
// Sanitize + collision-resolve a filename against an existing directory.
// Returns the final on-disk name.
export function resolveFilename(dir: string, incoming: string): string;

// Sum file sizes in a directory (non-recursive, ignores .part).
export function directoryBytes(dir: string): Promise<number>;
```

Both also used by the createRun handler when promoting a draft.

### Draft-upload GC

New module: `src/server/housekeeping/draftUploads.ts`. Exports:

```ts
export function sweepDraftUploads(draftDir: string, now: number): Promise<void>;
export function sweepPartFiles(runsDir: string, draftDir: string): Promise<void>;
export function startDraftUploadsGc(opts: { draftDir; runsDir; intervalMs?: number }): () => void;
```

`startDraftUploadsGc` is called once from the top-level server
composition (`src/server/index.ts`). It:
1. Runs both sweeps once at startup.
2. Sets a 1 h interval that runs `sweepDraftUploads`.
3. Returns a stop function for tests.

`sweepDraftUploads` enumerates `draft-uploads/*/` and, for each,
recursively deletes the directory if `mtimeMs < now - 24h`.

### Draft-token format

`draft_token` is a server-generated opaque string: 16 bytes from
`crypto.randomBytes` encoded as lowercase hex (32 chars). Tokens are
never reused. The client treats them as opaque.

### Bind-mount wiring

`src/server/orchestrator/index.ts`: wherever the existing mount list is
constructed for `launch` / `continueRun` / `resume`, add:

```ts
{ source: path.join(runsDir, String(runId), 'uploads'),
  target: '/fbi/uploads',
  readOnly: true }
```

Before container start, `mkdir -p` the host directory. The mount is
unconditionally added; an empty `uploads/` is fine.

### createRun promotion

`src/server/api/runs.ts` (create handler): after the run row is
created, if `body.draft_token` is set and non-empty, call
`promoteDraft(token, newRunId)`:

```ts
async function promoteDraft(token: string, runId: number): Promise<void> {
  const src = path.join(draftUploadsDir, token);
  const dst = path.join(runsDir, String(runId), 'uploads');
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src);
  for (const name of entries) {
    const finalName = resolveFilename(dst, name);
    await fs.rename(path.join(src, name), path.join(dst, finalName));
  }
  await fs.rmdir(src).catch(() => {});
}
```

If promotion throws, the handler deletes `runs/<newRunId>/uploads/`,
deletes the run row, and returns `422 { error: 'promotion_failed' }`.

### Run-log marker

On every successful upload (draft or per-run), append a one-line marker
to the run log once the run exists, consistent with the waiting-state
design's transcript convention:

```
[fbi] user uploaded foo.csv (12.3 KB)
```

For draft uploads, the marker is emitted at the moment of promotion,
listing all promoted files in order.

### Run deletion

`DELETE /api/runs/:id` already deletes `runs/<id>/` on disk. No change
needed — `uploads/` is a subdirectory of the run's directory tree and
rides along.

## Data flow summaries

### NewRun with a file

```
User picks foo.csv
  → POST /api/draft-uploads (multipart, foo.csv)
  → server creates draft-uploads/<token>/, writes foo.csv.part → foo.csv
  → returns { draft_token, filename: 'foo.csv', size, uploaded_at }
UI: inserts '@/fbi/uploads/foo.csv ' at textarea cursor; renders chip
User types rest of prompt, clicks Submit
  → POST /api/projects/:id/runs { prompt, draft_token }
  → server creates run row, promotes draft to runs/<id>/uploads/, starts
    container (bind-mounting uploads/ RO at /fbi/uploads/)
  → agent receives prompt containing @/fbi/uploads/foo.csv; reads file
```

### Mid-run with a file

```
run.state === 'waiting'
User drops bar.png into the terminal pane
  → POST /api/runs/:id/uploads (multipart, bar.png)
  → server verifies state==='waiting', writes to runs/<id>/uploads/
  → returns { filename: 'bar.png', size, uploaded_at }
UI: writes '@/fbi/uploads/bar.png ' into the shell WS byte stream
Claude Code's input buffer shows '@/fbi/uploads/bar.png '
User types "summarize this image" and presses Enter
  → agent receives the full line, reads the file
```

## Error handling

Server responses are `{ error: string }` with appropriate status codes.
Client maps each to a user-visible message on the chip.

| Condition | Status | Body | UI behavior |
|---|---|---|---|
| Per-file limit exceeded | `413` | `{ error: 'file_too_large' }` | Red chip: "File too large (max 100 MB)" |
| Cumulative limit exceeded | `413` | `{ error: 'run_quota_exceeded' }` | Red chip: "Adding this would exceed the 1 GB run total" |
| Invalid filename | `400` | `{ error: 'invalid_filename' }` | Red chip: "Invalid filename" |
| Run not in `waiting` | `409` | `{ error: 'wrong_state' }` | Chip removed; tooltip re-appears on tray |
| Unknown run / token | `404` | `{ error: 'not_found' }` | Chip removed; toast error |
| Disk full or rename fails | `500` | `{ error: 'io_error' }` | Red chip: "Upload failed, please retry" |
| Promotion fails (createRun) | `422` | `{ error: 'promotion_failed' }` | Form-level banner: "Failed to attach files. The run was not created." Attached chips remain; user can retry. |

Aborted or timed-out uploads leave a `.part` file that is swept at
server startup. In-flight aborts (user closes the tab) delete the
`.part` via `xhr.abort()` → server's `onClose` handler if available,
otherwise cleaned up by the startup sweep.

## Concurrency

All file operations are single-writer-per-path and bounded by the
single Fastify process. No cross-request races on the same filename
because each upload finalizes its own `.part` → final rename atomically
within one handler call.

The only cross-flow concern is simultaneous uploads into the same
directory racing on collision resolution: `resolveFilename` reads the
directory, picks a suffix, and then the rename happens. Two concurrent
uploads of `foo.csv` could both pick `foo (1).csv`. Mitigation: the
final promotion uses `fs.link(src, dst)` (fails with `EEXIST` if `dst`
already exists — POSIX `rename` would silently overwrite) followed by
`fs.unlink(src)`. On `EEXIST`, call `resolveFilename` again and retry.
Three retries max before returning `500`.

This is unlikely in practice (humans don't upload two files in the
same tenth of a second) but the retry is cheap.

## Testing

### Server

- `src/server/api/uploads.test.ts` (new):
  - `POST /api/draft-uploads` creates a new token when none is supplied
    and appends when one is supplied.
  - `POST /api/runs/:id/uploads` returns `409` when state is `running`,
    `queued`, `awaiting_resume`, `succeeded`, `failed`, `cancelled`;
    succeeds when `waiting`.
  - Collision rule: uploading `foo.csv` twice yields `foo.csv` and
    `foo (1).csv`; the response's `filename` matches the on-disk name.
  - Invalid filenames (`../etc`, `foo/bar`, empty, null byte) return
    `400`.
  - Per-file limit: a 101 MB payload returns `413` with
    `file_too_large` and leaves no file on disk.
  - Cumulative limit: uploading past 1 GiB returns `413` with
    `run_quota_exceeded`; existing files are preserved.
  - `GET /api/runs/:id/uploads` lists what's on disk in deterministic
    order (alphabetical).
  - `DELETE /api/runs/:id/uploads/:filename` removes the file; `409`
    when not in `waiting`.
  - Startup sweep deletes stale `.part` files and expired
    `draft-uploads/<token>/` directories.

- `src/server/api/runs.test.ts` (extend):
  - createRun with a `draft_token` promotes files into the run's
    `uploads/` directory and deletes the draft directory.
  - createRun with an unknown `draft_token` returns `422` and rolls
    back the run row (no orphan runs).
  - Promotion respects the same collision rule (if the run already has
    a file with the same name — defensive; shouldn't happen in
    practice since the run is brand new).

- `src/server/orchestrator/index.test.ts` (extend):
  - `launch`, `continueRun`, `resume` all include the uploads bind
    mount in their container args.
  - `launch` creates `runs/<id>/uploads/` if it does not exist.

- `src/server/housekeeping/draftUploads.test.ts` (new):
  - `sweepDraftUploads` deletes directories older than 24 h and
    leaves younger ones alone.
  - `sweepPartFiles` deletes stale `.part` files under both
    `runs/*/uploads/` and `draft-uploads/*/`.

### Web

- `src/web/components/UploadTray.test.tsx` (new):
  - Paperclip click opens the native file picker.
  - Drop target appears on drag-enter when `Files` is in
    `dataTransfer.types`; drop triggers `upload`.
  - Chip lifecycle: uploading → finished → removable.
  - Client-side rejection paths (per-file, cumulative) do not fire a
    network call.
  - Progress bar updates on `upload.onprogress` events (mocked XHR).
- `src/web/pages/NewRun.test.tsx` (extend):
  - Uploading a file inserts `@/fbi/uploads/<name>` at the cursor,
    preserving surrounding text.
  - Remove click strips the reference only when the exact token still
    appears in the textarea.
  - Submit includes `draft_token` in the POST body; submit is disabled
    while an upload is in flight.
- `src/web/pages/RunDetail.test.tsx` (new or extend):
  - Tray is disabled when `run.state !== 'waiting'` and shows the
    tooltip.
  - Successful upload sends the absolute-path reference as bytes over
    the shell WS.
  - Attached-files panel reloads on WS state → `waiting` frames.

### Manual UI check

Per FBI convention, start the dev server and drive a real run in a
browser (Playwright MCP or manual):

- On NewRun: attach a small text file, see `@/fbi/uploads/foo.txt`
  appear in the textarea, submit, observe the agent read the file.
- On an active run: wait for `waiting`, drag a file onto the terminal,
  see the absolute-path reference appear in the input line, type a
  prompt, submit, observe the agent read the file.
- Remove a file in both contexts; verify the reference token is
  stripped from NewRun and the file disappears from the attached-files
  panel.
- Attempt an oversized file; confirm rejection before any network
  traffic.
- Attach files, close the tab without submitting; after 24 h (or by
  forcing the sweep), confirm GC reclaims them.

## Files touched (summary)

Server:
- `src/server/api/uploads.ts` — new; five endpoints + helpers.
- `src/server/api/runs.ts` — accept `draft_token` in create handler;
  promote on success; roll back on failure.
- `src/server/orchestrator/index.ts` — add uploads bind mount to the
  three launch paths; `mkdir -p uploads/` pre-start.
- `src/server/housekeeping/draftUploads.ts` — new; hourly sweep;
  startup sweep of `.part` files.
- `src/server/housekeeping/draftUploads.test.ts` — new.
- `src/server/index.ts` (or wherever Fastify is composed) — register
  `@fastify/multipart`; mount `uploads` router; start GC interval.
- `src/shared/types.ts` — types for upload API responses.
- `package.json` — add `@fastify/multipart`.

Web:
- `src/web/components/UploadTray.tsx` — new shared tray component.
- `src/web/components/UploadTray.test.tsx` — new.
- `src/web/pages/NewRun.tsx` — mount tray; manage `draftToken`; insert
  references at cursor; include `draft_token` in submit.
- `src/web/pages/RunDetail.tsx` — mount tray (gated on `waiting`);
  write reference bytes into shell WS; attached-files disclosure.
- `src/web/lib/api.ts` — new client functions: `uploadDraftFile`,
  `deleteDraftFile`, `uploadRunFile`, `listRunUploads`,
  `deleteRunUpload`; modify `createRun` to pass `draft_token`.
- Tests per above list.
