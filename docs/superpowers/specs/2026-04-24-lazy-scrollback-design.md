# Lazy scrollback terminal — design

## Problem

Today the run terminal has two separate views:

1. **Live xterm** — hooked to the WS byte stream; xterm's built-in ~1000-line
   scrollback is the only "history" available.
2. **"Load full history" overlay** — a second xterm, created on demand, which
   fetches the *entire* transcript file via `GET /api/runs/:id/transcript`,
   writes it in 1 MB chunks, and overlays the live xterm. Dismissed with a
   **Resume live** button.

This is jarring in two ways:

- For a long run the full-history fetch is large (tens of MB) and the user
  pays for all of it even if they only want to look back a screenful.
- The two-view toggle forces the user to pick *mode*: "I want to read
  history" or "I want to watch live." There's no middle ground where you
  scroll up to read, then scroll back to continue watching.

## Goal

One continuous scroll surface. The user scrolls up to view older scrollback,
which loads lazily in chunks. While scrolled up, the live stream is paused.
Returning to the bottom — by click or by scroll — snaps back to live.

## Non-goals

- Search across unloaded history. Use browser find-in-page within loaded
  scrollback; real full-text search is a separate feature.
- Memory cap / eviction. v1 has no cap.
- Jump-to-start keybinding.
- Semantic/JSONL rendering of history (explicitly rejected in
  `2026-04-23-terminal-robust-redesign-design.md`).
- Multi-user cursor / shared selection.
- Changes to resize/fit/visibility handling in `Terminal.tsx`.
- Changes to the dim handshake or `ready` gating.

## Summary of decisions

| Question | Choice |
|---|---|
| Starting state | Pre-seed last **512 KB** of transcript into scrollback on mount |
| New bytes during pause | Drop them; on resume request a fresh snapshot |
| Display model | One xterm, rebuilt on chunk load |
| Pause trigger | Any scroll-up from the bottom |
| Return-to-live | Click `[Resume stream]` **or** scroll to bottom (auto) |
| Chunk prefetch | Near-top (~100 lines from current `baseY === 0`) |
| Chunk size | Fixed **512 KB** byte range, server does file-ranged read |
| Existing "Load full history" button | Remove |
| Memory cap | None in v1 |

## User-visible behavior

**Mount.** The live xterm mounts as today. The initial `snapshot` event is
written to xterm (unchanged). Immediately after, the controller pre-seeds
scrollback by fetching the last 512 KB of the transcript with a `Range`
request, then rebuilds the xterm buffer with `[seed bytes][snapshot]`. The
user sees the live screen at the bottom plus some already-loaded history
above it — they can scroll up several screens before any network load is
needed.

**Idle live.** Identical to today. Viewport pinned to bottom; WS bytes
render live; xterm scrollback fills.

**Paused.** The moment the user scrolls even one line above the bottom:

- A thin banner appears at the top: `⏸ Stream paused — you're viewing history. [Resume stream]`
- Incoming WS bytes are dropped on the client (we still receive them; we
  just don't write to xterm).
- Typing input is blocked (`effectiveInteractive = interactive && !paused`).
- Selection/copy/find still work.

**Lazy chunk loading.** When the user scrolls within ~100 lines of the top
of the currently-loaded buffer (`buffer.active.baseY === 0` is the true
top; "near-top" means `viewportY < 100`), a background fetch of the next
512 KB of older transcript fires (prefetch). When it lands, rebuild:

1. Snapshot current scroll position: `previousTopLine = viewportY`.
2. Build a fresh `Xterm`. Write `[new chunk][existing loaded bytes]` into
   it. The existing loaded bytes are kept in a client-side `loadedBytes:
   Uint8Array` buffer in the controller, so this rebuild doesn't need to
   re-request anything we already have.
3. Replace the DOM node (swap xterm instance).
4. Count added lines (`addedLines = newBaseY - oldBaseY`) and restore
   scroll: `term.scrollToLine(previousTopLine + addedLines)`.
5. Update `loadedRange.startOffset`. If it's now 0, render a one-time
   `─── start of run ───` styled marker at the top.

If the user actually reaches the top before the prefetch completes, a
top-strip `Loading older history…` is shown; otherwise the prefetch is
invisible.

**Returning to live.** Two equivalent paths:

- Click `[Resume stream]` in the banner, OR
- Scroll all the way to the bottom of the current buffer.

Either way: dismiss banner → send `request_snapshot` WS message → on
receiving the fresh `snapshot` event, write its ANSI into xterm (which
repaints the main-screen region; scrollback above is preserved) →
`scheduleCursorRedraw()` (the existing SIGWINCH nudge that triggers a
Claude repaint carrying the cursor cell) → flip `paused = false` → restore
interactive state → `term.scrollToBottom()` → byte-drop gate opens, WS
bytes resume rendering.

**Loading indicators.**

- During the pre-seed at mount: reuse the existing **"Loading terminal…"**
  overlay (unchanged).
- During a chunk fetch *only if the user has reached the true top before
  the fetch completes*: thin top-strip **"Loading older history…"**.
- On chunk-load failure: top-strip **"Failed to load older history · [Retry]"**.

## Architecture

### Client

`src/web/lib/terminalController.ts` is the state owner. The changes:

New state:

```ts
private pauseState: { paused: boolean };
private loadedRange: { startOffset: number; endOffset: number };  // byte offsets into transcript
private liveOffset: number;                                       // running cursor into transcript
private loadedBytes: Uint8Array;                                  // bytes currently written into xterm's scrollback region
private pendingChunk: { abort: AbortController } | null;
private pauseListeners: Set<(p: boolean) => void>;
```

New methods:

- `seedInitialHistory(): Promise<void>` — fetches last 512 KB, rebuilds
  xterm with seed+snapshot, sets `loadedRange` and `loadedBytes`.
- `pause(): void` — sets `pauseState.paused = true`, emits event,
  `setInteractive(false)`-equivalent gating.
- `resume(): void` — requests fresh snapshot (or tail fetch for finished
  runs), re-enables live byte writes, `scrollToBottom()`, emits event.
- `loadOlderChunk(): Promise<void>` — guarded by `pendingChunk` and
  `loadedRange.startOffset > 0`; fires `Range` request for
  `[max(0, start-512KB), start-1]`; on success, rebuilds xterm.
- `rebuildXtermFromBytes(bytes: Uint8Array): void` — builds fresh `Xterm`,
  writes bytes, swaps DOM node. Atomic: old xterm remains mounted if
  writes throw.
- `onScroll({ atBottom, nearTop }): void` — called by `Terminal.tsx` on
  xterm scroll events.
- `onPauseChange(cb): () => void` — subscription API for React component.

Removed:

- `enterHistory()`, `resumeLive()`, the `historyTerm` field, `historyAborted`.

`src/web/components/Terminal.tsx` thins out:

- Removes `historyMode` state, `historyHostRef`, the `Load full history`
  button, the separate `historyTerm` overlay div.
- Adds a `paused` state subscribed from the controller.
- Adds a banner rendered when `paused === true`.
- Wires `term.onScroll(() => controller.onScroll(scrollDetection(term)))`.

`src/web/lib/scrollDetection.ts` (new):

```ts
export function detectScroll(term: Xterm): {
  atBottom: boolean;
  nearTop: boolean;
  viewportTopLine: number;
};
```

Pure function over `term.buffer.active.viewportY`, `baseY`, `term.rows`.
Threshold for `nearTop`: `viewportY < 100`.

### Server

`src/server/api/runs.ts` — extend `GET /api/runs/:id/transcript`:

- If `Range: bytes=<start>-<end>` header present → `206 Partial Content`
  with `Content-Range: bytes <start>-<end>/<total>` and the byte range.
- Otherwise → `200 OK` with full body (unchanged behavior).
- Always set `X-Transcript-Total: <total>` so the client can size its
  offset bookkeeping without a separate HEAD.

`src/server/logs/store.ts` — add two static helpers:

```ts
static readRange(filePath: string, start: number, end: number): Uint8Array;
static byteSize(filePath: string): number;
```

`readRange` uses `fs.openSync` + `fs.readSync` with a single read into a
buffer sized to the range; clamps to file size; returns empty for missing
file (consistent with `readAll`).

### WS snapshot-on-demand

Add one client→server message: `{ type: "request_snapshot" }`.

Server handler: calls the same screen-state serialization already used on
WS connect/reconnect and emits a `snapshot` event over the WS (identical
shape to today). Client's existing `onSnapshot` handler writes it. This is
a minimal protocol extension — reuses the existing snapshot code path.

For finished runs (no live screen-state), `resume()` instead fires a plain
`GET /transcript Range: bytes=<liveOffset>-<total>` and writes the tail
into xterm. Branch:

```ts
if (runState === 'finished') await fetchAndWriteTail();
else sendRequestSnapshot();
```

## Data flow

### A. Mount

1. Component mounts. `TerminalController` constructed (unchanged).
2. Controller subscribes to WS; WS opens; server sends initial `snapshot`
   event. Handler writes ANSI to xterm (unchanged). `liveOffset` is set
   from `X-Transcript-Total` on the first transcript fetch (step 4).
3. Controller kicks off `seedInitialHistory()`:
   `GET /transcript Range: bytes=<max(0, total-524288)>-<total-1>`.
4. Rebuild xterm: write `[seed bytes][snapshot bytes]`, swap DOM node.
   `loadedRange = { startOffset: max(0, total-524288), endOffset: total }`;
   `liveOffset = total`.
5. Subsequent WS bytes append to xterm and bump `liveOffset`.

### B. Scroll up → paused

1. xterm emits `onScroll`; `detectScroll` returns `atBottom: false`.
2. Controller calls `pause()`: `pauseState.paused = true`, listeners fire
   → banner appears; `setInteractive(false)` via the effective gate.
3. The `onBytes` handler's first guard (`if (paused) return`) drops
   incoming WS bytes.

### C. Chunk prefetch while paused

1. User keeps scrolling up; `detectScroll` reports `nearTop: true`.
2. Controller calls `loadOlderChunk()`:
   - If `loadedRange.startOffset === 0` → no-op.
   - If `pendingChunk !== null` → no-op (dedupe).
   - Otherwise create `AbortController`, fire `GET /transcript Range:
     bytes=<max(0, start-524288)>-<start-1>`.
3. On success: `rebuildXtermFromBytes([chunk, ...loadedBytes])`. Restore
   scroll position. Update `loadedRange.startOffset`. Update
   `loadedBytes`. If new start is 0, write the `─── start of run ───`
   marker once.
4. If the user reached the *true* top before the prefetch returned: show
   top-strip `Loading older history…`; remove when promise settles.

### D. Resume (either path)

1. Scroll-to-bottom detected OR `[Resume stream]` clicked.
2. Controller calls `resume()`:
   - If `pendingChunk !== null`: abort it; discard any response.
   - If live run: send `{ type: "request_snapshot" }` over WS; await
     `snapshot` event (2 s timeout); write its ANSI to xterm;
     `scheduleCursorRedraw()`.
   - If finished run: `GET /transcript Range: bytes=<liveOffset>-<total>`;
     write response bytes to xterm.
   - `pauseState.paused = false`; listeners fire → banner dismisses;
     `setInteractive(prop.interactive)`; `term.scrollToBottom()`.
   - Open byte-drop gate.

### E. Chunk-load race with resume

If a chunk fetch is in flight when resume fires: abort the fetch, clear
`pendingChunk`, skip the rebuild. Only the resume flow runs. Avoids
double-flicker.

### F. Interactive vs paused invariant

`effectiveInteractive = interactive && !paused`. Both the `interactive`
prop effect and `pause`/`resume` call a single internal
`applyInteractive()` that uses this formula.

## Error handling

- **Chunk load fails (network / 5xx).** Show `Failed to load older history · [Retry]`.
  Existing buffer untouched. Retry re-fires the same range request. If the
  user scrolls away from the top, strip dismisses.
- **Chunk-load succeeds but rebuild throws.** Atomic rebuild: new xterm
  is only swapped in after all writes succeed. If a write throws, dispose
  the half-built xterm, keep the old one, emit
  `controller.rebuild.error` trace, show the same failure strip.
- **WS drops mid-pause.** Existing auto-reconnect (commit `4c0fd26`)
  handles it. Any `snapshot` arriving while paused is dropped by the gate.
  On resume we request a fresh one anyway, so staleness is a non-issue.
- **Resume snapshot never arrives (2 s timeout).** Unpause anyway — the
  `requestRedraw()` nudge and the next live byte will repaint. A stuck
  banner is worse than a brief stale frame.
- **Transcript empty or missing.** `byteSize === 0` → `seedInitialHistory`
  skips the pre-seed fetch; mount continues as a live-only startup.
- **User scrolls up during pre-seed.** Pre-seed is async. Pause engages
  immediately. When seed completes and rebuilds the xterm, scroll
  position is restored by the same line-delta math as a chunk-load
  rebuild.
- **Rebuild during hidden tab / zero-size host.** `fit.fit()` already
  errors on <4×4 rect. Rebuild defers to the next ResizeObserver fire.
  Old xterm stays mounted in the meantime.
- **Multiple rapid scroll events.** `loadOlderChunk` is idempotent while
  `pendingChunk !== null`. At most one fetch and one rebuild in flight.
- **Run finishes while paused.** Server closes WS or sends final snapshot.
  Dropped by the gate. On resume, the run-state branch in `resume()`
  takes the tail-fetch path instead of `request_snapshot`.

## Testing

### Unit — client (`vitest`)

`scrollDetection.test.ts`:

- `atBottom`, `nearTop`, `viewportTopLine` computed correctly from mocked
  `term.buffer.active.{viewportY, baseY}` and `term.rows`.

`terminalController.test.ts` (extended):

- `seedInitialHistory` fires the correct `Range` request on mount and
  rebuilds the xterm atomically with seed+snapshot.
- Scroll-up transitions to paused state; WS bytes arriving while paused
  are dropped (mock `onBytes` event; assert `term.write` not called).
- `loadOlderChunk` fires when `nearTop === true` and
  `startOffset > 0`; is a no-op otherwise; dedupes concurrent calls via
  `pendingChunk`.
- Chunk-load rebuild preserves scroll position: given a deterministic
  `baseY` delta, asserts `scrollToLine(previousTopLine + addedLines)` is
  called with the expected argument.
- `resume()` via `[Resume stream]` click and via auto-scroll-to-bottom
  both: send `request_snapshot`, write fresh snapshot, call
  `scheduleCursorRedraw()`, restore interactive, clear paused.
- Resume while a chunk fetch is in flight aborts the fetch and skips the
  rebuild.
- Finished-run resume uses `Range` tail-fetch, not `request_snapshot`.

`Terminal.test.tsx` (extended):

- Banner renders iff `paused === true`.
- `[Resume stream]` click wires through to `controller.resume()`.
- No more `Load full history` button.

### Unit — server (`vitest`)

`store.test.ts`:

- `readRange(path, start, end)` returns exact bytes for a known fixture.
- Out-of-range clamps to file size; start > size returns empty.
- Missing file returns empty Uint8Array (like `readAll`).
- `byteSize` returns `fs.statSync(path).size`; returns 0 for missing.

`runs.test.ts`:

- `GET /transcript` with `Range: bytes=X-Y` → 206, `Content-Range` header,
  correct bytes.
- `GET /transcript` without `Range` → 200, full body (existing behavior).
- `X-Transcript-Total` header present on both.

### Integration (manual, `scripts/dev.sh` + Playwright MCP)

1. Fresh run: WS bytes flow; scrollback pre-seeded (can scroll up without
   network load for several screens).
2. Scroll up one line → pause banner appears.
3. Scroll back down → banner dismisses; live bytes resume; cursor
   visible.
4. Click `[Resume stream]` from scrolled-up position → snap to bottom,
   cursor present, typing works.
5. Scroll up repeatedly until a chunk fetch fires → no visible flicker
   if prefetch completes before user reaches top; `Loading older history…`
   strip visible if user outruns prefetch.
6. Continue scrolling to the true top → `─── start of run ───` marker
   appears, no further fetches fire.
7. Finished run: same scroll behaviors; resume uses tail fetch (verify
   in network panel).
8. Tab-hide for 60 s while paused → return → no fast-forward (bytes
   dropped by pause gate); cursor present after resume.

### Trace events

Add to `terminalTrace.ts` consumers:

- `controller.pause`
- `controller.resume` (with `{ reason: 'click' | 'scrollToBottom' }`)
- `controller.chunk.fetch` (with `{ start, end }`)
- `controller.chunk.rebuild` (with `{ addedBytes, addedLines }`)
- `controller.chunk.error` (with `{ reason }`)
- `controller.seed.complete` (with `{ bytes }`)

Ctrl+Shift+D trace remains the primary dev debugging tool.
