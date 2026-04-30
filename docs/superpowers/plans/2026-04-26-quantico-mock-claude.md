# Quantico Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build *Quantico*, a Rust binary that impersonates the `claude` CLI for FBI's testing surfaces (terminal/auto-resume/env propagation), plus the orchestrator, UI, and Playwright test layer that wire it into the product behind a capability flag.

**Architecture:** A new workspace crate `cli/quantico/` builds a single Rust binary. When a run row has `mock=true` (only allowed if the server-wide `FBI_QUANTICO_ENABLED=1` capability flag is set), both orchestrators (TS and Elixir) bind-mount the binary over `/usr/local/bin/claude` inside the container, set `MOCK_CLAUDE_SCENARIO`/`MOCK_CLAUDE_SPEED_MULT`, and skip the host OAuth bind. `supervisor.sh` is unchanged. A reusable TS helper at `tests/e2e/quantico/helpers.ts` plus eight Playwright specs cover the key code paths in CI.

**Tech Stack:** Rust 2021 (cargo workspace, `serde`, `serde_yaml`, `clap`, `uuid`); TypeScript (Node/Fastify + React + Vitest + Playwright); Elixir (Phoenix + ExUnit); SQLite; Docker.

**Spec:** `docs/superpowers/specs/2026-04-26-quantico-mock-claude-design.md`

---

## File structure overview

**New crate (Rust):**
- `cli/quantico/Cargo.toml` — crate manifest
- `cli/quantico/Makefile` — cross-compile (mirrors `cli/fbi-tunnel/Makefile`)
- `cli/quantico/src/main.rs` — entry; routes `plugin …` vs interactive run
- `cli/quantico/src/argv.rs` — argv parser
- `cli/quantico/src/scenario.rs` — Scenario YAML model + parser + library lookup
- `cli/quantico/src/executor.rs` — step runner
- `cli/quantico/src/jsonl.rs` — session JSONL writer
- `cli/quantico/src/limit.rs` — limit-message emitter (must match the existing detector regex)
- `cli/quantico/src/prompt_token.rs` — `@quantico:<name>@` scanner
- `cli/quantico/src/corpus.rs` — embedded lorem prose
- `cli/quantico/scenarios/*.yaml` — 12 named scenarios (one file each)
- `cli/quantico/scenarios.json` — generated list of scenario names; committed; both servers read it

**TS server changes:**
- `src/server/db/schema.sql` — add `mock` and `mock_scenario` columns
- `src/server/db/index.ts` — ALTER TABLE shims for upgraded DBs
- `src/server/db/runs.ts` — accept new fields in `create()`
- `src/server/api/runs.ts` — validate `mock` body fields
- `src/server/api/quantico.ts` — new `GET /api/quantico/scenarios` route (created)
- `src/server/api/index.ts` — register the new router
- `src/server/config.ts` — `quanticoEnabled`, `quanticoBinaryPath`, `limitMonitorIdleMs`, `limitMonitorWarmupMs`
- `src/server/orchestrator/index.ts` — bind logic + OAuth-bind skip + env vars
- `src/server/orchestrator/limitMonitor.ts` — already takes opts; constructor caller passes from config

**Elixir server changes:**
- `server-elixir/priv/repo/migrations/20260426000001_add_runs_mock_columns.exs` (created)
- `server-elixir/lib/fbi/runs/run.ex` — add fields
- `server-elixir/lib/fbi/runs/queries.ex` — `@all_fields` + `decode/1`
- `server-elixir/lib/fbi_web/controllers/runs_controller.ex` — accept + validate
- `server-elixir/lib/fbi_web/controllers/quantico_controller.ex` (created)
- `server-elixir/lib/fbi_web/router.ex` — route + scope
- `server-elixir/lib/fbi/orchestrator/run_server.ex` — bind + env + skip OAuth + banner
- `server-elixir/lib/fbi/orchestrator/limit_monitor.ex` — env-tunable opts
- `server-elixir/config/runtime.exs` — read `FBI_QUANTICO_ENABLED`, etc.

**UI changes:**
- `src/web/components/MockModeCollapse.tsx` (created) — mirrors `ModelParamsCollapse`
- `src/web/components/MockModeCollapse.test.tsx` (created)
- `src/web/lib/api.ts` — extend `createRun`, add `fetchQuanticoScenarios`
- `src/web/pages/NewRun.tsx` — render the new section conditionally

**Tests:**
- `playwright.config.ts` (created)
- `tests/e2e/quantico/helpers.ts` (created)
- 8 Playwright specs under `tests/e2e/quantico/`
- `.github/workflows/ci.yml` — add `cargo test -p quantico` + new `e2e-quantico` job
- `.github/workflows/quantico-fidelity.yml` (created) — weekly cron, real-Claude snapshot probe

**Build / install:**
- `Cargo.toml` (root) — add `cli/quantico` to workspace members
- `package.json` — `cli:quantico:*` scripts; `@playwright/test` devDep; `e2e` script
- `scripts/build-cli-dist.sh` — build Quantico too
- `scripts/install.sh` — copy binary to `/usr/local/lib/fbi/quantico` when capability is on

---

## Conventions for every task

- **Always work in `/workspace`** (`cd /workspace && …` for git, per CLAUDE.md).
- **Commit per task.** Small, focused, message follows existing `type(scope): subject` style.
- **Never push to `main`.** Stay on `feat/test-framework`.
- **TDD where the unit is testable in isolation.** Red → green → commit. For glue tasks (e.g., a UI form wiring), write the integration test first when feasible; otherwise write the test in the same task.
- **`replace_all` is dangerous.** Use exact context for `Edit` calls.
- **Run the relevant test suite before committing**, even when the task adds nothing testable on its own. Catches accidental regressions immediately.

---

## Phase 0 — Workspace scaffolding

### Task 1: Create the Quantico crate skeleton

**Files:**
- Create: `cli/quantico/Cargo.toml`
- Create: `cli/quantico/src/main.rs`
- Create: `cli/quantico/Makefile`
- Modify: `Cargo.toml` (workspace members)

- [ ] **Step 1: Create `cli/quantico/Cargo.toml`**

```toml
[package]
name = "quantico"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "quantico"
path = "src/main.rs"

[dependencies]
clap = { version = "4", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_yaml = "0.9"
serde_json = "1"
uuid = { version = "1", features = ["v4"] }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Create the placeholder `cli/quantico/src/main.rs`**

```rust
fn main() {
    eprintln!("quantico: not yet implemented");
    std::process::exit(2);
}
```

- [ ] **Step 3: Create `cli/quantico/Makefile`** (copy from `cli/fbi-tunnel/Makefile` and substitute the binary name)

```makefile
.PHONY: build test install clean

DIST := dist
TARGETS := \
  aarch64-apple-darwin \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu \
  aarch64-unknown-linux-gnu

WORKSPACE_TARGET := $(shell cargo metadata --no-deps --format-version 1 | python3 -c "import sys,json; print(json.load(sys.stdin)['target_directory'])")

build:
	@mkdir -p $(DIST)
	@for target in $(TARGETS); do \
	  echo "building $$target..."; \
	  cargo build --release --target $$target -p quantico; \
	  cp $(WORKSPACE_TARGET)/$$target/release/quantico $(DIST)/quantico-$$target; \
	done

test:
	cargo test -p quantico

install:
	cargo install --path . --force

clean:
	rm -rf $(DIST)
```

- [ ] **Step 4: Add Quantico to root workspace**

Edit `Cargo.toml`:

```toml
[workspace]
members = ["desktop", "cli/fbi-tunnel", "cli/quantico"]
resolver = "2"
```

- [ ] **Step 5: Verify it builds**

Run: `cargo build -p quantico`
Expected: succeeds; produces `target/debug/quantico`. Run `target/debug/quantico` — exits 2 with `quantico: not yet implemented`.

- [ ] **Step 6: Commit**

```bash
cd /workspace && git add Cargo.toml cli/quantico/ && git commit -m "feat(quantico): scaffold crate skeleton"
```

---

### Task 2: Hook Quantico into Rust CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Extend the existing Rust test step**

Find the line `run: cargo test -p fbi-tunnel` in `.github/workflows/ci.yml` and replace with two lines so both crates run:

```yaml
      - name: Test
        run: |
          cargo test -p fbi-tunnel
          cargo test -p quantico
```

- [ ] **Step 2: Commit**

```bash
cd /workspace && git add .github/workflows/ci.yml && git commit -m "ci(quantico): run cargo test -p quantico in Rust CI job"
```

---

## Phase 1 — Quantico core (TDD)

### Task 3: Scenario YAML schema + parser

**Files:**
- Create: `cli/quantico/src/scenario.rs`
- Modify: `cli/quantico/src/main.rs` (just `mod scenario;`)

- [ ] **Step 1: Write the failing test**

Create `cli/quantico/src/scenario.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Emit(String),
    EmitAnsi(String),
    SleepMs(u64),
    Exit(i32),
    SleepForever,
    EchoEnv(Vec<String>),
    EmitLimitBreach { reset_epoch: String },
    WriteJsonl { #[serde(rename = "type")] kind: String, content: String },
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct Scenario {
    pub name: String,
    pub steps: Vec<Step>,
}

impl Scenario {
    pub fn parse(yaml: &str) -> Result<Self, String> {
        serde_yaml::from_str(yaml).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_scenario() {
        let yaml = r#"
name: simple
steps:
  - emit: "hello\n"
  - sleep_ms: 100
  - exit: 0
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(s.name, "simple");
        assert_eq!(s.steps.len(), 3);
        assert_eq!(s.steps[0], Step::Emit("hello\n".into()));
        assert_eq!(s.steps[1], Step::SleepMs(100));
        assert_eq!(s.steps[2], Step::Exit(0));
    }

    #[test]
    fn parses_limit_breach_step() {
        let yaml = r#"
name: lb
steps:
  - emit_limit_breach:
      reset_epoch: "+1h"
"#;
        let s = Scenario::parse(yaml).unwrap();
        assert_eq!(
            s.steps[0],
            Step::EmitLimitBreach { reset_epoch: "+1h".into() }
        );
    }

    #[test]
    fn rejects_unknown_step_type() {
        let yaml = r#"
name: bad
steps:
  - frobnicate: 1
"#;
        assert!(Scenario::parse(yaml).is_err());
    }
}
```

Add `mod scenario;` to `cli/quantico/src/main.rs` above `fn main`.

- [ ] **Step 2: Verify the tests fail to compile (no `serde_yaml`)**

Run: `cd /workspace && cargo test -p quantico`
Expected: tests don't even compile until deps are present — they were declared in Task 1, so this should compile and pass directly. Run the command; expect three passing tests.

If a test fails (e.g., wrong variant name), fix the implementation in `scenario.rs` until the three tests pass.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add cli/quantico/src/ && git commit -m "feat(quantico): scenario YAML schema + parser"
```

---

### Task 4: Argv parser

**Files:**
- Create: `cli/quantico/src/argv.rs`
- Modify: `cli/quantico/src/main.rs` (just `mod argv;`)

- [ ] **Step 1: Write the failing test**

Create `cli/quantico/src/argv.rs`:

```rust
#[derive(Debug, PartialEq)]
pub enum Invocation {
    Run {
        scenario: Option<String>,
        scenario_file: Option<String>,
        resume_session_id: Option<String>,
    },
    PluginMarketplaceAdd(String),
    PluginInstall(String),
    Unsupported(String),
}

pub fn parse(args: &[String]) -> Invocation {
    // args: argv excluding the program name.
    let mut iter = args.iter().peekable();
    let first = match iter.peek() {
        Some(s) => s.as_str(),
        None => return Invocation::Run {
            scenario: None, scenario_file: None, resume_session_id: None,
        },
    };

    if first == "plugin" {
        iter.next();
        match iter.next().map(String::as_str) {
            Some("marketplace") if iter.next().map(String::as_str) == Some("add") => {
                let name = iter.next().cloned().unwrap_or_default();
                return Invocation::PluginMarketplaceAdd(name);
            }
            Some("install") => {
                let name = iter.next().cloned().unwrap_or_default();
                return Invocation::PluginInstall(name);
            }
            other => return Invocation::Unsupported(format!("plugin {:?}", other)),
        }
    }

    let mut scenario = None;
    let mut scenario_file = None;
    let mut resume_session_id = None;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--dangerously-skip-permissions" => {}
            "--resume" => {
                resume_session_id = iter.next().cloned();
            }
            "--scenario" => {
                scenario = iter.next().cloned();
            }
            "--scenario-file" => {
                scenario_file = iter.next().cloned();
            }
            other => return Invocation::Unsupported(other.to_string()),
        }
    }
    Invocation::Run { scenario, scenario_file, resume_session_id }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fresh_run() {
        assert_eq!(
            parse(&argv(&["--dangerously-skip-permissions"])),
            Invocation::Run { scenario: None, scenario_file: None, resume_session_id: None }
        );
    }

    #[test]
    fn resume_flag() {
        assert_eq!(
            parse(&argv(&["--resume", "abc-123", "--dangerously-skip-permissions"])),
            Invocation::Run {
                scenario: None,
                scenario_file: None,
                resume_session_id: Some("abc-123".into()),
            }
        );
    }

    #[test]
    fn scenario_flag() {
        assert_eq!(
            parse(&argv(&["--scenario", "limit-breach", "--dangerously-skip-permissions"])),
            Invocation::Run {
                scenario: Some("limit-breach".into()),
                scenario_file: None,
                resume_session_id: None,
            }
        );
    }

    #[test]
    fn plugin_marketplace_add() {
        assert_eq!(
            parse(&argv(&["plugin", "marketplace", "add", "foo/bar"])),
            Invocation::PluginMarketplaceAdd("foo/bar".into())
        );
    }

    #[test]
    fn plugin_install() {
        assert_eq!(
            parse(&argv(&["plugin", "install", "name@source"])),
            Invocation::PluginInstall("name@source".into())
        );
    }

    #[test]
    fn unsupported_flag() {
        match parse(&argv(&["--something-weird"])) {
            Invocation::Unsupported(_) => {}
            other => panic!("expected Unsupported, got {:?}", other),
        }
    }
}
```

Add `mod argv;` to `main.rs`.

- [ ] **Step 2: Run the tests**

Run: `cd /workspace && cargo test -p quantico --lib argv`
Expected: 6 passing.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add cli/quantico/src/argv.rs cli/quantico/src/main.rs && git commit -m "feat(quantico): argv parser"
```

---

### Task 5: Executor for emit / sleep / exit / echo_env

**Files:**
- Create: `cli/quantico/src/executor.rs`
- Modify: `cli/quantico/src/main.rs`

- [ ] **Step 1: Write the failing test**

Create `cli/quantico/src/executor.rs`:

```rust
use crate::scenario::{Scenario, Step};
use std::io::Write;

pub struct ExecCtx<'a, W: Write> {
    pub stdout: &'a mut W,
    pub speed_mult: f64, // wall-time = sleep_ms / speed_mult
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub cwd: String,
    pub argv: Vec<String>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Exited(i32),
    SleepingForever,
}

pub fn run<W: Write>(scenario: &Scenario, ctx: &mut ExecCtx<W>) -> std::io::Result<Outcome> {
    for step in &scenario.steps {
        match step {
            Step::Emit(s) | Step::EmitAnsi(s) => {
                ctx.stdout.write_all(s.as_bytes())?;
                ctx.stdout.flush()?;
            }
            Step::SleepMs(ms) => {
                let real_ms = (*ms as f64 / ctx.speed_mult).max(0.0) as u64;
                std::thread::sleep(std::time::Duration::from_millis(real_ms));
            }
            Step::Exit(code) => return Ok(Outcome::Exited(*code)),
            Step::SleepForever => return Ok(Outcome::SleepingForever),
            Step::EchoEnv(vars) => {
                writeln!(ctx.stdout, "[quantico] cwd={}", ctx.cwd)?;
                writeln!(ctx.stdout, "[quantico] argv: {}", ctx.argv.join(" "))?;
                for v in vars {
                    let val = (ctx.env)(v).unwrap_or_default();
                    writeln!(ctx.stdout, "[quantico] env.{}={}", v, val)?;
                }
                ctx.stdout.flush()?;
            }
            // Other steps (jsonl, limit) added in later tasks.
            _ => {
                writeln!(ctx.stdout, "[quantico] step not yet implemented: {:?}", step)?;
            }
        }
    }
    Ok(Outcome::Exited(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Step;

    fn fake_env(_: &str) -> Option<String> { None }

    fn ctx<'a, W: Write>(out: &'a mut W) -> ExecCtx<'a, W> {
        ExecCtx {
            stdout: out,
            speed_mult: 1.0,
            env: &fake_env,
            cwd: "/workspace".into(),
            argv: vec!["--dangerously-skip-permissions".into()],
        }
    }

    #[test]
    fn emits_text_then_exits() {
        let scenario = Scenario {
            name: "t".into(),
            steps: vec![Step::Emit("hi\n".into()), Step::Exit(0)],
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut c = ctx(&mut buf);
        let outcome = run(&scenario, &mut c).unwrap();
        assert_eq!(outcome, Outcome::Exited(0));
        assert_eq!(String::from_utf8(buf).unwrap(), "hi\n");
    }

    #[test]
    fn sleep_ms_scales_with_speed_mult() {
        let scenario = Scenario {
            name: "t".into(),
            steps: vec![Step::SleepMs(200)],
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut c = ctx(&mut buf);
        c.speed_mult = 100.0;
        let start = std::time::Instant::now();
        run(&scenario, &mut c).unwrap();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 100, "expected <100ms sped up, got {}ms", elapsed);
    }

    #[test]
    fn echo_env_emits_block() {
        fn env(name: &str) -> Option<String> {
            if name == "RUN_ID" { Some("42".into()) } else { None }
        }
        let scenario = Scenario {
            name: "t".into(),
            steps: vec![Step::EchoEnv(vec!["RUN_ID".into(), "MISSING".into()]), Step::Exit(0)],
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut c = ExecCtx {
            stdout: &mut buf,
            speed_mult: 1.0,
            env: &env,
            cwd: "/workspace".into(),
            argv: vec![],
        };
        run(&scenario, &mut c).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.contains("[quantico] env.RUN_ID=42"));
        assert!(s.contains("[quantico] env.MISSING="));
    }
}
```

Add `mod executor;` to `main.rs`.

- [ ] **Step 2: Run the tests**

Run: `cd /workspace && cargo test -p quantico --lib executor`
Expected: 3 passing.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add cli/quantico/src/executor.rs cli/quantico/src/main.rs && git commit -m "feat(quantico): executor for emit/sleep/exit/echo_env"
```

---

### Task 6: Built-in scenarios `default` and `env-echo`

**Files:**
- Create: `cli/quantico/scenarios/default.yaml`
- Create: `cli/quantico/scenarios/env-echo.yaml`
- Modify: `cli/quantico/src/scenario.rs`

- [ ] **Step 1: Create `cli/quantico/scenarios/default.yaml`**

```yaml
name: default
steps:
  - emit_ansi: "\x1b[1;36m○\x1b[0m thinking…\n"
  - sleep_ms: 800
  - emit: "I'll work through this carefully.\n"
  - sleep_ms: 600
  - emit: "First, I need to understand the structure.\n"
  - sleep_ms: 600
  - emit_ansi: "\x1b[2m  Read(src/index.ts)\x1b[0m\n"
  - sleep_ms: 400
  - emit: "Now let me check how it's used elsewhere.\n"
  - sleep_ms: 400
  - emit_ansi: "\x1b[2m  Bash($ rg --hidden 'thing')\x1b[0m\n"
  - sleep_ms: 600
  - emit: "Done.\n"
  - exit: 0
```

- [ ] **Step 2: Create `cli/quantico/scenarios/env-echo.yaml`**

```yaml
name: env-echo
steps:
  - echo_env:
      - RUN_ID
      - FBI_BRANCH
      - GIT_AUTHOR_NAME
      - GIT_AUTHOR_EMAIL
      - FBI_RESUME_SESSION_ID
      - FBI_MARKETPLACES
      - FBI_PLUGINS
      - MOCK_CLAUDE_SCENARIO
      - MOCK_CLAUDE_SPEED_MULT
  - exit: 0
```

- [ ] **Step 3: Add `lookup` to `scenario.rs`**

Append to `cli/quantico/src/scenario.rs`:

```rust
const DEFAULT_YAML: &str = include_str!("../scenarios/default.yaml");
const ENV_ECHO_YAML: &str = include_str!("../scenarios/env-echo.yaml");

pub fn lookup(name: &str) -> Option<Scenario> {
    let yaml = match name {
        "default" => DEFAULT_YAML,
        "env-echo" => ENV_ECHO_YAML,
        _ => return None,
    };
    Some(Scenario::parse(yaml).expect("built-in scenario must parse"))
}

pub const BUILT_IN_NAMES: &[&str] = &["default", "env-echo"];

#[cfg(test)]
mod lookup_tests {
    use super::*;

    #[test]
    fn default_is_present_and_parses() {
        let s = lookup("default").expect("default exists");
        assert_eq!(s.name, "default");
        assert!(!s.steps.is_empty());
    }

    #[test]
    fn env_echo_is_present_and_parses() {
        let s = lookup("env-echo").expect("env-echo exists");
        assert_eq!(s.name, "env-echo");
    }

    #[test]
    fn unknown_returns_none() {
        assert!(lookup("nope").is_none());
    }

    #[test]
    fn built_in_names_all_resolve() {
        for n in BUILT_IN_NAMES {
            assert!(lookup(n).is_some(), "built-in {} did not resolve", n);
        }
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /workspace && cargo test -p quantico`
Expected: all tests pass (parser, argv, executor, lookup).

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add cli/quantico/scenarios/ cli/quantico/src/scenario.rs && git commit -m "feat(quantico): built-in scenarios default + env-echo"
```

---

### Task 7: Wire `main.rs` end-to-end

**Files:**
- Modify: `cli/quantico/src/main.rs`

- [ ] **Step 1: Replace `main.rs` with the wired version**

Overwrite `cli/quantico/src/main.rs`:

```rust
mod argv;
mod executor;
mod scenario;

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = argv::parse(&args);
    let exit_code = match invocation {
        argv::Invocation::PluginMarketplaceAdd(name) => {
            println!("[quantico] marketplace added: {}", name);
            0
        }
        argv::Invocation::PluginInstall(name) => {
            println!("[quantico] plugin installed: {}", name);
            0
        }
        argv::Invocation::Unsupported(arg) => {
            eprintln!("quantico: unsupported argument: {}", arg);
            2
        }
        argv::Invocation::Run { scenario: name, scenario_file, resume_session_id: _ } => {
            run_scenario(name.as_deref(), scenario_file.as_deref())
        }
    };
    std::process::exit(exit_code);
}

fn run_scenario(name: Option<&str>, scenario_file: Option<&str>) -> i32 {
    let scenario = if let Some(path) = scenario_file {
        match std::fs::read_to_string(path) {
            Ok(yaml) => match scenario::Scenario::parse(&yaml) {
                Ok(s) => s,
                Err(e) => { eprintln!("quantico: bad scenario file: {}", e); return 2; }
            },
            Err(e) => { eprintln!("quantico: cannot read scenario file: {}", e); return 2; }
        }
    } else {
        let n = name.unwrap_or("default");
        match scenario::lookup(n) {
            Some(s) => s,
            None => { eprintln!("quantico: unknown scenario: {}", n); return 2; }
        }
    };

    let speed_mult: f64 = std::env::var("MOCK_CLAUDE_SPEED_MULT")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(1.0);
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string()).unwrap_or_else(|_| "?".into());
    let argv: Vec<String> = std::env::args().skip(1).collect();

    let env_get = |k: &str| std::env::var(k).ok();
    let mut stdout = std::io::stdout();
    let mut ctx = executor::ExecCtx {
        stdout: &mut stdout,
        speed_mult,
        env: &env_get,
        cwd,
        argv,
    };
    match executor::run(&scenario, &mut ctx) {
        Ok(executor::Outcome::Exited(c)) => c,
        Ok(executor::Outcome::SleepingForever) => {
            // Block forever (until SIGKILL). SIGTERM honoured by default.
            loop { std::thread::park(); }
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "quantico: io error: {}", e);
            1
        }
    }
}
```

- [ ] **Step 2: Smoke-test by hand**

Run: `cd /workspace && cargo build -p quantico --release && MOCK_CLAUDE_SPEED_MULT=10 ./target/release/quantico --dangerously-skip-permissions`
Expected: prints the default scenario's lines (sped up), exits 0.

Run: `MOCK_CLAUDE_SPEED_MULT=10 RUN_ID=42 ./target/release/quantico --scenario env-echo --dangerously-skip-permissions`
Expected: `[quantico] env.RUN_ID=42` line appears; exits 0.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add cli/quantico/src/main.rs && git commit -m "feat(quantico): wire main.rs to scenario library + speed mult"
```

---

## Phase 2 — Quantico full feature set

### Task 8: JSONL writer step

**Files:**
- Create: `cli/quantico/src/jsonl.rs`
- Modify: `cli/quantico/src/scenario.rs` (`Step::WriteJsonl` already exists; we now implement the executor branch)
- Modify: `cli/quantico/src/executor.rs`
- Modify: `cli/quantico/src/main.rs` (`mod jsonl;`)

- [ ] **Step 1: Write the failing test**

Create `cli/quantico/src/jsonl.rs`:

```rust
use std::io::Write;
use std::path::PathBuf;

/// Returns the JSONL path Claude would write for the current cwd + session id.
/// Format mirrors real Claude: `$HOME/.claude/projects/<encoded-cwd>/<session>.jsonl`.
/// Encoded cwd: `/` → `-`, leading `-` preserved (so `/workspace` → `-workspace`).
pub fn session_path(home: &str, cwd: &str, session_id: &str) -> PathBuf {
    let encoded = cwd.replace('/', "-");
    PathBuf::from(home).join(".claude/projects").join(encoded).join(format!("{}.jsonl", session_id))
}

pub fn append(path: &PathBuf, kind: &str, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    let entry = serde_json::json!({
        "type": kind,
        "timestamp": chrono_iso(),
        "content": content,
    });
    writeln!(f, "{}", entry)?;
    Ok(())
}

fn chrono_iso() -> String {
    // Plain RFC3339-ish without depending on chrono. Sufficient for shape, not parsing.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    format!("epoch:{}", secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn session_path_matches_real_claude_layout() {
        let p = session_path("/home/agent", "/workspace", "abc-123");
        assert_eq!(
            p.to_string_lossy(),
            "/home/agent/.claude/projects/-workspace/abc-123.jsonl"
        );
    }

    #[test]
    fn append_writes_one_line_per_call() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, "user", "hello").unwrap();
        append(&path, "assistant", "world").unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 2);
        for line in contents.lines() {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            assert!(v["type"].is_string());
            assert!(v["timestamp"].is_string());
            assert!(v["content"].is_string());
        }
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cd /workspace && cargo test -p quantico --lib jsonl`
Expected: 2 passing.

- [ ] **Step 3: Wire `WriteJsonl` into the executor**

Edit `cli/quantico/src/executor.rs`. Replace the `_ =>` arm with explicit handling:

Add a `session_path: PathBuf` field to `ExecCtx` (alongside cwd, etc.), then handle `Step::WriteJsonl`:

```rust
Step::WriteJsonl { kind, content } => {
    crate::jsonl::append(&ctx.session_path, kind, content)?;
}
```

Update the test helper `ctx()` and other constructions accordingly. Add a unit test for the wired step:

```rust
#[test]
fn write_jsonl_step_creates_file() {
    use tempfile::tempdir;
    let dir = tempdir().unwrap();
    let path = dir.path().join("s.jsonl");
    let scenario = Scenario {
        name: "t".into(),
        steps: vec![
            Step::WriteJsonl { kind: "user".into(), content: "hi".into() },
            Step::Exit(0),
        ],
    };
    let mut buf: Vec<u8> = Vec::new();
    let mut c = ExecCtx {
        stdout: &mut buf, speed_mult: 1.0, env: &|_| None,
        cwd: "/workspace".into(), argv: vec![],
        session_path: path.clone(),
    };
    run(&scenario, &mut c).unwrap();
    assert!(path.exists());
    assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
}
```

- [ ] **Step 4: Run all tests**

Run: `cd /workspace && cargo test -p quantico`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add cli/quantico/src/ && git commit -m "feat(quantico): JSONL writer step + path matches real Claude layout"
```

---

### Task 9: Limit-breach step (must match the existing detector regex)

**Files:**
- Create: `cli/quantico/src/limit.rs`
- Modify: `cli/quantico/src/executor.rs`
- Modify: `cli/quantico/src/main.rs`

The detector regex is `Claude usage limit reached\|(\d+)` (see `server-elixir/lib/fbi/orchestrator/resume_detector.ex:7`). The literal byte sequence must be `Claude usage limit reached|<epoch>\n`.

- [ ] **Step 1: Write the failing test**

Create `cli/quantico/src/limit.rs`:

```rust
/// Computes the absolute epoch second from a relative (e.g., "+1h") or absolute spec.
pub fn resolve_reset_epoch(now_secs: u64, spec: &str) -> u64 {
    if let Some(rest) = spec.strip_prefix('+') {
        if let Some(num) = rest.strip_suffix('s') { return now_secs + num.parse::<u64>().unwrap_or(0); }
        if let Some(num) = rest.strip_suffix('m') { return now_secs + 60 * num.parse::<u64>().unwrap_or(0); }
        if let Some(num) = rest.strip_suffix('h') { return now_secs + 3600 * num.parse::<u64>().unwrap_or(0); }
        return now_secs + rest.parse::<u64>().unwrap_or(0);
    }
    spec.parse::<u64>().unwrap_or(now_secs)
}

/// The literal byte sequence the detector matches.
pub fn breach_line(epoch: u64) -> String {
    format!("Claude usage limit reached|{}\n", epoch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::Regex;

    #[test]
    fn line_matches_detector_regex() {
        let re = Regex::new(r"Claude usage limit reached\|(\d+)").unwrap();
        let line = breach_line(1_700_000_000);
        let caps = re.captures(&line).expect("must match");
        assert_eq!(&caps[1], "1700000000");
    }

    #[test]
    fn relative_hour_spec() {
        assert_eq!(resolve_reset_epoch(100, "+1h"), 100 + 3600);
    }

    #[test]
    fn relative_minute_spec() {
        assert_eq!(resolve_reset_epoch(100, "+30m"), 100 + 1800);
    }

    #[test]
    fn absolute_spec() {
        assert_eq!(resolve_reset_epoch(100, "999"), 999);
    }
}
```

Add `regex = "1"` to `[dev-dependencies]` in `cli/quantico/Cargo.toml`.

Add `mod limit;` to `main.rs`.

- [ ] **Step 2: Run the test**

Run: `cd /workspace && cargo test -p quantico --lib limit`
Expected: 4 passing.

- [ ] **Step 3: Wire into executor**

In `cli/quantico/src/executor.rs`, add:

```rust
Step::EmitLimitBreach { reset_epoch } => {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let epoch = crate::limit::resolve_reset_epoch(now, reset_epoch);
    let line = crate::limit::breach_line(epoch);
    ctx.stdout.write_all(line.as_bytes())?;
    ctx.stdout.flush()?;
}
```

- [ ] **Step 4: Run all tests**

Run: `cd /workspace && cargo test -p quantico`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add cli/quantico/ && git commit -m "feat(quantico): emit_limit_breach step matches existing detector regex"
```

---

### Task 10: Resume handling — emit marker, error if session JSONL missing

**Files:**
- Modify: `cli/quantico/src/main.rs`

- [ ] **Step 1: Update `run_scenario` to honour `--resume`**

In `main.rs`, change the `Invocation::Run` arm to receive `resume_session_id`, and change `run_scenario` accordingly:

```rust
fn run_scenario(name: Option<&str>, scenario_file: Option<&str>, resume_session_id: Option<&str>) -> i32 {
    let scenario = /* ... unchanged ... */;
    let speed_mult: f64 = /* ... unchanged ... */;
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "?".into());
    let argv: Vec<String> = std::env::args().skip(1).collect();

    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/agent".into());
    let session_id = match resume_session_id {
        Some(id) => {
            let path = jsonl::session_path(&home, &cwd, id);
            if !path.exists() {
                eprintln!("Error: session {} not found", id);
                return 1;
            }
            id.to_string()
        }
        None => uuid::Uuid::new_v4().to_string(),
    };
    let session_path = jsonl::session_path(&home, &cwd, &session_id);
    if let Some(parent) = session_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if resume_session_id.is_some() {
        let _ = writeln!(std::io::stdout(), "[quantico] resumed from {}", session_id);
    }

    let env_get = |k: &str| std::env::var(k).ok();
    let mut stdout = std::io::stdout();
    let mut ctx = executor::ExecCtx {
        stdout: &mut stdout, speed_mult, env: &env_get, cwd, argv, session_path,
    };
    /* ...rest unchanged... */
}
```

Also update the call site in `main()` to pass `resume_session_id.as_deref()`.

- [ ] **Step 2: Smoke-test resume**

Run from `/workspace`:

```bash
cd /workspace && cargo build -p quantico --release && \
  HOME=/tmp ./target/release/quantico --resume nonexistent --dangerously-skip-permissions; \
  echo "exit=$?"
```

Expected: prints `Error: session nonexistent not found`, exits 1.

```bash
mkdir -p /tmp/.claude/projects/-workspace && \
  echo '{"type":"user","content":"x","timestamp":"x"}' > /tmp/.claude/projects/-workspace/abc.jsonl && \
  HOME=/tmp MOCK_CLAUDE_SPEED_MULT=10 ./target/release/quantico --resume abc --scenario env-echo --dangerously-skip-permissions
```

Expected: prints `[quantico] resumed from abc`, then env-echo block; exits 0.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add cli/quantico/src/main.rs && git commit -m "feat(quantico): --resume honours session JSONL presence"
```

---

### Task 11: Prompt-token scanner

**Files:**
- Create: `cli/quantico/src/prompt_token.rs`
- Modify: `cli/quantico/src/main.rs`

- [ ] **Step 1: Write the failing test**

Create `cli/quantico/src/prompt_token.rs`:

```rust
use regex::Regex;

/// Returns the scenario name from the first `@quantico:<name>@` token, if any.
pub fn extract(prompt: &str) -> Option<String> {
    let re = Regex::new(r"@quantico:([a-zA-Z0-9_-]+)@").unwrap();
    re.captures(prompt).map(|c| c[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_token() {
        assert_eq!(extract("hi @quantico:limit-breach@ thanks"), Some("limit-breach".into()));
    }

    #[test]
    fn missing() {
        assert_eq!(extract("just a prompt"), None);
    }

    #[test]
    fn first_token_wins() {
        assert_eq!(extract("a @quantico:default@ b @quantico:other@"), Some("default".into()));
    }
}
```

Move `regex` from `[dev-dependencies]` to `[dependencies]` in `cli/quantico/Cargo.toml`.

Add `mod prompt_token;` to `main.rs`.

- [ ] **Step 2: Run the tests**

Run: `cd /workspace && cargo test -p quantico --lib prompt_token`
Expected: 3 passing.

- [ ] **Step 3: Wire into `main.rs` resolution order**

When `Invocation::Run` lands and no `scenario_file` is supplied, read all of stdin (only when stdin is not a TTY — supervisor pipes the prompt in fresh runs), scan for the token, and let it override `--scenario`. Use `atty`-style detection via `IsTerminal`:

```rust
use std::io::{IsTerminal, Read};

let mut prompt_text = String::new();
if !std::io::stdin().is_terminal() {
    let _ = std::io::stdin().read_to_string(&mut prompt_text);
}
let token_scenario = prompt_token::extract(&prompt_text);
let chosen_name = scenario_file.is_none()
    .then(|| token_scenario.or_else(|| name.map(String::from)).unwrap_or_else(|| "default".into()));
```

Adjust `run_scenario` to take `chosen_name: Option<String>` and use it when `scenario_file` is absent.

- [ ] **Step 4: Smoke test**

```bash
cd /workspace && cargo build -p quantico --release && \
  echo "hello @quantico:env-echo@ world" | MOCK_CLAUDE_SPEED_MULT=10 RUN_ID=7 \
    ./target/release/quantico --dangerously-skip-permissions
```

Expected: env-echo block printed (because the token overrode the default).

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add cli/quantico/ && git commit -m "feat(quantico): prompt-token scenario override"
```

---

### Task 12: Plugin subcommand failure mode + remaining scenarios

**Files:**
- Create: `cli/quantico/scenarios/chatty.yaml`
- Create: `cli/quantico/scenarios/limit-breach.yaml`
- Create: `cli/quantico/scenarios/limit-breach-human.yaml`
- Create: `cli/quantico/scenarios/crash-fast.yaml`
- Create: `cli/quantico/scenarios/hang.yaml`
- Create: `cli/quantico/scenarios/garbled.yaml`
- Create: `cli/quantico/scenarios/slow-startup.yaml`
- Create: `cli/quantico/scenarios/resume-aware.yaml`
- Create: `cli/quantico/scenarios/tool-heavy.yaml`
- Create: `cli/quantico/scenarios/plugin-fail.yaml`
- Create: `cli/quantico/scenarios.json` (committed)
- Modify: `cli/quantico/src/scenario.rs`
- Modify: `cli/quantico/src/main.rs` (plugin-fail support)

- [ ] **Step 1: Add scenario files**

Each YAML file follows the schema. Examples:

`cli/quantico/scenarios/chatty.yaml` — looped emit/sleep blocks totalling ~5 minutes of prose.
`cli/quantico/scenarios/limit-breach.yaml`:

```yaml
name: limit-breach
steps:
  - emit: "I'll start working on this.\n"
  - write_jsonl: { type: "user", content: "start" }
  - sleep_ms: 1000
  - emit: "Reading the codebase...\n"
  - sleep_ms: 1000
  - emit_limit_breach: { reset_epoch: "+1h" }
  - sleep_forever: true
```

`limit-breach-human.yaml` — same but `emit: "Claude usage limit reached. Your limit will reset at 5pm.\n"` instead.
`crash-fast.yaml`: prints one line, `exit: 1`.
`hang.yaml`: emits one line then `sleep_forever: true`.
`garbled.yaml`: emit_ansi with `"\x1b[99999H\xc3\x28 raw bytes \xff\xfe\n"` then exit 0.
`slow-startup.yaml`: `sleep_ms: 30000` then a line then exit 0.
`resume-aware.yaml`: emit "[quantico] check resume marker line in main.rs"; exit 0. (The `[quantico] resumed from <id>` is printed by `main.rs`, not the scenario.)
`tool-heavy.yaml`: many `emit_ansi` blocks formatted as fake tool calls.
`plugin-fail.yaml`: name only — used by `main.rs` to switch the plugin subcommand to fail (see Step 3).

- [ ] **Step 2: Update `scenario.rs` lookup + names list**

Append to the existing `lookup()` match all new scenarios (one arm per file via `include_str!`). Update `BUILT_IN_NAMES` accordingly:

```rust
pub const BUILT_IN_NAMES: &[&str] = &[
    "default", "chatty", "limit-breach", "limit-breach-human",
    "crash-fast", "hang", "garbled", "slow-startup",
    "env-echo", "resume-aware", "tool-heavy", "plugin-fail",
];
```

The existing `built_in_names_all_resolve` test now covers all twelve.

- [ ] **Step 3: Plugin subcommand reads `MOCK_CLAUDE_SCENARIO=plugin-fail`**

In `main.rs`, change the `PluginInstall`/`PluginMarketplaceAdd` arms:

```rust
argv::Invocation::PluginInstall(name) => {
    if std::env::var("MOCK_CLAUDE_SCENARIO").as_deref() == Ok("plugin-fail") {
        eprintln!("[quantico] plugin install failed (scenario): {}", name);
        1
    } else {
        println!("[quantico] plugin installed: {}", name);
        0
    }
}
```

(Same shape for marketplace add.)

- [ ] **Step 4: Generate `scenarios.json`**

Create `cli/quantico/scenarios.json` (committed) — matches `BUILT_IN_NAMES`:

```json
{
  "scenarios": [
    "default", "chatty", "limit-breach", "limit-breach-human",
    "crash-fast", "hang", "garbled", "slow-startup",
    "env-echo", "resume-aware", "tool-heavy", "plugin-fail"
  ]
}
```

Add a Rust test (in `scenario.rs`) that asserts the JSON matches `BUILT_IN_NAMES`:

```rust
#[test]
fn scenarios_json_matches_built_in_names() {
    let raw = include_str!("../scenarios.json");
    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
    let names: Vec<&str> = v["scenarios"].as_array().unwrap()
        .iter().map(|s| s.as_str().unwrap()).collect();
    assert_eq!(names, BUILT_IN_NAMES);
}
```

- [ ] **Step 5: Run all tests + smoke**

Run: `cd /workspace && cargo test -p quantico`
Expected: green; the new test passes.

Run: `cd /workspace && MOCK_CLAUDE_SCENARIO=plugin-fail ./target/release/quantico plugin install foo; echo exit=$?`
Expected: exit=1.

- [ ] **Step 6: Commit**

```bash
cd /workspace && git add cli/quantico/ && git commit -m "feat(quantico): full scenario library + plugin-fail mode"
```

---

## Phase 3 — Build infrastructure

### Task 13: Extend `build-cli-dist.sh` to build Quantico

**Files:**
- Modify: `scripts/build-cli-dist.sh`

- [ ] **Step 1: Generalize the build function**

Edit the script. After the existing `build()` function, change every `fbi-tunnel` reference to a loop over both crates. Concretely, replace each `build aarch64-apple-darwin darwin-arm64` call with two calls — one for `fbi-tunnel`, one for `quantico` — passing the crate name as a third argument, and adjust `build()`:

```sh
build() {
  local triple="$1" name="$2" crate="$3"
  echo "→ $crate / $triple  →  dist/cli/$crate-$name"
  rustup target add "$triple" 2>/dev/null || true
  cargo build --release --target "$triple" -p "$crate"
  cp "$WORKSPACE_TARGET/$triple/release/$crate" "$OUT/$crate-$name"
}
```

For each existing `build <triple> <name>` invocation, follow it with a second `build <triple> <name> quantico` invocation; rename existing calls to pass `fbi-tunnel` as the third arg.

- [ ] **Step 2: Smoke**

Run: `cd /workspace && bash scripts/build-cli-dist.sh`
Expected: produces both `dist/cli/fbi-tunnel-linux-amd64` and `dist/cli/quantico-linux-amd64` (only those that the host can target).

- [ ] **Step 3: Add `cli/quantico/dist/` to `.gitignore`**

Append to `.gitignore`:

```
cli/quantico/dist/
```

(Verify `cli/fbi-tunnel/dist/` is also ignored or already covered by `dist/`.)

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add scripts/build-cli-dist.sh .gitignore && git commit -m "build(quantico): include in build-cli-dist.sh"
```

---

### Task 14: Add npm scripts and wire into `npm run build`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

In the `"scripts"` block of `package.json`:

```json
"cli:quantico:build": "make -C cli/quantico build",
"cli:quantico:test": "make -C cli/quantico test",
```

And change `"build"` to also build CLI binaries:

```json
"build": "npm run build:server && npm run build:web && npm run cli:dist",
```

(`cli:dist` already exists and now builds both crates after Task 13.)

- [ ] **Step 2: Verify**

Run: `cd /workspace && npm run cli:quantico:test`
Expected: cargo tests pass.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add package.json && git commit -m "build(quantico): npm scripts + wire into npm run build"
```

---

### Task 15: `install.sh` deploys Quantico when capability flag is set

**Files:**
- Modify: `scripts/install.sh`

- [ ] **Step 1: Add a deploy step**

Insert before the systemd block (after `chown -R fbi:fbi "$ELIXIR_DIR"`):

```sh
# ── Quantico (mock-Claude testing binary) ───────────────────────────────────────
# Only deployed when FBI_QUANTICO_ENABLED=1 is present in /etc/default/fbi.
if grep -q '^FBI_QUANTICO_ENABLED=1' /etc/default/fbi 2>/dev/null; then
  install -d -m 755 /usr/local/lib/fbi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) Q="$SOURCE_DIR/dist/cli/quantico-linux-amd64" ;;
    aarch64) Q="$SOURCE_DIR/dist/cli/quantico-linux-arm64" ;;
    *) echo "Unsupported arch for Quantico: $ARCH"; Q="" ;;
  esac
  if [ -n "$Q" ] && [ -f "$Q" ]; then
    install -m 755 "$Q" /usr/local/lib/fbi/quantico
    echo "Quantico installed at /usr/local/lib/fbi/quantico"
  else
    echo "Quantico binary not found ($Q); run 'npm run cli:dist' first" >&2
  fi
fi
```

- [ ] **Step 2: Document the env var in the seeded `/etc/default/fbi`**

In the `cat > /etc/default/fbi <<'ENV'` block, add a commented line at the bottom of the optional overrides section:

```
# Mock-Claude testing binary (development servers only):
# FBI_QUANTICO_ENABLED=1
```

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add scripts/install.sh && git commit -m "build(quantico): install.sh deploys binary when FBI_QUANTICO_ENABLED=1"
```

---

## Phase 4 — TS server integration

### Task 16: Add `mock` and `mock_scenario` columns to schema + migration

**Files:**
- Modify: `src/server/db/schema.sql`
- Modify: `src/server/db/index.ts`

- [ ] **Step 1: Add to fresh-DB schema**

Edit `src/server/db/schema.sql`. In the `CREATE TABLE IF NOT EXISTS runs` block, append two columns after `subagent_model TEXT`:

```sql
  subagent_model TEXT,
  mock INTEGER NOT NULL DEFAULT 0,
  mock_scenario TEXT
```

(Adjust the trailing comma on `subagent_model` accordingly.)

- [ ] **Step 2: Add ALTERs for upgraded DBs**

In `src/server/db/index.ts`, append to the end of `migrate()`:

```ts
const runsCols2 = new Set(
  (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>)
    .map((r) => r.name)
);
if (!runsCols2.has('mock')) {
  db.exec('ALTER TABLE runs ADD COLUMN mock INTEGER NOT NULL DEFAULT 0');
}
if (!runsCols2.has('mock_scenario')) {
  db.exec('ALTER TABLE runs ADD COLUMN mock_scenario TEXT');
}
```

- [ ] **Step 3: Run existing TS tests as a smoke**

Run: `cd /workspace && npm test -- src/server/db`
Expected: green.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add src/server/db/schema.sql src/server/db/index.ts && git commit -m "feat(db): add runs.mock and runs.mock_scenario columns"
```

---

### Task 17: Extend `runs.create` and decode

**Files:**
- Modify: `src/server/db/runs.ts`
- Modify: `src/server/db/runs.test.ts` (TDD)

- [ ] **Step 1: Write the failing test**

Add to `src/server/db/runs.test.ts`:

```ts
it('persists mock and mock_scenario when provided', () => {
  const r = runs.create({
    project_id: pid, prompt: 'p', branch_hint: undefined,
    log_path_tmpl: (id) => `/tmp/${id}.log`,
    model: null, effort: null, subagent_model: null,
    mock: true, mock_scenario: 'limit-breach',
  });
  expect(r.mock).toBe(1);
  expect(r.mock_scenario).toBe('limit-breach');
});

it('defaults mock to 0 and mock_scenario to null', () => {
  const r = runs.create({
    project_id: pid, prompt: 'p', branch_hint: undefined,
    log_path_tmpl: (id) => `/tmp/${id}.log`,
    model: null, effort: null, subagent_model: null,
  });
  expect(r.mock).toBe(0);
  expect(r.mock_scenario).toBeNull();
});
```

- [ ] **Step 2: Run, see failure**

Run: `cd /workspace && npm test -- src/server/db/runs.test.ts`
Expected: failures complaining about `mock` not in the type/INSERT.

- [ ] **Step 3: Make it pass**

Edit `src/server/db/runs.ts`. Add `mock?: boolean` and `mock_scenario?: string | null` to the create input type. In the INSERT statement, include `mock` and `mock_scenario`. In the row decode (whatever maps SQLite row to the API shape), include both.

- [ ] **Step 4: Run all run-related tests**

Run: `cd /workspace && npm test -- src/server/db/runs`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add src/server/db/runs.ts src/server/db/runs.test.ts && git commit -m "feat(runs): persist mock/mock_scenario columns"
```

---

### Task 18: Capability flag in server config

**Files:**
- Modify: `src/server/config.ts`
- Modify: `src/server/config.test.ts` (or wherever config is tested; create if absent)

- [ ] **Step 1: Add the new fields**

In `src/server/config.ts`, extend the config object with:

```ts
quanticoEnabled: process.env.FBI_QUANTICO_ENABLED === '1',
quanticoBinaryPath: process.env.FBI_QUANTICO_BINARY_PATH ??
  '/usr/local/lib/fbi/quantico',
mockSpeedMult: Number(process.env.MOCK_CLAUDE_SPEED_MULT ?? 1.0),
limitMonitorIdleMs: Number(process.env.FBI_LIMIT_MONITOR_IDLE_MS ?? 15_000),
limitMonitorWarmupMs: Number(process.env.FBI_LIMIT_MONITOR_WARMUP_MS ?? 60_000),
```

(Match the existing config shape — these may be top-level keys or nested under a sub-object; preserve whatever convention exists.)

- [ ] **Step 2: Smoke**

Run: `cd /workspace && npm run typecheck`
Expected: green.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add src/server/config.ts && git commit -m "feat(config): quantico + limit-monitor env vars"
```

---

### Task 19: API validation in `runs.ts` (TDD)

**Files:**
- Modify: `src/server/api/runs.ts`
- Modify: `src/server/api/runs.test.ts` (TDD)

- [ ] **Step 1: Write the failing tests**

Add to `src/server/api/runs.test.ts` inside the existing `describe('POST /api/projects/:id/runs')` block:

```ts
it('rejects mock=true when capability flag is off', async () => {
  // capability flag default off in the test harness
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${pid}/runs`,
    payload: { prompt: 'hi', mock: true, mock_scenario: 'default' },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/quantico_disabled/);
});

it('accepts mock=true with valid scenario when capability is on', async () => {
  // toggle capability on for this test
  withCapability(true);
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${pid}/runs`,
    payload: { prompt: 'hi', mock: true, mock_scenario: 'default' },
  });
  expect(res.statusCode).toBe(201);
  const row = db.prepare('SELECT mock, mock_scenario FROM runs WHERE id = ?').get(res.json().id);
  expect(row.mock).toBe(1);
  expect(row.mock_scenario).toBe('default');
});

it('rejects mock=true with unknown scenario name', async () => {
  withCapability(true);
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${pid}/runs`,
    payload: { prompt: 'hi', mock: true, mock_scenario: 'nonsense' },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toMatch(/invalid_scenario/);
});
```

(The existing test scaffold's `app` and `pid` setup carries over; if there's no `withCapability` helper, add one that mutates the test config — match existing patterns.)

- [ ] **Step 2: Run, see failures**

Run: `cd /workspace && npm test -- src/server/api/runs.test.ts`
Expected: 3 failures.

- [ ] **Step 3: Make them pass**

Edit `src/server/api/runs.ts`. In the `app.post('/api/projects/:id/runs', …)` handler, after the `validateModelParams` block add:

```ts
const mock = body.mock === true;
const mockScenario = body.mock_scenario ?? null;
if (mock) {
  if (!deps.config.quanticoEnabled) {
    return reply.code(400).send({ error: 'quantico_disabled' });
  }
  // Load the canonical scenario list. Cached at startup; see api/quantico.ts (next task).
  if (mockScenario !== null && !deps.quanticoScenarios.has(mockScenario)) {
    return reply.code(400).send({ error: 'invalid_scenario' });
  }
}
```

Pass `mock` and `mock_scenario: mock ? mockScenario : null` into `deps.runs.create({…})`.

You'll need to thread `deps.quanticoScenarios: Set<string>` and `deps.config.quanticoEnabled` through; the next task creates the scenarios endpoint and exports the scenario list reader.

- [ ] **Step 4: Run tests**

Run: `cd /workspace && npm test -- src/server/api/runs.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add src/server/api/runs.ts src/server/api/runs.test.ts && git commit -m "feat(api): validate mock/mock_scenario fields on POST /api/projects/:id/runs"
```

---

### Task 20: `GET /api/quantico/scenarios` endpoint (TDD)

**Files:**
- Create: `src/server/api/quantico.ts`
- Create: `src/server/api/quantico.test.ts`
- Modify: `src/server/api/index.ts` (or wherever routes are registered)

- [ ] **Step 1: Write the failing test**

Create `src/server/api/quantico.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerQuanticoRoutes, loadScenarioNames } from './quantico.js';

describe('GET /api/quantico/scenarios', () => {
  it('404s when capability flag is off', async () => {
    const app = Fastify();
    registerQuanticoRoutes(app, { quanticoEnabled: false });
    const res = await app.inject({ method: 'GET', url: '/api/quantico/scenarios' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the scenario list when on', async () => {
    const app = Fastify();
    registerQuanticoRoutes(app, { quanticoEnabled: true });
    const res = await app.inject({ method: 'GET', url: '/api/quantico/scenarios' });
    expect(res.statusCode).toBe(200);
    expect(res.json().scenarios).toContain('default');
    expect(res.json().scenarios).toContain('limit-breach');
  });

  it('loadScenarioNames reads from cli/quantico/scenarios.json', () => {
    const names = loadScenarioNames();
    expect(names.has('default')).toBe(true);
    expect(names.size).toBeGreaterThanOrEqual(12);
  });
});
```

- [ ] **Step 2: Run, see failure**

Run: `cd /workspace && npm test -- src/server/api/quantico.test.ts`
Expected: failure (file does not exist).

- [ ] **Step 3: Implement**

Create `src/server/api/quantico.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_JSON = path.resolve(HERE, '../../../cli/quantico/scenarios.json');

let cached: Set<string> | null = null;
export function loadScenarioNames(): Set<string> {
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(SCENARIOS_JSON, 'utf8')) as { scenarios: string[] };
  cached = new Set(raw.scenarios);
  return cached;
}

export function registerQuanticoRoutes(
  app: FastifyInstance,
  cfg: { quanticoEnabled: boolean },
): void {
  app.get('/api/quantico/scenarios', async (_req, reply) => {
    if (!cfg.quanticoEnabled) return reply.code(404).send({ error: 'not_found' });
    return { scenarios: Array.from(loadScenarioNames()) };
  });
}
```

Register in `src/server/api/index.ts` (or the route-registration entrypoint):

```ts
import { registerQuanticoRoutes, loadScenarioNames } from './quantico.js';
// ...
registerQuanticoRoutes(app, { quanticoEnabled: deps.config.quanticoEnabled });
deps.quanticoScenarios = loadScenarioNames();
```

(Wire `deps.quanticoScenarios: Set<string>` into the same deps object that runs.ts consumes.)

- [ ] **Step 4: Run tests**

Run: `cd /workspace && npm test -- src/server/api/quantico.test.ts && npm test -- src/server/api/runs.test.ts`
Expected: green for both.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add src/server/api/quantico.ts src/server/api/quantico.test.ts src/server/api/index.ts && git commit -m "feat(api): GET /api/quantico/scenarios endpoint"
```

---

### Task 21: TS orchestrator bind logic + skip OAuth bind for mock runs (TDD)

**Files:**
- Modify: `src/server/orchestrator/index.ts`
- Modify: `src/server/orchestrator/index.test.ts` (or create)

- [ ] **Step 1: Write the failing test**

Add (or create) a focused test that builds the container spec and asserts the binds list. The shape will look like:

```ts
import { describe, it, expect } from 'vitest';
import { buildContainerSpec } from './index.js'; // refactor target

describe('container spec — mock mode', () => {
  it('mock=true binds Quantico over /usr/local/bin/claude', () => {
    const spec = buildContainerSpec(/* …minimal deps + run with mock=true, mock_scenario='default' …*/);
    expect(spec.HostConfig.Binds).toContain(
      '/usr/local/lib/fbi/quantico:/usr/local/bin/claude:ro',
    );
    expect(spec.Env).toContain('MOCK_CLAUDE_SCENARIO=default');
    expect(spec.Env.some((e) => e.startsWith('MOCK_CLAUDE_SPEED_MULT='))).toBe(true);
    // OAuth bind must be absent
    expect(spec.HostConfig.Binds.some((b) => b.includes('.claude.json'))).toBe(false);
  });

  it('mock=false leaves the bind list unchanged', () => {
    const spec = buildContainerSpec(/* run with mock=false */);
    expect(spec.HostConfig.Binds.some((b) => b.includes('quantico'))).toBe(false);
  });
});
```

If the existing index.ts inlines the spec construction inside an async method, extract a pure `buildContainerSpec()` function that takes the deps as arguments and returns the dockerode create-container spec object. This refactor enables the test and is required.

- [ ] **Step 2: Run, see failure**

Run: `cd /workspace && npm test -- src/server/orchestrator/index.test.ts`
Expected: failures.

- [ ] **Step 3: Implement**

In `src/server/orchestrator/index.ts`:

1. Extract container-spec construction to a pure `buildContainerSpec()` function returning the object passed to `docker.createContainer()`.
2. When the `run.mock === 1`:
   - Push `${deps.config.quanticoBinaryPath}:/usr/local/bin/claude:ro` to `Binds`.
   - Push `MOCK_CLAUDE_SCENARIO=${run.mock_scenario ?? 'default'}` and `MOCK_CLAUDE_SPEED_MULT=${deps.config.mockSpeedMult ?? 1.0}` to `Env`.
   - Skip the spread of `claudeAuthMounts(...)`.
   - Pre-flight: `if (!fs.existsSync(deps.config.quanticoBinaryPath)) throw new Error('quantico binary not found at ...')`.
3. Add a startup banner emit (use the existing pre-supervisor hook if any; otherwise prepend a short `[mock] scenario=<name>` line via an env-var the supervisor already echoes — simplest: the env-echo scenario already prints argv/env, and the mock banner can be a `_fbi_status "[mock] scenario=$MOCK_CLAUDE_SCENARIO"` call we **don't** add to `supervisor.sh`. Defer banner to UI badge instead — see Task 27.).

(Drop the banner if it would force a `supervisor.sh` edit; the spec calls for "tag the run's terminal banner" but the cleanest implementation is the UI badge layer.)

- [ ] **Step 4: Run tests**

Run: `cd /workspace && npm test -- src/server/orchestrator/`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add src/server/orchestrator/index.ts src/server/orchestrator/index.test.ts && git commit -m "feat(orchestrator): bind Quantico + skip OAuth bind when run.mock=1"
```

---

### Task 22: Pass LimitMonitor env-tunable opts through

**Files:**
- Modify: `src/server/orchestrator/limitMonitor.ts` (no signature changes — already accepts opts)
- Modify: wherever `new LimitMonitor({...})` is constructed (grep `new LimitMonitor`)

- [ ] **Step 1: Find construction sites**

Run: `cd /workspace && grep -rn 'new LimitMonitor' src/server/`

- [ ] **Step 2: Pass `idleMs` and `warmupMs` from config**

At each construction site, source `idleMs` and `warmupMs` from `deps.config.limitMonitorIdleMs` and `deps.config.limitMonitorWarmupMs` (added in Task 18).

- [ ] **Step 3: Add a quick test**

In a relevant test file (e.g., `limitMonitor.test.ts`), add:

```ts
it('honours idleMs and warmupMs from caller', () => {
  const m = new LimitMonitor({ mountDir: '/tmp', idleMs: 100, warmupMs: 200, onDetect: () => {} });
  // Construct doesn't expose private fields; this test just ensures no crash
  // and documents the contract. Behavioural coverage is in existing tests.
  expect(m).toBeDefined();
});
```

- [ ] **Step 4: Smoke**

Run: `cd /workspace && npm test -- src/server/orchestrator/limitMonitor.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add src/server/ && git commit -m "feat(limit-monitor): wire idleMs/warmupMs from config (env-tunable for tests)"
```

---

## Phase 5 — Elixir server integration

### Task 23: Ecto migration for `mock` and `mock_scenario`

**Files:**
- Create: `server-elixir/priv/repo/migrations/20260426000001_add_runs_mock_columns.exs`
- Modify: `server-elixir/lib/fbi/runs/run.ex`

- [ ] **Step 1: Create migration**

```elixir
defmodule FBI.Repo.Migrations.AddRunsMockColumns do
  use Ecto.Migration

  def change do
    alter table(:runs) do
      add :mock, :boolean, default: false, null: false
      add :mock_scenario, :text
    end
  end
end
```

- [ ] **Step 2: Add fields to the Ecto schema**

Edit `server-elixir/lib/fbi/runs/run.ex`. Inside the `schema "runs" do` block, after `field :mirror_status, :string`, add:

```elixir
field :mock, :boolean, default: false
field :mock_scenario, :string
```

Append `mock mock_scenario` to `@all_fields`:

```elixir
@all_fields ~w(
  project_id prompt branch_name state container_id log_path exit_code error
  head_commit started_at finished_at created_at state_entered_at
  model effort subagent_model
  resume_attempts next_resume_at claude_session_id last_limit_reset_at
  tokens_input tokens_output tokens_cache_read tokens_cache_create tokens_total
  usage_parse_errors title title_locked parent_run_id
  kind kind_args_json mirror_status mock mock_scenario
)a
```

- [ ] **Step 3: Run migrations + compile**

Run: `cd /workspace/server-elixir && MIX_ENV=test mix ecto.migrate && MIX_ENV=test mix compile --warnings-as-errors`
Expected: green.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add server-elixir/priv/repo/migrations/20260426000001_add_runs_mock_columns.exs server-elixir/lib/fbi/runs/run.ex && git commit -m "feat(elixir): add runs.mock and runs.mock_scenario columns"
```

---

### Task 24: Extend `Queries.decode` to surface the new fields

**Files:**
- Modify: `server-elixir/lib/fbi/runs/queries.ex`
- Modify: existing fidelity test or add to `test/fidelity/runs_fidelity_test.exs`

- [ ] **Step 1: Append `mock` and `mock_scenario` to `Map.take` in `decode/1`**

In `server-elixir/lib/fbi/runs/queries.ex`, find the `Map.take(r, [...])` list inside `decode/1` and append `:mock`, `:mock_scenario`.

- [ ] **Step 2: Update fidelity fixture**

`server-elixir/test/fidelity/fixtures/run_snapshot.json` — add `"mock": false, "mock_scenario": null` to the snapshot. (If the fidelity test compares against TS, also update the TS run shape; check `src/server/db/runs.ts` returns these fields.)

- [ ] **Step 3: Run all Elixir tests**

Run: `cd /workspace/server-elixir && mix test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add server-elixir/ && git commit -m "feat(elixir): decode mock/mock_scenario in run queries"
```

---

### Task 25: `runs_controller` validates mock fields

**Files:**
- Modify: `server-elixir/lib/fbi_web/controllers/runs_controller.ex`
- Modify: `server-elixir/test/fbi_web/controllers/runs_controller_test.exs`
- Modify: `server-elixir/config/runtime.exs`

- [ ] **Step 1: Add capability flag to runtime config**

Edit `server-elixir/config/runtime.exs`. Append:

```elixir
config :fbi,
  quantico_enabled: System.get_env("FBI_QUANTICO_ENABLED") == "1",
  quantico_binary_path: System.get_env("FBI_QUANTICO_BINARY_PATH") || "/usr/local/lib/fbi/quantico",
  quantico_scenarios: FBI.Quantico.load_scenario_names(),
  limit_monitor_idle_ms: String.to_integer(System.get_env("FBI_LIMIT_MONITOR_IDLE_MS") || "15000"),
  limit_monitor_warmup_ms: String.to_integer(System.get_env("FBI_LIMIT_MONITOR_WARMUP_MS") || "60000")
```

(Defines the `FBI.Quantico` helper module — created in Task 26.)

- [ ] **Step 2: Write the failing controller test**

Add to `server-elixir/test/fbi_web/controllers/runs_controller_test.exs` (or create if absent — mirror the TS test shape):

```elixir
test "rejects mock=true when capability flag is off", %{conn: conn, project: p} do
  Application.put_env(:fbi, :quantico_enabled, false)
  conn = post(conn, ~p"/api/projects/#{p.id}/runs", %{"prompt" => "p", "mock" => true})
  assert json_response(conn, 400)["error"] =~ "quantico_disabled"
end

test "accepts mock=true with valid scenario when capability is on", %{conn: conn, project: p} do
  Application.put_env(:fbi, :quantico_enabled, true)
  Application.put_env(:fbi, :quantico_scenarios, MapSet.new(["default"]))
  conn = post(conn, ~p"/api/projects/#{p.id}/runs",
    %{"prompt" => "p", "mock" => true, "mock_scenario" => "default"})
  assert json_response(conn, 201)["mock"] == true
  assert json_response(conn, 201)["mock_scenario"] == "default"
end

test "rejects mock=true with unknown scenario name", %{conn: conn, project: p} do
  Application.put_env(:fbi, :quantico_enabled, true)
  Application.put_env(:fbi, :quantico_scenarios, MapSet.new(["default"]))
  conn = post(conn, ~p"/api/projects/#{p.id}/runs",
    %{"prompt" => "p", "mock" => true, "mock_scenario" => "nonsense"})
  assert json_response(conn, 400)["error"] =~ "invalid_scenario"
end
```

- [ ] **Step 3: Run, see failures**

Run: `cd /workspace/server-elixir && mix test test/fbi_web/controllers/runs_controller_test.exs`
Expected: failures.

- [ ] **Step 4: Make them pass**

Edit `runs_controller.ex`. In `def create`, after extracting `subagent_model`, add:

```elixir
mock = params["mock"] == true
mock_scenario = params["mock_scenario"]

cond do
  mock and not Application.get_env(:fbi, :quantico_enabled, false) ->
    conn |> put_status(400) |> json(%{error: "quantico_disabled"})

  mock and not is_nil(mock_scenario) and
    not MapSet.member?(Application.get_env(:fbi, :quantico_scenarios, MapSet.new()), mock_scenario) ->
    conn |> put_status(400) |> json(%{error: "invalid_scenario"})

  true ->
    # existing flow, now passing mock + mock_scenario through to do_create
end
```

Update `do_create/8` to accept `mock` and `mock_scenario`, and include them in the `attrs` map passed to `Queries.create/1`.

- [ ] **Step 5: Run tests**

Run: `cd /workspace/server-elixir && mix test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd /workspace && git add server-elixir/ && git commit -m "feat(elixir): validate mock/mock_scenario on POST /api/projects/:id/runs"
```

---

### Task 26: Quantico scenarios endpoint (Elixir)

**Files:**
- Create: `server-elixir/lib/fbi/quantico.ex`
- Create: `server-elixir/lib/fbi_web/controllers/quantico_controller.ex`
- Modify: `server-elixir/lib/fbi_web/router.ex`
- Create: `server-elixir/test/fbi_web/controllers/quantico_controller_test.exs`

- [ ] **Step 1: Create the loader module**

`server-elixir/lib/fbi/quantico.ex`:

```elixir
defmodule FBI.Quantico do
  @moduledoc "Helpers around the Quantico mock-Claude binary."

  @scenarios_path Path.expand("../../../cli/quantico/scenarios.json", __DIR__)

  @spec load_scenario_names() :: MapSet.t(String.t())
  def load_scenario_names do
    case File.read(@scenarios_path) do
      {:ok, raw} ->
        %{"scenarios" => names} = Jason.decode!(raw)
        MapSet.new(names)
      {:error, _} -> MapSet.new()
    end
  end
end
```

- [ ] **Step 2: Write the failing controller test**

`server-elixir/test/fbi_web/controllers/quantico_controller_test.exs`:

```elixir
defmodule FBIWeb.QuanticoControllerTest do
  use FBIWeb.ConnCase

  test "404 when capability is off", %{conn: conn} do
    Application.put_env(:fbi, :quantico_enabled, false)
    conn = get(conn, ~p"/api/quantico/scenarios")
    assert response(conn, 404)
  end

  test "lists scenarios when on", %{conn: conn} do
    Application.put_env(:fbi, :quantico_enabled, true)
    Application.put_env(:fbi, :quantico_scenarios, MapSet.new(["default", "limit-breach"]))
    conn = get(conn, ~p"/api/quantico/scenarios")
    body = json_response(conn, 200)
    assert "default" in body["scenarios"]
    assert "limit-breach" in body["scenarios"]
  end
end
```

- [ ] **Step 3: Implement the controller**

`server-elixir/lib/fbi_web/controllers/quantico_controller.ex`:

```elixir
defmodule FBIWeb.QuanticoController do
  use FBIWeb, :controller

  def index(conn, _params) do
    if Application.get_env(:fbi, :quantico_enabled, false) do
      names = Application.get_env(:fbi, :quantico_scenarios, MapSet.new()) |> MapSet.to_list()
      json(conn, %{scenarios: names})
    else
      conn |> put_status(404) |> json(%{error: "not_found"})
    end
  end
end
```

- [ ] **Step 4: Add route**

In `server-elixir/lib/fbi_web/router.ex`, inside the same `scope "/api"` that holds the runs routes, add:

```elixir
get "/quantico/scenarios", QuanticoController, :index
```

- [ ] **Step 5: Run tests**

Run: `cd /workspace/server-elixir && mix test test/fbi_web/controllers/quantico_controller_test.exs`
Expected: green.

- [ ] **Step 6: Commit**

```bash
cd /workspace && git add server-elixir/ && git commit -m "feat(elixir): GET /api/quantico/scenarios endpoint"
```

---

### Task 27: Elixir orchestrator bind logic

**Files:**
- Modify: `server-elixir/lib/fbi/orchestrator/run_server.ex`
- Modify: existing run_server test (add a bind-list assertion)

- [ ] **Step 1: Write the failing test**

Find the existing test that exercises `run_server`'s container-spec construction (or add a focused test in `test/fbi/orchestrator/run_server_test.exs`). Assert:

```elixir
test "mock run binds Quantico and skips claude_auth_mounts" do
  Application.put_env(:fbi, :quantico_enabled, true)
  Application.put_env(:fbi, :quantico_binary_path, "/tmp/quantico-fake")
  File.write!("/tmp/quantico-fake", "")

  spec = build_container_spec(%{run | mock: true, mock_scenario: "default"}, ...)

  binds = spec["HostConfig"]["Binds"]
  assert "/tmp/quantico-fake:/usr/local/bin/claude:ro" in binds
  refute Enum.any?(binds, &String.contains?(&1, ".claude.json"))
  env = spec["Env"]
  assert "MOCK_CLAUDE_SCENARIO=default" in env
end
```

(If `build_container_spec` is currently inlined inside the GenServer, extract it to a public function in the same module first — same refactor as Task 21.)

- [ ] **Step 2: Run, see failure**

Run: `cd /workspace/server-elixir && mix test test/fbi/orchestrator/run_server_test.exs`
Expected: failure.

- [ ] **Step 3: Implement**

In `run_server.ex`, around the `binds = [...]` block (line ~1103), add (post-construction of the base list, pre `claude_auth_mounts` append):

```elixir
binds =
  if run.mock do
    qpath = Application.fetch_env!(:fbi, :quantico_binary_path)
    unless File.exists?(qpath) do
      raise "quantico binary not found at #{qpath}; mock runs cannot start"
    end
    binds ++ ["#{qpath}:/usr/local/bin/claude:ro"]
  else
    binds
  end

binds = if run.mock, do: binds, else: binds ++ claude_auth_mounts(config)
```

(Replace the existing unconditional `binds = binds ++ claude_auth_mounts(config)` with the conditional form above.)

For env, after the existing model-param env block, append:

```elixir
env =
  if run.mock do
    speed = System.get_env("MOCK_CLAUDE_SPEED_MULT") || "1.0"
    env ++ ["MOCK_CLAUDE_SCENARIO=#{run.mock_scenario || "default"}", "MOCK_CLAUDE_SPEED_MULT=#{speed}"]
  else
    env
  end
```

- [ ] **Step 4: Run tests**

Run: `cd /workspace/server-elixir && mix test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add server-elixir/ && git commit -m "feat(elixir-orchestrator): bind Quantico + skip OAuth bind when run.mock"
```

---

### Task 28: Elixir LimitMonitor env-tunable opts

**Files:**
- Modify: `server-elixir/lib/fbi/orchestrator/limit_monitor.ex`
- Modify: caller(s) — grep `LimitMonitor.start_link` or equivalent

- [ ] **Step 1: Find callers**

Run: `cd /workspace && grep -rn 'LimitMonitor' server-elixir/lib/`

- [ ] **Step 2: Plumb the env-driven config**

At each caller, source `idle_ms` and `warmup_ms` from `Application.get_env(:fbi, :limit_monitor_idle_ms)` / `:limit_monitor_warmup_ms`, falling back to module defaults.

- [ ] **Step 3: Run tests**

Run: `cd /workspace/server-elixir && mix test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
cd /workspace && git add server-elixir/ && git commit -m "feat(elixir-limit-monitor): wire env-tunable idle_ms/warmup_ms"
```

---

## Phase 6 — UI

### Task 29: API client extension

**Files:**
- Modify: `src/web/lib/api.ts`

- [ ] **Step 1: Extend `createRun` signature**

Find the `createRun:` block (around line 150). Add a `mockOptions` param:

```ts
createRun: (
  projectId: number,
  prompt: string,
  branch?: string,
  draftToken?: string,
  modelParams?: { model: string | null; effort: string | null; subagent_model: string | null },
  force?: boolean,
  mockOptions?: { mock: boolean; mock_scenario: string | null },
) =>
  request<Run>(`/api/projects/${projectId}/runs`, {
    method: 'POST',
    body: JSON.stringify({
      prompt, branch, draft_token: draftToken,
      ...(modelParams ?? {}),
      ...(mockOptions ?? {}),
      ...(force ? { force: true } : {}),
    }),
  }),
```

(Match the existing `request` shape; keep `mockOptions` optional so existing call-sites remain valid.)

Add a sibling helper:

```ts
fetchQuanticoScenarios: () =>
  request<{ scenarios: string[] }>('/api/quantico/scenarios'),
```

- [ ] **Step 2: Smoke**

Run: `cd /workspace && npm run typecheck`
Expected: green.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add src/web/lib/api.ts && git commit -m "feat(web-api): createRun mockOptions + fetchQuanticoScenarios"
```

---

### Task 30: `MockModeCollapse` component (TDD)

**Files:**
- Create: `src/web/components/MockModeCollapse.tsx`
- Create: `src/web/components/MockModeCollapse.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/web/components/MockModeCollapse.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MockModeCollapse } from './MockModeCollapse.js';

describe('MockModeCollapse', () => {
  it('renders nothing when scenarios prop is null (capability off)', () => {
    const { container } = render(
      <MockModeCollapse value={{ mock: false, mock_scenario: null }} onChange={() => {}} scenarios={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('toggling the checkbox flips `mock`', async () => {
    const onChange = vi.fn();
    render(<MockModeCollapse
      value={{ mock: false, mock_scenario: null }}
      onChange={onChange}
      scenarios={['default', 'limit-breach']}
    />);
    await userEvent.click(screen.getByTestId('mockmode-toggle'));
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith({ mock: true, mock_scenario: 'default' });
  });

  it('changing the scenario dropdown updates mock_scenario', async () => {
    const onChange = vi.fn();
    render(<MockModeCollapse
      value={{ mock: true, mock_scenario: 'default' }}
      onChange={onChange}
      scenarios={['default', 'limit-breach']}
    />);
    await userEvent.click(screen.getByTestId('mockmode-toggle'));
    await userEvent.selectOptions(screen.getByTestId('mockmode-scenario-select'), 'limit-breach');
    expect(onChange).toHaveBeenCalledWith({ mock: true, mock_scenario: 'limit-breach' });
  });
});
```

- [ ] **Step 2: Run, see failure**

Run: `cd /workspace && npm test -- src/web/components/MockModeCollapse.test.tsx`
Expected: failure.

- [ ] **Step 3: Implement**

`src/web/components/MockModeCollapse.tsx` — same shape as `ModelParamsCollapse` (read that file first for style):

```tsx
import { useState } from 'react';
import { Select } from '@ui/primitives/Select.js';

export interface MockModeValue {
  mock: boolean;
  mock_scenario: string | null;
}

export function MockModeCollapse(props: {
  value: MockModeValue;
  onChange: (v: MockModeValue) => void;
  /** null = capability flag off; component renders nothing */
  scenarios: string[] | null;
}): JSX.Element | null {
  const { value, onChange, scenarios } = props;
  const [expanded, setExpanded] = useState(false);
  if (scenarios === null) return null;

  const summary = value.mock
    ? `mock · ${value.mock_scenario ?? 'default'}`
    : 'off';

  function toggle() {
    if (value.mock) onChange({ mock: false, mock_scenario: null });
    else onChange({ mock: true, mock_scenario: scenarios![0] ?? 'default' });
  }
  function pickScenario(s: string) {
    onChange({ mock: true, mock_scenario: s });
  }

  return (
    <div className="border border-border-strong rounded-md overflow-hidden bg-surface">
      <button
        type="button"
        data-testid="mockmode-toggle"
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-surface-raised transition-colors duration-fast ease-out"
        aria-expanded={expanded}
      >
        <span aria-hidden className="shrink-0 inline-block w-3 text-text-dim">{expanded ? '▾' : '▸'}</span>
        <span className="shrink-0 font-medium text-sm">Mock mode (Quantico)</span>
        <span className="min-w-0 truncate text-text-dim text-sm">· {summary}</span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-3 space-y-2 bg-surface-sunken">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={value.mock}
              onChange={toggle}
            />
            <span className="text-sm">Use mock Claude instead of the real one</span>
          </label>
          {value.mock && (
            <label className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm text-text-dim">Scenario</span>
              <Select
                data-testid="mockmode-scenario-select"
                value={value.mock_scenario ?? 'default'}
                onChange={(e) => pickScenario(e.target.value)}
                className="max-w-[240px]"
              >
                {scenarios.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </label>
          )}
          <p className="text-xs text-text-faint">
            Bypasses the LLM. For testing terminal/auto-resume/env behavior.
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd /workspace && npm test -- src/web/components/MockModeCollapse.test.tsx`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd /workspace && git add src/web/components/MockModeCollapse.tsx src/web/components/MockModeCollapse.test.tsx && git commit -m "feat(web): MockModeCollapse component"
```

---

### Task 31: Integrate `MockModeCollapse` into `NewRun.tsx`

**Files:**
- Modify: `src/web/pages/NewRun.tsx`

- [ ] **Step 1: Wire it in**

At the top of `src/web/pages/NewRun.tsx`, change the React import to include `useEffect` and add the new component imports:

```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MockModeCollapse, type MockModeValue } from '../components/MockModeCollapse.js';
```

Inside `NewRunPage()`, alongside `useState` for `modelParams`, add:

```tsx
const [mockMode, setMockMode] = useState<MockModeValue>({ mock: false, mock_scenario: null });
const [scenarios, setScenarios] = useState<string[] | null>(null);

useEffect(() => {
  api.fetchQuanticoScenarios()
    .then((r) => setScenarios(r.scenarios))
    .catch(() => setScenarios(null)); // capability off → 404 → leave null
}, []);
```

In the `doCreateRun` body, change the `api.createRun` call to pass `mockMode` as the seventh argument:

```tsx
const run = await api.createRun(
  pid, prompt, branch || undefined, draftToken ?? undefined,
  modelParams, force, mockMode,
);
```

In the JSX, add `<MockModeCollapse value={mockMode} onChange={setMockMode} scenarios={scenarios} />` immediately after `<ModelParamsCollapse ... />`.

- [ ] **Step 2: Smoke**

Run: `cd /workspace && npm run typecheck && npm test -- src/web/pages/NewRun`
Expected: green.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add src/web/pages/NewRun.tsx && git commit -m "feat(web): expose Quantico mock mode in NewRun form"
```

---

## Phase 7 — Test layer

### Task 32: Playwright config + helpers skeleton

**Files:**
- Modify: `package.json` (add `@playwright/test` to devDeps; add `e2e` script)
- Create: `playwright.config.ts`
- Create: `tests/e2e/quantico/helpers.ts`

- [ ] **Step 1: Install Playwright**

Run: `cd /workspace && npm install --save-dev @playwright/test && npx playwright install --with-deps chromium`
Expected: deps installed; chromium downloaded.

- [ ] **Step 2: Add the script**

In `package.json` `"scripts"`:

```json
"e2e": "playwright test",
"e2e:install": "playwright install --with-deps chromium"
```

- [ ] **Step 3: Create `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e/quantico',
  timeout: 120_000,
  fullyParallel: false, // shared FBI server
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'PORT=3100 FBI_QUANTICO_ENABLED=1 MOCK_CLAUDE_SPEED_MULT=10 FBI_LIMIT_MONITOR_IDLE_MS=300 FBI_LIMIT_MONITOR_WARMUP_MS=200 npm run dev:server',
    url: 'http://127.0.0.1:3100/api/quantico/scenarios',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      DB_PATH: '/tmp/fbi-e2e.db',
      RUNS_DIR: '/tmp/fbi-e2e-runs',
      SECRETS_KEY_FILE: '/tmp/fbi-e2e.key',
      GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com',
      // Default to the workspace-relative binary so a developer running `npm run e2e`
      // locally needs no extra env. CI overrides this to point at dist/cli/.
      FBI_QUANTICO_BINARY_PATH: process.env.FBI_QUANTICO_BINARY_PATH ??
        `${process.cwd()}/cli/quantico/dist/quantico-x86_64-unknown-linux-gnu`,
    },
  },
});
```

- [ ] **Step 4: Create `tests/e2e/quantico/helpers.ts`**

```ts
import { expect, type Page } from '@playwright/test';

export type ScenarioName =
  | 'default' | 'chatty' | 'limit-breach' | 'limit-breach-human'
  | 'crash-fast' | 'hang' | 'garbled' | 'slow-startup'
  | 'env-echo' | 'resume-aware' | 'tool-heavy' | 'plugin-fail';

export interface RunHandle {
  id: number;
  page: Page;
  waitForTerminalText(needle: string, opts?: { timeoutMs?: number }): Promise<void>;
  terminalText(): Promise<string>;
  expectScrolledToBottom(): Promise<void>;
  destroy(): Promise<void>;
}

/** Creates a project (idempotent) then navigates to /projects/:id/runs/new and submits a mock run. */
export async function createMockRun(
  page: Page,
  opts: { scenario: ScenarioName; prompt?: string },
): Promise<RunHandle> {
  // Ensure a project exists. Use the API for setup; UI test focuses on the run flow.
  const projectId = await ensureProject(page);
  await page.goto(`/projects/${projectId}/runs/new`);

  await page.getByPlaceholder(/Describe what Claude should do/i)
    .fill(opts.prompt ?? `quantico ${opts.scenario}`);
  await page.getByTestId('mockmode-toggle').click();
  await page.getByRole('checkbox').check();
  await page.getByTestId('mockmode-scenario-select').selectOption(opts.scenario);

  await page.getByRole('button', { name: /Start run/i }).click();
  await page.waitForURL(/\/projects\/\d+\/runs\/\d+/);
  const url = page.url();
  const id = Number(url.match(/runs\/(\d+)/)![1]);
  return wrap(id, page);
}

async function ensureProject(page: Page): Promise<number> {
  const res = await page.request.get('/api/projects');
  const list = await res.json();
  if (list.length > 0) return list[0].id;
  const created = await page.request.post('/api/projects', {
    data: { name: 'e2e', repo_url: '/tmp/empty-repo.git', default_branch: 'main' },
  });
  return (await created.json()).id;
}

function wrap(id: number, page: Page): RunHandle {
  return {
    id, page,
    async waitForTerminalText(needle, opts) {
      await expect(page.getByTestId('xterm')).toContainText(needle, { timeout: opts?.timeoutMs ?? 30_000 });
    },
    async terminalText() {
      return (await page.getByTestId('xterm').textContent()) ?? '';
    },
    async expectScrolledToBottom() {
      const atBottom = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement | null;
        if (!el) return false;
        return Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 4;
      });
      expect(atBottom).toBe(true);
    },
    async destroy() {
      await page.request.delete(`/api/runs/${id}`).catch(() => {});
    },
  };
}
```

(If `[data-testid="xterm"]` / `[data-testid="xterm-viewport"]` are not yet in the terminal component, add them in this task — search `RunTerminal.tsx` and add `data-testid="xterm"` to the outer wrapper and `data-testid="xterm-viewport"` to the scroll container.)

- [ ] **Step 5: Smoke**

Run: `cd /workspace && npx playwright test --list`
Expected: lists 0 specs (none yet) but no config error.

- [ ] **Step 6: Commit**

```bash
cd /workspace && git add package.json package-lock.json playwright.config.ts tests/e2e/quantico/helpers.ts src/web/features/runs/RunTerminal.tsx && git commit -m "test(e2e): playwright config + Quantico helpers"
```

---

### Task 33: First spec — `default.spec.ts`

**Files:**
- Create: `tests/e2e/quantico/default.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('default scenario: runs to completion with output', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'default' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });
    await run.waitForTerminalText('Done.', { timeoutMs: 30_000 });
    await run.expectScrolledToBottom();
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Run the spec**

Run: `cd /workspace && npx playwright test tests/e2e/quantico/default.spec.ts`
Expected: green (assumes `cli/quantico/dist/quantico-linux-amd64` exists; if missing, the test will fail with a clear error from the orchestrator pre-flight — run `npm run cli:quantico:build` first).

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add tests/e2e/quantico/default.spec.ts && git commit -m "test(e2e): default scenario completion"
```

---

### Task 34: ansi.spec.ts

**Files:**
- Create: `tests/e2e/quantico/ansi.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('ansi: tool-heavy scenario produces styled spans', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'tool-heavy' });
  try {
    await run.waitForTerminalText('Read', { timeoutMs: 30_000 });
    // xterm.js renders SGR foregrounds as `xterm-fg-N` / bold as `xterm-bold`.
    const styled = page.locator('[data-testid="xterm"] .xterm-fg-36, [data-testid="xterm"] .xterm-bold').first();
    await expect(styled).toBeVisible();
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/ansi.spec.ts && git add tests/e2e/quantico/ansi.spec.ts && git commit -m "test(e2e): ansi scenario styled output"
```

---

### Task 35: auto-scroll.spec.ts

**Files:**
- Create: `tests/e2e/quantico/auto-scroll.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('auto-scroll: stays pinned during steady output', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'chatty' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });
    await page.waitForTimeout(2_000); // let several lines accumulate
    await run.expectScrolledToBottom();

    // Manually scroll up: should stop pinning.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = 0;
    });
    await page.waitForTimeout(2_000);
    const stillTop = await page.evaluate(() =>
      (document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement).scrollTop,
    );
    expect(stillTop).toBeLessThan(50);

    // Scroll back to bottom: should re-pin.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(2_000);
    await run.expectScrolledToBottom();
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/auto-scroll.spec.ts && git add tests/e2e/quantico/auto-scroll.spec.ts && git commit -m "test(e2e): auto-scroll pin/unpin behavior"
```

---

### Task 36: env-echo.spec.ts

**Files:**
- Create: `tests/e2e/quantico/env-echo.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('env-echo: orchestrator env reaches the agent', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'env-echo' });
  try {
    await run.waitForTerminalText('[quantico] env.RUN_ID=', { timeoutMs: 30_000 });
    const text = await run.terminalText();
    expect(text).toMatch(/env\.RUN_ID=\d+/);
    expect(text).toContain('env.GIT_AUTHOR_EMAIL=e2e@example.com');
    expect(text).toContain('env.MOCK_CLAUDE_SCENARIO=env-echo');
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/env-echo.spec.ts && git add tests/e2e/quantico/env-echo.spec.ts && git commit -m "test(e2e): env-echo verifies orchestrator env propagation"
```

---

### Task 37: limit-resume.spec.ts

**Files:**
- Create: `tests/e2e/quantico/limit-resume.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('limit-breach triggers waiting-state, then auto-resumes', async ({ page }) => {
  // Test harness sets FBI_LIMIT_MONITOR_IDLE_MS=300 and WARMUP_MS=200,
  // so the detector will fire ~500ms after the breach line.
  const run = await createMockRun(page, { scenario: 'limit-breach' });
  try {
    await run.waitForTerminalText('Claude usage limit reached', { timeoutMs: 30_000 });

    // The run-state badge should reflect the awaiting-resume state.
    const stateBadge = page.getByTestId('run-state-badge');
    await expect(stateBadge).toContainText(/awaiting|waiting|paused/i, { timeout: 15_000 });

    // After the (sped-up) reset window, auto-resume fires and the run goes back to running.
    // Trigger via the API to skip wall-clock waits in the test:
    await page.request.post(`/api/runs/${run.id}/resume-now`);
    await expect(stateBadge).toContainText(/running/i, { timeout: 30_000 });

    // The resume marker line proves Quantico saw --resume on the second invocation.
    await run.waitForTerminalText('[quantico] resumed from', { timeoutMs: 30_000 });
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/limit-resume.spec.ts && git add tests/e2e/quantico/limit-resume.spec.ts && git commit -m "test(e2e): limit-breach + auto-resume end-to-end"
```

---

### Task 38: crash.spec.ts

**Files:**
- Create: `tests/e2e/quantico/crash.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('crash-fast exits 1 and marks run failed', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'crash-fast' });
  try {
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/failed|errored/i, { timeout: 30_000 });
    await expect(page.getByTestId('run-exit-code')).toContainText('1');
  } finally {
    await run.destroy();
  }
});

test('hang ignores SIGTERM but is killed when stop is requested', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'hang' });
  try {
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/running/i, { timeout: 15_000 });
    // Trigger stop via the existing API. Supervisor should escalate to SIGKILL.
    await page.request.post(`/api/runs/${run.id}/stop`).catch(() => {});
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/stopped|failed|errored/i, { timeout: 30_000 });
  } finally {
    await run.destroy();
  }
});
```

If `data-testid="run-exit-code"` is not on the run-detail header, add it to the same component that shows the badge, in this task.

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/crash.spec.ts && git add tests/e2e/quantico/crash.spec.ts src/web/features/runs/RunHeader.tsx && git commit -m "test(e2e): crash-fast + hang scenarios"
```

---

### Task 39: resume-aware.spec.ts

**Files:**
- Create: `tests/e2e/quantico/resume-aware.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('continue-run path: second run sees prior session and emits resume marker', async ({ page }) => {
  const first = await createMockRun(page, { scenario: 'default' });
  await first.waitForTerminalText('Done.', { timeoutMs: 30_000 });

  // Drive the existing "Continue run" UI from the run detail.
  await page.getByRole('button', { name: /Continue run/i }).click();
  await page.waitForURL(/\/projects\/\d+\/runs\/\d+/);
  const secondId = Number(page.url().match(/runs\/(\d+)/)![1]);

  await expect(page.getByTestId('xterm'))
    .toContainText('[quantico] resumed from', { timeout: 30_000 });

  await page.request.delete(`/api/runs/${first.id}`).catch(() => {});
  await page.request.delete(`/api/runs/${secondId}`).catch(() => {});
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/resume-aware.spec.ts && git add tests/e2e/quantico/resume-aware.spec.ts && git commit -m "test(e2e): continue-run resume-aware flow"
```

---

### Task 40: garbled.spec.ts

**Files:**
- Create: `tests/e2e/quantico/garbled.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('garbled: malformed UTF-8 + escape sequences do not crash the renderer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const run = await createMockRun(page, { scenario: 'garbled' });
  try {
    // Wait long enough for the scenario to dump its junk and exit.
    await page.waitForTimeout(5_000);
    // The terminal element must still be in the DOM.
    await expect(page.getByTestId('xterm')).toBeVisible();
    // No "WebSocket disconnected" banner should appear.
    await expect(page.getByTestId('terminal-disconnected-banner')).toHaveCount(0);
    // No uncaught page errors.
    expect(errors).toEqual([]);
  } finally {
    await run.destroy();
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /workspace && npx playwright test tests/e2e/quantico/garbled.spec.ts && git add tests/e2e/quantico/garbled.spec.ts && git commit -m "test(e2e): garbled output does not crash renderer"
```

---

### Task 41: e2e CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Append a job**

```yaml
  e2e-quantico:
    name: E2E (Playwright + Quantico)
    runs-on: ubuntu-latest
    needs: rust  # ensure Quantico binary is build-able
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - uses: dtolnay/rust-toolchain@stable
      - name: Install deps
        run: npm ci
      - name: Build Quantico
        run: npm run cli:quantico:build
      - name: Stage binary
        run: |
          mkdir -p dist/cli
          cp cli/quantico/dist/quantico-x86_64-unknown-linux-gnu dist/cli/quantico-linux-amd64
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      - name: Run e2e
        env:
          FBI_QUANTICO_BINARY_PATH: ${{ github.workspace }}/dist/cli/quantico-linux-amd64
        run: npm run e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report
```

- [ ] **Step 2: Commit**

```bash
cd /workspace && git add .github/workflows/ci.yml && git commit -m "ci(e2e): run Playwright + Quantico suite"
```

---

## Phase 8 — Fidelity probe (scheduled)

### Task 42: Weekly cron workflow that diffs real Claude output against snapshot

**Files:**
- Create: `.github/workflows/quantico-fidelity.yml`
- Create: `cli/quantico/fidelity-snapshot.json`

- [ ] **Step 1: Create the snapshot**

`cli/quantico/fidelity-snapshot.json`:

```json
{
  "limit_message_template": "Claude usage limit reached|<EPOCH>",
  "limit_message_human_template": "Claude usage limit reached. Your limit will reset at <TIME>.",
  "session_jsonl_path_pattern": "$HOME/.claude/projects/<encoded-cwd>/<uuid>.jsonl",
  "jsonl_required_fields": ["type", "timestamp"]
}
```

- [ ] **Step 2: Workflow — manual-only opener; live probe requires a future credentials-PR**

```yaml
name: Quantico Fidelity Probe

on:
  schedule:
    - cron: '0 6 * * 1'  # weekly Mondays 06:00 UTC
  workflow_dispatch: {}

jobs:
  probe:
    runs-on: ubuntu-latest
    if: ${{ github.event_name == 'workflow_dispatch' || vars.QUANTICO_FIDELITY_LIVE == '1' }}
    steps:
      - uses: actions/checkout@v4
      - name: Show snapshot the probe will diff against
        run: cat cli/quantico/fidelity-snapshot.json
      - name: Validate snapshot is well-formed JSON
        run: jq empty cli/quantico/fidelity-snapshot.json
      - name: Note for the operator
        run: |
          echo "Fidelity probe is gated on the QUANTICO_FIDELITY_LIVE repo variable."
          echo "Set it to 1 only after CLAUDE_OAUTH_TOKEN is added as a repo secret."
          echo "When enabled, this job invokes real claude with a known prompt and"
          echo "diffs the limit-message wording / JSONL field set against the snapshot."
```

This job intentionally does no live-Claude calls today — it validates the snapshot file shape and prints operator instructions. The live probe is out of scope for this plan; enabling it in a follow-up PR requires only adding the secret, the variable, and a script step that drives `claude` and `diff`s.

- [ ] **Step 3: Commit**

```bash
cd /workspace && git add .github/workflows/quantico-fidelity.yml cli/quantico/fidelity-snapshot.json && git commit -m "ci(quantico): scheduled fidelity-probe scaffold"
```

---

## Final task: full-suite green

### Task 43: Run everything

- [ ] Run: `cd /workspace && npm test && npm run typecheck && cargo test -p quantico && cd server-elixir && mix test && cd .. && npm run cli:quantico:build && npm run e2e`
- [ ] All green.
- [ ] Push the branch (already on `feat/test-framework`); do not merge to main.

---

## Notes for the executor

- `cli/quantico/scenarios.json` is hand-committed; the test in Task 12 verifies it stays in sync with `BUILT_IN_NAMES`. If you add a scenario, update both.
- The TS and Elixir orchestrator branches must stay symmetric. After Task 21 and Task 27, sanity-check by grepping both for `mock` and `quantico` and confirming one-for-one features.
- `RunTerminal.tsx` may need `data-testid` annotations added in Task 32. Treat that as a tiny scope creep, in-line with the test layer it enables.
- The capability flag is the single off-switch. Never expose mock mode without `FBI_QUANTICO_ENABLED=1`.
- Quantico is a Linux ELF; it runs *inside* the run container, not on the host. macOS developers can still run `npm run e2e` — the Mac dev server only bind-mounts the file into Docker. They must run `npm run cli:quantico:build` first; the `Makefile`'s linux targets need either an aarch64-linux-gnu / x86_64-linux-gnu cross-linker on the path, or the same Docker-based cross-compile pattern `scripts/build-cli-dist.sh` already implements for `fbi-tunnel`.
