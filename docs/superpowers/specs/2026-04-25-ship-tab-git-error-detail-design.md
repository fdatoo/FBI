# Ship Tab: Git Operation Error Detail

**Date:** 2026-04-25  
**Status:** Approved

## Problem

When a git operation on the Ship tab fails at the infrastructure level (Docker unavailable, SSH auth failure, container error), the server swallows the exception and returns `{ kind: 'git-unavailable' }` with no message. The client displays "Git operation failed." — identical in style to success messages, with no diagnostic information.

## Goal

Surface the actual error message so the user knows what failed and can act on it. Visually distinguish error messages from success messages.

## Architecture

Four small, sequential changes across the shared type boundary, server, hook, and component.

### 1. `shared/types.ts` — type change

Add optional `message` to the `git-unavailable` variant:

```ts
| { kind: 'git-unavailable'; message?: string }
```

### 2. `server/api/runs.ts` — capture exception message

Change the bare `catch` to capture the error:

```ts
} catch (e) {
  return { kind: 'git-unavailable', message: e instanceof Error ? e.message : String(e) } satisfies HistoryResult;
}
```

### 3. `useHistoryOp.ts` — expose error kind

Add a `msgIsError` boolean alongside `msg` so consumers can style errors differently.

- Set `msgIsError = true` for `git-unavailable`, `git-error`, and `invalid` result kinds.
- Set `msgIsError = false` for `complete`, `agent`, `conflict`, `agent-busy`.
- Display the `git-unavailable` message if present, falling back to `'Git operation unavailable'`.
- Hook signature becomes `{ busy, msg, msgIsError, run }`.

### 4. `ShipTab.tsx` — error styling

Use `fail` design tokens (already in the system) when `msgIsError`:

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

## Data Flow

```
execHistoryOp throws
  → server catches, attaches e.message → { kind: 'git-unavailable', message: '...' }
  → useHistoryOp sets msg + msgIsError=true
  → ShipTab renders with fail-token styling
```

## Error Handling

- If `e.message` is empty or undefined, `String(e)` provides a fallback.
- If the server somehow returns `git-unavailable` without a `message`, the client falls back to `'Git operation unavailable'`.

## Testing

- Existing `useHistoryOp` and `runs.ts` unit tests should be updated to cover the `message` field on `git-unavailable`.
- No visual tests required — the styling change is a CSS class swap on an existing element.

## Out of Scope

- Error classification / actionable hints (Option B) — deferred; error strings are not stable enough to parse reliably.
- Changing the display for `git-error` messages (already shows the git message; just gains error styling).
