# Shim Output Enhanced Color Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add rich color to shim output — style all orchestrator `[fbi]` messages in TypeScript and upgrade `_fbi_cmd` in supervisor.sh so paths/refs render in purple distinct from the cyan command verb.

**Architecture:** Create a new `fbiOutput.ts` module with ANSI helpers mirroring the bash helper set; import it in `index.ts` to replace all `Buffer.from('[fbi] ...')` strings. In parallel, refactor `_fbi_cmd` in `supervisor.sh` to accept two arguments (verb + path) and update its six call sites.

**Tech Stack:** TypeScript (ANSI escape codes), Bash

---

### Task 1: Create fbiOutput.ts helper module

**Files:**
- Create: `src/server/orchestrator/fbiOutput.ts`

- [ ] **Step 1: Write the module**

Create `src/server/orchestrator/fbiOutput.ts` with this exact content:

```typescript
// ANSI styled output helpers for orchestrator messages.
// Mirrors the bash _fbi_* helpers in supervisor.sh.
// Both stdout and stderr flow through the same PTY attach stream,
// so styling both is safe.

const R      = '\x1b[0m';
const GRAY   = '\x1b[90m';
const WHITE  = '\x1b[97m';
const DIM    = '\x1b[2m';
const AMBER  = '\x1b[33m';
const RED    = '\x1b[31m';
const BLUE   = '\x1b[34m';
const GREEN  = '\x1b[32m';

export const fbi = {
  status(msg: string): string {
    return `${GRAY}○${R}  ${WHITE}${msg}${R}\n`;
  },

  statusKV(key: string, val: string): string {
    return `${GRAY}○${R}  ${WHITE}${key}${R}  ${DIM}${val}${R}\n`;
  },

  warn(msg: string): string {
    return `${AMBER}⚠${R}  ${AMBER}${msg}${R}\n`;
  },

  fatal(msg: string): string {
    return `${RED}✕${R}  ${RED}${msg}${R}\n`;
  },

  info(msg: string): string {
    return `${BLUE}◎${R}  ${BLUE}${msg}${R}\n`;
  },

  runState(state: 'succeeded' | 'failed' | 'cancelled'): string {
    const color  = state === 'succeeded' ? GREEN : state === 'failed' ? RED : AMBER;
    const symbol = state === 'succeeded' ? '●'   : state === 'failed' ? '✕' : '○';
    return `${GRAY}○${R}  run  ${color}${symbol} ${state}${R}\n`;
  },
};
```

- [ ] **Step 2: Verify it type-checks**

```bash
cd /workspace && npx tsc -p tsconfig.server.json --noEmit 2>&1 | head -30
```

Expected: no errors mentioning `fbiOutput.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/server/orchestrator/fbiOutput.ts
git commit -m "feat(orchestrator): add ANSI styled output helper module"
```

---

### Task 2: Wire fbiOutput into index.ts — container setup messages

**Files:**
- Modify: `src/server/orchestrator/index.ts`

The three startup messages that appear before the container starts.

- [ ] **Step 1: Add the import**

At the top of `src/server/orchestrator/index.ts`, add the import alongside other local imports:

```typescript
import { fbi } from './fbiOutput.js';
```

- [ ] **Step 2: Replace the three startup messages**

Find (line ~208):
```typescript
onBytes(Buffer.from(`[fbi] resolving image\n`));
```
Replace with:
```typescript
onBytes(Buffer.from(fbi.status('resolving image')));
```

Find (line ~218):
```typescript
onBytes(Buffer.from(`[fbi] image: ${imageTag}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from(fbi.statusKV('image', imageTag)));
```

Find (line ~243):
```typescript
onBytes(Buffer.from(`[fbi] starting container\n`));
```
Replace with:
```typescript
onBytes(Buffer.from(fbi.status('starting container')));
```

- [ ] **Step 3: Type-check**

```bash
cd /workspace && npx tsc -p tsconfig.server.json --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): style container setup messages"
```

---

### Task 3: Wire fbiOutput into index.ts — error, rate-limit, and run-state messages

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Replace error messages**

Find (line ~464):
```typescript
onBytes(Buffer.from(`\n[fbi] error: ${msg}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.fatal(msg)));
```

Find (line ~503) — a generic error emit with `errMsg`:
```typescript
onBytes(Buffer.from(`\n[fbi] ${errMsg}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.fatal(errMsg)));
```

- [ ] **Step 2: Replace rate-limit messages**

Find (line ~533):
```typescript
`\n[fbi] rate limited; exceeded auto-resume cap (${settings.auto_resume_max_attempts} attempts)\n`,
```
Replace with:
```typescript
'\n' + fbi.warn(`rate limited; exceeded auto-resume cap (${settings.auto_resume_max_attempts} attempts)`),
```

Find (line ~549):
```typescript
`\n[fbi] awaiting resume until ${new Date(verdict.reset_at).toISOString()}\n`,
```
Replace with:
```typescript
'\n' + fbi.info(`awaiting resume until ${new Date(verdict.reset_at).toISOString()}`),
```

Find (line ~566):
```typescript
onBytes(Buffer.from(`\n[fbi] rate limited but no reset time available; failing\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.warn('rate limited; no reset time available; failing')));
```

- [ ] **Step 3: Replace run-state message**

Find (line ~597):
```typescript
onBytes(Buffer.from(`\n[fbi] run ${state}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.runState(state)));
```

- [ ] **Step 4: Type-check**

```bash
cd /workspace && npx tsc -p tsconfig.server.json --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): style error, rate-limit, and run-state messages"
```

---

### Task 4: Wire fbiOutput into index.ts — resume and continue messages

**Files:**
- Modify: `src/server/orchestrator/index.ts`

- [ ] **Step 1: Replace resume messages**

Find (line ~621):
```typescript
`\n[fbi] resuming (attempt ${run.resume_attempts} of ${this.deps.settings.get().auto_resume_max_attempts})\n`,
```
Replace with:
```typescript
'\n' + fbi.status(`resuming (attempt ${run.resume_attempts} of ${this.deps.settings.get().auto_resume_max_attempts})`),
```

Find (line ~634):
```typescript
onBytes(Buffer.from(`[fbi] resume: no session captured, starting fresh\n`));
```
Replace with:
```typescript
onBytes(Buffer.from(fbi.status('resume: no session captured, starting fresh')));
```

Find (line ~702):
```typescript
onBytes(Buffer.from(`\n[fbi] resume error: ${msg}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.fatal(`resume error: ${msg}`)));
```

- [ ] **Step 2: Replace continue messages**

Find (line ~726):
```typescript
onBytes(Buffer.from(`\n[fbi] continuing from session ${run.claude_session_id}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.status(`continuing from session ${run.claude_session_id}`)));
```

Find (line ~783):
```typescript
onBytes(Buffer.from(`\n[fbi] continue error: ${msg}\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.fatal(`continue error: ${msg}`)));
```

- [ ] **Step 3: Replace restart and devcontainer messages**

Find (line ~1027):
```typescript
onBytes(Buffer.from(`\n[fbi] reattached after orchestrator restart\n`));
```
Replace with:
```typescript
onBytes(Buffer.from('\n' + fbi.status('reattached after orchestrator restart')));
```

Find (line ~1305):
```typescript
onLog(Buffer.from(`[fbi] using repo .devcontainer/devcontainer.json\n`))
```
Replace with:
```typescript
onLog(Buffer.from(fbi.status('using repo .devcontainer/devcontainer.json')))
```

- [ ] **Step 4: Verify no [fbi] strings remain in index.ts**

```bash
grep '\[fbi\]' /workspace/src/server/orchestrator/index.ts
```

Expected: no output.

- [ ] **Step 5: Type-check**

```bash
cd /workspace && npx tsc -p tsconfig.server.json --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator/index.ts
git commit -m "feat(orchestrator): style resume, continue, and restart messages"
```

---

### Task 5: Upgrade _fbi_cmd in supervisor.sh and update call sites

**Files:**
- Modify: `src/server/orchestrator/supervisor.sh`

`_fbi_cmd` currently takes a single string and colors it all cyan. The new version accepts two arguments: `verb` (cyan) and `path/ref` (purple). All six call sites are updated to split the command from its arguments.

- [ ] **Step 1: Replace the _fbi_cmd definition**

Find:
```bash
_fbi_cmd()    { printf '\033[32m$\033[0m  \033[36m%s\033[0m\n' "$*"; }
```

Replace with:
```bash
_fbi_cmd()    {
  local verb="$1"; shift
  if [ $# -gt 0 ]; then
    printf '\033[32m$\033[0m  \033[36m%s\033[0m \033[35m%s\033[0m\n' "$verb" "$*"
  else
    printf '\033[32m$\033[0m  \033[36m%s\033[0m\n' "$verb"
  fi
}
```

- [ ] **Step 2: Update the git clone call site**

Find:
```bash
_fbi_cmd "git clone $REPO_URL ."
```
Replace with:
```bash
_fbi_cmd "git clone" "$REPO_URL ."
```

- [ ] **Step 3: Update the resume-mode checkout call site**

Find:
```bash
_fbi_cmd "git checkout -B $PRIMARY_BRANCH safeguard/$PRIMARY_BRANCH"
```
Replace with:
```bash
_fbi_cmd "git checkout -B" "$PRIMARY_BRANCH safeguard/$PRIMARY_BRANCH"
```

- [ ] **Step 4: Update the origin checkout call site**

Find:
```bash
_fbi_cmd "git checkout -B $PRIMARY_BRANCH origin/$PRIMARY_BRANCH"
```
Replace with:
```bash
_fbi_cmd "git checkout -B" "$PRIMARY_BRANCH origin/$PRIMARY_BRANCH"
```

- [ ] **Step 5: Update the new-branch checkout call site**

Find:
```bash
_fbi_cmd "git checkout -b $PRIMARY_BRANCH"
```
Replace with:
```bash
_fbi_cmd "git checkout -b" "$PRIMARY_BRANCH"
```

- [ ] **Step 6: Update the push call site**

Find:
```bash
_fbi_cmd "git push -u origin $PRIMARY_BRANCH"
```
Replace with:
```bash
_fbi_cmd "git push -u" "origin $PRIMARY_BRANCH"
```

- [ ] **Step 7: Syntax check**

```bash
bash -n src/server/orchestrator/supervisor.sh
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/server/orchestrator/supervisor.sh
git commit -m "feat(supervisor): split _fbi_cmd into verb+path for purple path coloring"
```
