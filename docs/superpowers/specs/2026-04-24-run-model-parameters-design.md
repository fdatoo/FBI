# Run model parameters — model, effort, subagent model on New Run

Status: Design
Date: 2026-04-24
Owner: Runs / New-Run feature

## Summary

Let the user configure three Claude model parameters when starting (or continuing) a run:

1. **Model** — `sonnet` / `opus` / `haiku`, or Default (unset).
2. **Effort** — `low` / `medium` / `high` / `xhigh` / `max`, or Default; options filtered per model.
3. **Subagent model** — `sonnet` / `opus` / `haiku`, or Inherit (unset).

Values are collected on the New Run form under a collapsible "Model & effort" section, persisted on the run record, injected into the container as env vars (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL`), and remembered between sessions in browser localStorage so the form pre-fills with whatever the user picked last. The Continue Run flow uses the same component, pre-filled from the original run's values.

NULL/"Default" is a first-class value: it means "do not pass the corresponding env var" and lets Claude Code pick its own default.

## Motivation

Today, every run is launched with a bare `claude --dangerously-skip-permissions` invocation. Users can't choose a smaller/cheaper model for simple tasks, can't crank up effort for a gnarly refactor, and can't use a different subagent model. These are the knobs that actually change agent behavior and cost; they should be adjustable at run-start time, not only via an interactive `/effort` or `/model` slash command after Claude is already running.

## Scope

In scope:

- DB columns on `runs`: `model`, `effort`, `subagent_model` (all nullable TEXT).
- API extension on the run-creation and continue-run endpoints to accept the three optional fields.
- Orchestrator change to inject env vars into the Docker container when fields are set.
- Collapsible "Model & effort" UI section on the New Run form and the Continue Run form.
- localStorage persistence of last-used values on successful New Run submission.
- Client- and server-side validation of model/effort combinations.

Out of scope:

- Thinking budget (`MAX_THINKING_TOKENS`). Effort covers the common need at a higher level; we can add thinking budget later without changing the columns or UI container.
- Max output tokens (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
- Small/fast model (`ANTHROPIC_SMALL_FAST_MODEL`).
- Per-project defaults (one project-wide setting inherited by new runs). localStorage is a simpler v1; this can be layered on later.
- Pinned specific model versions (`claude-opus-4-7`, `claude-sonnet-4-6`, etc.). Aliases cover the common case and don't rot.
- Server-side user preferences. localStorage is sufficient for a single-user personal tool.
- Changes to the Usage sidebar / telemetry schema; `run_usage_events.model` already captures what actually ran.

## User experience

### New Run form

Below the existing Branch field, add a collapsible section. Collapsed state shows one summary line that always lists all three values, using `default` / `inherit` for unset fields:

```
▸ Model & effort · opus · effort: xhigh · subagent: inherit
▸ Model & effort · default · effort: default · subagent: inherit
```

Showing all three uniformly (rather than hiding unset fields) makes it impossible to mistake "I haven't expanded it" for "some hidden values are set."

The section starts collapsed on every visit. (Rationale: the summary line already shows what will be used; auto-expand behavior adds complexity with little payoff once values are visible inline.)

When expanded, three controls appear:

- **Model** — `<select>` with options: `Default`, `sonnet`, `opus`, `haiku`.
- **Effort** — `<select>` whose option list depends on the Model value:
  - Model = `opus` → `Default`, `low`, `medium`, `high`, `xhigh`, `max`.
  - Model = `sonnet` or `Default` → `Default`, `low`, `medium`, `high`, `max`.
  - Model = `haiku` → control is disabled with the helper text "Not supported on Haiku"; its value is forced to `Default`.
- **Subagent model** — `<select>` with options: `Inherit`, `sonnet`, `opus`, `haiku`.

Behavior when Model changes in a way that invalidates Effort (e.g. Opus → Sonnet with `xhigh` selected, or any model → Haiku with a non-default effort): Effort silently resets to `Default`. No modal, no warning — the summary line will reflect the change immediately.

### Continue Run form

Same collapsible component, but its initial state is the original run's `{ model, effort, subagent_model }` (read from the run record) rather than localStorage. The user may change any field before confirming; on submit, the new continuation-run record gets the (possibly updated) values. Continue-run submissions do **not** write to localStorage — that stays tied to New Run so one-off continue tweaks don't pollute the next fresh-run pre-fill.

### localStorage persistence

- Key: `fbi.newRun.lastModelParams`.
- Value: JSON object `{ model, effort, subagent_model }` where each field is either one of the valid strings above or `null`.
- Read: on New Run form mount; missing/malformed value falls back to `{ model: null, effort: null, subagent_model: null }`.
- Write: on successful run creation from the New Run form (i.e. after the API returns 201). Failed creations do not update it.

## Data model

Migration adds three nullable columns to `runs`:

```sql
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN effort TEXT;
ALTER TABLE runs ADD COLUMN subagent_model TEXT;
```

Existing rows get NULL on all three; they continue to run exactly as before. No indexes are needed — these are record-bound and never queried as filters.

The `Run` TypeScript type (wherever `runs` rows are shaped for the API) gains the same three optional fields.

## API changes

### `POST /api/projects/:id/runs`

Request body (additions are optional):

```jsonc
{
  "prompt": "...",
  "branch": "main",
  "draft_token": "...",
  "model": "opus",                // optional: sonnet | opus | haiku
  "effort": "xhigh",              // optional: low | medium | high | xhigh | max
  "subagent_model": "sonnet"      // optional: sonnet | opus | haiku
}
```

Response: the `Run` object, now including `model`, `effort`, `subagent_model` (each possibly null).

### Continue-run endpoint

The existing continue-run endpoint gains the same three optional fields with the same validation rules. The continuation run's row stores whatever values were submitted.

### Validation (server-side)

Implemented as a small pure function used by both endpoints. Rules:

- `model`, if present, is in `{sonnet, opus, haiku}`.
- `effort`, if present, is in `{low, medium, high, xhigh, max}`.
- `subagent_model`, if present, is in `{sonnet, opus, haiku}`.
- `effort` with `model === "haiku"` → reject.
- `effort === "xhigh"` with `model !== "opus"` → reject.
- `effort` set with `model` absent (Default) → allowed; at runtime, Claude Code ignores the env var if the model it picks doesn't support effort. The UI avoids this combination but the server doesn't need to.

Any failure returns 400 with a message naming the offending field(s).

## Orchestrator

In `createContainerForRun` (src/server/orchestrator/index.ts), after the existing base `Env` array is built, conditionally append:

- `ANTHROPIC_MODEL=<run.model>` if `run.model` is set.
- `CLAUDE_CODE_EFFORT_LEVEL=<run.effort>` if `run.effort` is set.
- `CLAUDE_CODE_SUBAGENT_MODEL=<run.subagent_model>` if `run.subagent_model` is set.

`supervisor.sh` requires no change — `claude` reads these env vars natively for both fresh and `--resume` invocations.

## Testing

- **Unit — validation function:** table-driven test covering every valid combination (passes) and every invalid combination (rejects with the expected error). Includes the NULL / unset cases.
- **Unit — env-var assembly:** given a `Run` object, assert the constructed `Env` array contains exactly the expected entries (all three present, subset present, none present).
- **Integration — run creation:** mock the Docker client; `POST /api/projects/:id/runs` with `{ model: "opus", effort: "xhigh", subagent_model: "haiku" }` persists those values on the row and the Docker `create` call receives the three env entries; a second call with all fields omitted persists NULLs and passes no model-related env vars.
- **Component — NewRun form:** effort dropdown options filter per model; switching to haiku disables effort and resets its value; summary line matches the current state; localStorage round-trips on submit.
- **Component — ContinueRun form:** form pre-fills from the supplied run record (not localStorage) and does not write to localStorage on submit.
- **Manual smoke:** start one real run with `{ model: "opus", effort: "high" }`; `docker exec $id env | grep -E 'ANTHROPIC_MODEL|CLAUDE_CODE_EFFORT_LEVEL'` shows the values; the run completes without errors.

## Migration & rollout

- Schema migration runs on startup (follow the existing pattern for past schema additions, e.g. `state_entered_at`).
- No data backfill needed; NULL is the correct value for every pre-existing run.
- Feature lands in a single PR. No flag required — the UI defaults keep behavior identical to today for any user who doesn't open the Advanced section.

## Risks & open questions

- **Aliases vs pinned versions.** We ship aliases only. If Anthropic introduces a new generation (e.g. Opus 5) and changes which concrete model `opus` points to, every existing saved value silently gets the new model on the next run. This is the desired behavior for this tool but worth documenting so it isn't a surprise.
- **Effort on unset model.** If the user picks an Effort without picking a Model, and the Default model Claude Code selects happens to be Haiku, the env var is silently ignored by the CLI. The UI discourages this by making the pairing visually odd, but it is a no-op rather than an error.
