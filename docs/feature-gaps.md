# FBI — Feature Gaps

**Purpose:** Running backlog of gaps identified against the shipped v1 runtime slice.
Work through categories one at a time: brainstorm → spec → plan → implement → mark shipped here.

**Priority legend:**
- **P1** — painful for daily single-user flow, fix soon
- **P2** — "you'll want this soon"
- **P3** — nice-to-have, or explicit non-goal in the v1 spec

**Status legend:** `todo` · `specing` (design in progress) · `planned` (plan written) · `in-progress` · `shipped` · `wontfix`

---

## Suggested working order

1. **A. Run iteration & reuse** — biggest lift per unit effort; reshapes the tool
2. **B. Visibility & post-run signal** — completion notifications especially
3. **F. Prompt composition transparency** — small, ships fast, unlocks A and B
4. **C. Filtering & scale** — gets painful around run #50
5. **D. Safety & limits** — quiet risks, worth addressing before an incident
6. **E. Completion & workflow** — auto-PR is the natural next click
7. **G. Operability** — SSH-free admin is a late-stage polish
8. **H. Non-goals** — only revisit if scope shifts

---

## A. Run iteration & reuse

**Status:** shipped (P1s, P2)
**Spec:** [`2026-04-21-p1-improvements-design.md`](superpowers/specs/2026-04-21-p1-improvements-design.md) §2, §3 · [`2026-04-21-p2-improvements-design.md`](superpowers/specs/2026-04-21-p2-improvements-design.md) §7

- [x] **(P1) Follow-up run on the same branch.** Reframed during brainstorming: Claude owns branch naming, follow-up collapses to "new run with pre-filled branch field." See P1 spec §2.
- [x] **(P1) Prompt history / templates.** Spec'd as history-only: "Recent prompts" dropdown on NewRun, top N distinct prompts per project, no new table. See P1 spec §3.
- [x] **(P2) Run comparison.** Shipped as "Related runs" on RunDetail: siblings sharing a prompt, each with a GitHub compare link. See P2 spec §7.

---

## B. Visibility & post-run signal

**Status:** shipped (P1, P2) · todo (P3)
**Spec:** [`2026-04-21-p1-improvements-design.md`](superpowers/specs/2026-04-21-p1-improvements-design.md) §4 · [`2026-04-21-p2-improvements-design.md`](superpowers/specs/2026-04-21-p2-improvements-design.md) §2, §5, §6

- [x] **(P1) Run-completion notification.** Spec'd: Browser Notification API + tab title prefix + favicon dot, global watcher via 5s poll, Settings toggle. See P1 spec §4.
- [x] **(P2) "What's running now" on the home page.** `/projects` shows a "● N running" chip per project, populated from the watcher. See P2 spec §2.
- [x] **(P2) PR / CI / branch-status surfacing.** RunDetail renders a GitHub status card (`gh pr list` + `gh pr checks`) with 10s cache and 30s poll. See P2 spec §5.
- [x] **(P2) File-level diff summary on the run page.** RunDetail renders a "Files changed" table via `gh api …/compare`. See P2 spec §6.
- [ ] **(P3) Duration / token / cost metrics.** Explicit non-goal, but the absence compounds over time.

---

## C. Filtering & scale

**Status:** shipped (P2) · todo (P3)
**Spec:** [`2026-04-21-p2-improvements-design.md`](superpowers/specs/2026-04-21-p2-improvements-design.md) §2

- [x] **(P2) `/runs` filters, search, pagination.** State/project dropdowns, debounced prompt search, page-of-50 pagination, URL-synced.
- [x] **(P2) `/projects` shows last-run state/time.** Project cards render state badge + relative time from `Project.last_run`.
- [ ] **(P3) Tags / labels on runs** for triage.

---

## D. Safety & limits

**Status:** shipped (P1, P2)
**Spec:** [`2026-04-21-p1-improvements-design.md`](superpowers/specs/2026-04-21-p1-improvements-design.md) §5 · [`2026-04-21-p2-improvements-design.md`](superpowers/specs/2026-04-21-p2-improvements-design.md) §4

- [x] **(P1) Resource caps per container** (cpu/mem/pids). Spec'd: global env defaults + nullable per-project override, enforced via Docker HostConfig, OOM surfaced as a specific error. See P1 spec §5.
- [x] **(P2) Concurrency / queue cap.** Soft warning at configurable threshold (default 3; 0 disables). NewRun confirm dialog; operator always has the final say. See P2 spec §4.1.
- [x] **(P2) Image GC.** Opt-in nightly sweep + on-demand button. Keeps reachable `fbi/*` images + anything a container references; deletes unreachable `fbi/*` older than 30 days. See P2 spec §4.2.

---

## E. Completion & workflow

**Status:** shipped (P2) · todo (P3)
**Spec:** [`2026-04-21-p2-improvements-design.md`](superpowers/specs/2026-04-21-p2-improvements-design.md) §5

- [x] **(P2) Auto-PR / one-click "open PR on GitHub."** "Create PR" button on RunDetail; uses `gh pr create` with run prompt as body. See P2 spec §5.4.
- [ ] **(P3) Webhook / scheduled triggers.** Explicit non-goal (spec §2).
- [ ] **(P3) "Reply to PR comment → start run"** integration.

---

## F. Prompt composition transparency

**Status:** shipped (P2)
**Spec:** [`2026-04-21-p2-improvements-design.md`](superpowers/specs/2026-04-21-p2-improvements-design.md) §3

- [x] **(P2) Composed-prompt preview.** NewRun shows a live-updating `<details>` panel with the exact text Claude will receive (preamble + global + instructions + prompt), using a shared `composePrompt` helper tested for parity with `supervisor.sh`.
- [x] **(P2) Effective plugins/marketplaces preview.** NewRun renders the deduped union of global defaults + project additions above the Start button.

---

## G. Operability

**Status:** todo

- [ ] **(P3) In-app health/admin page** (Docker daemon OK? image cache size? disk?). Today you SSH in.
- [ ] **(P3) `DELETE /api/runs/:id` on a running run is silent cancel.** Finished runs get deleted, running runs get cancelled with no row removal. UX surprise worth at least making explicit in the UI.

---

## H. Explicit non-goals worth sanity-checking

**Status:** wontfix (unless scope shifts)

Spec §2 and §11 mark these out-of-scope. Listed here so they're one place to find:
- Multi-user / RBAC
- Auto-PR creation (now shipped — see E)
- Run retry / resume / chaining
- In-app diff viewer (see B — diff summary ships, but viewer is still deferred)
- Mobile UI
- Webhooks, scheduled triggers
- Cross-project templates
- Pluggable runtime / image-build backends
- Pre-run "exec into container without running Claude"
- Per-task ephemeral deploy keys (currently: host SSH agent forwarding)

---

## Changelog

- 2026-04-21 — doc created; findings from post-v1 evaluation
- 2026-04-21 — all four P1s spec'd in `superpowers/specs/2026-04-21-p1-improvements-design.md` (A: branch autonomy + recent prompts; B: completion notifications; D: resource caps)
- 2026-04-21 — P1 pack shipped; branch autonomy, recent prompts, notifications, and resource caps live.
- 2026-04-21 — P2 pack shipped; scale & visibility, pre-run transparency, safety caps + image GC, GitHub status + PR creation, file-level diff, related runs.
