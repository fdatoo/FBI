> **Superseded by [2026-04-26-terminal-rust-rewrite-design.md](2026-04-26-terminal-rust-rewrite-design.md).**
> The redesign in this doc has been replaced by a Rust-based server-side
> virtual terminal exposed to the BEAM via Rustler NIF. See the newer
> spec for the architecture that actually shipped.

# Terminal Hardening Redesign

## Problem

The terminal is still the buggiest surface in the app despite four prior fix passes (see commits `f309355`, `50fd60b`, `c0b4e42`, `65b3f2b`, `b504699`, and the full "terminal robustness" series). Three user-observable symptoms continue to reappear:

1. **Creating a new run or pressing Continue leaves the terminal frozen.** The xterm stays blank (or stuck on the pre-continue frame) until the user switches browser tabs / navigates away from the run and back. Then it starts rendering.
2. **Clicking "Load full history" breaks input.** The xterm becomes non-interactive in the sense that typed characters produce no visible response; users can only regain input by clicking "Resume live."
3. **The live view's scrollback is insufficient.** When users want to look back more than a screen, they have to click "Load full history" — which triggers symptom 2.

Each of these has a specific cause, but they share a deeper pattern: the terminal's client-side state (xterm instance, dims, `ready` flag, subscriptions) is torn down and rebuilt whenever anything changes, and every rebuild has a fragile recovery path that depends on timers and external events. Any missed recovery leaves the terminal in a silent failure mode.

## Observed causes

### Symptom 1 — frozen after new-run / continue

A chain of defects in the client's `Terminal.tsx`:

- The useEffect dep list `[runId, interactive]` at `src/web/components/Terminal.tsx:367` causes the entire xterm to be disposed and re-created whenever `interactive` flips. A continued run's state transitions from `succeeded/failed/cancelled` to `running`, flipping `interactive` from false to true, so the xterm is thrown away mid-stream.
- On re-mount, `new Xterm(...)` starts at xterm's default 80×24 regardless of the host dims. The cached `lastSnapshot` from the shell registry still has the pre-flip dims (e.g. 120×40). `shouldApply` at `Terminal.tsx:181–182` drops any snapshot whose dims don't match the new xterm — so the cached snapshot is dropped.
- `ready` is reset to `false`. The live-bytes handler at `Terminal.tsx:201–207` drops every live chunk until `ready` is true.
- The path that resets dims is `shell.onOpen(() => if (interactive && safeFit()) shell.resize(...))` at `Terminal.tsx:276–278`. But `shell.onOpen` uses `ws.addEventListener('open', cb, {once: true})` at `lib/ws.ts:67`, which is a no-op if the WS is already open. After the re-mount, the WS *is* already open (it came from the cached `ShellHandle`), so the callback never fires. The resize-to-server roundtrip that would produce a matching snapshot never kicks off from this path.
- The only remaining recovery is the `ResizeObserver`'s initial fire → 120 ms debounce → `safeFit` → `shell.resize` → server 200 ms wait → snapshot. If `safeFit` returns false (host briefly 0-sized, xterm `proposeDimensions()` not ready), the observer must fire again. There is no retry. "Switching away and back" works because the layout kick it induces often triggers a new observer fire at valid dims.

### Symptom 2 — history mode blocks input

`loadFullRef.current` at `Terminal.tsx:282–315` is destructive:
- unsubscribes live bytes and snapshot handlers,
- calls `term.reset()`,
- writes the fetched transcript into the same xterm.

But `term.onData` at `Terminal.tsx:343` remains wired to `shell.send(...)`. Keystrokes reach the PTY; the PTY's echoes come back over the WS; they are dropped on the floor because the bytes subscription was removed. Users see nothing.

### Symptom 3 — insufficient scrollback

`ScreenState` uses `scrollback: 0` (`src/server/logs/screen.ts:177`) on purpose — the snapshot is viewport-only. Client-side xterm's default scrollback (1000 lines) is destroyed:
- by every xterm re-mount (symptom 1's cause),
- by `applySnapshot` writing `?1049l\x1b[H\x1b[2J` from `modesAnsi` (`screen.ts:138–142`),
- by every resync (focus/blur triggers `requestResync`).

Users are limited to what's currently on-screen plus whatever recent live bytes happened to accumulate since the last reset.

### Server-side companion bug

`Orchestrator.continueRun` at `src/server/orchestrator/index.ts:611–612` uses

```ts
const onBytes = (chunk: Uint8Array) => { store.append(chunk); broadcaster.publish(chunk); };
```

The three other onBytes sites (`launch` at 258–265, `resume` at 509–513, `reattach` at 836–840) additionally call `screen.write(chunk)`. Consequence: during a continue, the server's authoritative `ScreenState` is never updated with new bytes. A resync during the continue returns the pre-continue screen. The bug is masked today because the **broadcaster** still delivers live bytes to an already-connected WS, but if the client asks for a fresh snapshot (via resync or a fresh WS connect) it gets a stale one.

This is the same defect class as the onBytes fan-out being copy-pasted four times with no shared helper — drift is inevitable.

## Non-goals

- Overhauling the server-side snapshot protocol or adopting a different terminal library.
- Expanding `ScreenState` to store scrollback. The TUI repaints in place, so a scrollback buffer would mostly contain redraw churn; the right surface for historical content is the log file, not an xterm.
- Making the WebSocket auto-reconnect on network drops. That is a separate reliability gap that can be addressed after these fixes.
- Refactoring `Terminal.tsx` into multiple files for its own sake.

## Solution

Five changes, each small and testable on its own.

### (S1) Dedupe orchestrator `onBytes` and include `screen.write` in every path

Extract `makeOnBytes(store, broadcaster, screen)` in `src/server/orchestrator/index.ts`. All four entry points (`launch`, `resume`, `continueRun`, `reattach`) call it. `continueRun`'s current `onBytes` — which omits `screen.write` — is replaced. The helper cannot be called without a `ScreenState`, so the drift cannot reoccur.

Rationale: this is the cheapest durable fix for the continue snapshot gap, and it removes a recurring source of drift.

### (C1) Keep the xterm instance alive across `interactive` transitions

Split `Terminal.tsx`'s single useEffect into:
- A **mount effect** keyed on `[runId]` that creates the xterm, wires the WS subscription, the write queue, the ResizeObserver, the focus/visibility handlers, and the tracing. This effect never re-runs during a state transition within the same run.
- An **input-wiring effect** keyed on `[interactive]` that attaches / detaches `term.onData → shell.send` based on `interactive`. It does not touch the xterm instance or the subscription.
- A **fit/resize effect** keyed on `[interactive]` that calls `safeFit + shell.resize` when interactive becomes `true`, so the server is told about the client's dims whenever the run flips into a state where the client owns them.

The xterm is disposed only on `runId` change or component unmount. Scrollback, `ready`, cursor, and subscriptions survive every `interactive` flip.

### (C2) Reliable dim handshake — replace `shell.onOpen({once: true})` with `onOpenOrNow(cb)`

Replace `onOpen` in `src/web/lib/ws.ts` with `onOpenOrNow(cb)`: if the WS is already OPEN, fire `cb` on the next microtask; else listen for the `open` event (not once: true — allow multiple calls during the lifetime of the socket).

In `Terminal.tsx`, call `onOpenOrNow` each time the fit/resize effect runs. This guarantees the server is told the client's dims when:
- the WS first opens,
- `interactive` flips to true on an already-open socket,
- the component remounts against a cached socket.

### (C3) Drop the `ready` gate for live bytes

Remove `if (!ready) return;` at `Terminal.tsx:205`. Forward live bytes to the xterm write queue unconditionally.

Rationale: when a snapshot does arrive, it begins with `modesAnsi` that ends in `?1049h` or `?1049l\x1b[H\x1b[2J`, both of which wipe the screen. Any "early" live bytes that landed ahead of the snapshot are visually redundant. Dropping them is the current behavior and it hides legitimate bytes during symptom 1.

`applySnapshot` keeps its `clearQueue()` call to ensure queued pre-snapshot bytes do not land *after* the snapshot at the wrong sequence.

### (C4) Non-destructive "Load full history"

Keep the live xterm mounted and streaming at all times. "Load full history" creates a **second** xterm instance in a sibling DOM node, loads the transcript into it, and swaps visibility:

- While `historyMode` is `true`: the history xterm is visible; the live xterm has `display: none` but continues to receive bytes in the background. `term.onData` on the history xterm is not wired (no input forwarded from history).
- When the user clicks "Resume live": the history xterm is disposed; the live xterm is shown with `display: block`. No resync is needed — it was never unsubscribed.

Rationale: the live subscription never breaks, so symptom 2 cannot reoccur. Symptom 3 is softened because users now have a fully-scrollable transcript in the history xterm without losing the live view underneath. This also removes the "loading history…" → "resume live" → "loading terminal…" dance.

### (C5) Test coverage

Add server-side unit tests for the `makeOnBytes` helper (feeds all three sinks; missing any sink is a type error).

Add Playwright browser tests using `scripts/dev.sh` + the Playwright MCP tools that cover:
- New run: create → navigate to RunDetail → the first 500 ms of bytes render without any tab switch.
- Continue: on a terminal-state run with a valid session, click Continue → new bytes render without a tab switch.
- History toggle: click "Load full history" → transcript visible; type something (input should remain usable once back on live); click "Resume live" → live view intact, no loading spinner.

Add a Vitest unit test for `Terminal.tsx`'s re-render behavior on `interactive` flip (mocked xterm so we can assert "xterm instance was not disposed"). Depend on the `term.dispose` spy.

## Interface changes

### `src/server/orchestrator/index.ts`

```ts
// New internal helper, colocated with the rest of the class.
private makeOnBytes(
  runId: number,
  store: LogStore,
  broadcaster: Broadcaster,
): (chunk: Uint8Array) => void {
  const screen = this.deps.streams.getOrCreateScreen(runId);
  return (chunk) => {
    store.append(chunk);
    broadcaster.publish(chunk);
    void screen.write(chunk).catch(() => {});
  };
}
```

All four call sites (`launch`, `resume`, `continueRun`, `reattach`) replace their inline `const onBytes = ...` with `const onBytes = this.makeOnBytes(runId, store, broadcaster);`. No public API changes.

### `src/web/lib/ws.ts`

```ts
export interface ShellHandle {
  // ...existing...
  onOpenOrNow(cb: () => void): void; // replaces onOpen
}
```

Implementation:

```ts
onOpenOrNow: (cb) => {
  if (ws.readyState === WebSocket.OPEN) {
    queueMicrotask(cb);
  } else {
    ws.addEventListener('open', cb);
  }
}
```

Callers migrate from `onOpen` to `onOpenOrNow`. Single caller today (`Terminal.tsx`).

### `src/web/components/Terminal.tsx`

Component is restructured as described in C1 / C4. Public props unchanged (`{ runId: number; interactive: boolean }`). No consumer changes.

### `src/web/lib/shellRegistry.ts`

No changes to public API. Scrollback and `ready` lifetime are client-component concerns, not registry concerns.

## Test strategy

- **Server unit tests** (Vitest): dedup helper is used by all four code paths, feeds all three sinks, and `continueRun` produces a ScreenState that reflects new bytes after a continue (regression test for the observed bug).
- **Client unit tests** (Vitest + jsdom + mocked xterm): after the `interactive` flip, the same xterm instance is still in use; `term.dispose` was not called; `term.onData` handler was re-wired.
- **Playwright end-to-end**: new-run render within 500 ms; continue-run streaming without tab switch; history toggle preserves input and does not need a loading spinner on resume.

## Acceptance criteria

1. On a terminal-state run, clicking Continue produces visible bytes in the live xterm within 1 second, with no browser-tab or navigation trick required.
2. On a newly-created run, the RunDetail page renders PTY bytes within 1 second of navigation, with no tab trick.
3. Clicking "Load full history" and then typing into the live terminal shows the keystrokes' echoes in real time once the user returns to the live view; no bytes are dropped; no loading spinner appears when switching back.
4. The server's `ScreenState` reflects bytes written during a continued run (a resync during or immediately after a continue returns a snapshot containing post-continue output).
5. All existing terminal tests pass. New tests from C5 pass.

## Risks and mitigations

- **Risk: dropping the `ready` gate causes an out-of-order-bytes artifact.**
  Mitigation: `applySnapshot` already calls `clearQueue()` before writing the snapshot, so queued live bytes cannot land after the snapshot. The snapshot's leading `modesAnsi` wipes the screen, so any pre-snapshot content is overwritten. Visual risk is limited to brief flicker at initial mount.
- **Risk: keeping xterm alive on `interactive` changes leaks state from the non-interactive phase.**
  Mitigation: `term.onData` attach/detach is handled by the input-wiring effect; nothing else is interactive-sensitive. Cursor, selection, scrollback are all *desirable* to preserve.
- **Risk: the second xterm for history doubles memory usage.**
  Mitigation: disposed immediately on "Resume live." Only active while the user is reading history.
- **Risk: behavioral change in `onOpenOrNow` if there are future callers that rely on once-only semantics.**
  Mitigation: the only caller today is the fit/resize effect, which is idempotent (calling `shell.resize` with the same dims twice is a no-op on the server).
