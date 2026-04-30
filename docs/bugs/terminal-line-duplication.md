> **Resolved by the Rust rewrite ([2026-04-26-terminal-rust-rewrite-design.md](../superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md)).**
> The `seedInitialHistory` overlap described below was fixed as part of the
> NIF-based snapshot pipeline; `liveTailBytes` no longer overlaps with the
> seed range after the rewrite landed.

# Terminal Line Duplication Bug

## Symptom

When a user watches a run live and then scrolls up into history (triggering "Stream paused — you're viewing history"), the terminal content appears duplicated — the same paragraphs/lines show twice in the scrollback.

Observed on run #10 ("Fix Elixir ship dialog branch detection"), waiting state.

## Root Cause

**File:** `src/web/lib/terminalController.ts`, `seedInitialHistory()` (~line 516)

`liveTailBytes` overlaps with `seedBytes` in the initial rebuild, causing the same bytes to be written to xterm twice.

### Sequence

1. User watches run live. Every PTY byte arrives via WS → appended to `this.liveTailBytes` AND written directly to xterm.

2. Run goes to "waiting" (or completes). WS snapshot arrives → `seedInitialHistory(snap)` is queued.

3. `seedInitialHistory` runs:
   - `fetchTranscriptMeta()` → `headerTotal` (full transcript size)
   - Fetches `seedBytes` = last 128 KB of transcript (or all if shorter)
   - `this.loadedBytes = concat([seedBytes, snapBytes])`
   - `this.liveOffset = headerTotal`  ← resets offset but **does NOT trim `liveTailBytes`**
   - `rebuildXterm([this.loadedBytes, this.liveTailBytes])`

4. The rebuild writes: **[seedBytes] → [snapBytes] → [liveTailBytes]**

`liveTailBytes` at this point contains every byte the user watched live since mount. For a user who opened the page while the run was running, those bytes are the same bytes as the end of `seedBytes` (same PTY output, delivered via WS instead of transcript fetch).

The snapshot's `\x1b[H\x1b[2J` between the two sets clears the visible viewport but **not the scrollback**. The duplicate `liveTailBytes` write pushes all that content into scrollback a second time — visible when the user scrolls up.

### Why it's total duplication (not partial)

If the user watched from near the start, `liveTailBytes.byteLength ≈ headerTotal` — nearly full overlap. The entire run output appears twice.

## Fix (not yet implemented)

In `seedInitialHistory`, capture `this.liveOffset` **before any awaits** (before `fetchTranscriptMeta`). After fetching the transcript, trim `liveTailBytes` to remove the overlapping bytes and update `liveOffset`:

```typescript
// Capture BEFORE any await — bytes received before this point are
// already in the transcript range and will be in seedBytes.
const liveAtSeedStart = this.liveOffset;

const headerTotal = await this.fetchTranscriptMeta();
// ... fetch seedBytes ...

this.loadedBytes = concat([seedBytes, snapBytes]);
this.loadedStartOffset = start;

// Trim: bytes [0..liveAtSeedStart-1] in liveTailBytes overlap with seedBytes.
// Keep only bytes received after the meta fetch (genuinely post-headerTotal).
const tail = this.liveTailBytes.subarray(liveAtSeedStart);
this.liveTailBytes = tail;
this.liveOffset = headerTotal + tail.byteLength;
```

`liveAtSeedStart` is safe to capture before the first `await` because `seedInitialHistory` is invoked via `queueMicrotask`, which runs before the event loop yields to incoming WS byte callbacks.
