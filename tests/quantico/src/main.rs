mod argv;
mod executor;
mod jsonl;
mod limit;
mod prompt_token;
mod scenario;

use std::io::{IsTerminal, Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = argv::parse(&args);
    let exit_code = match invocation {
        argv::Invocation::PluginMarketplaceAdd(name) => {
            if std::env::var("MOCK_CLAUDE_SCENARIO").as_deref() == Ok("plugin-fail") {
                eprintln!("[quantico] marketplace add failed (scenario): {}", name);
                1
            } else {
                println!("[quantico] marketplace added: {}", name);
                0
            }
        }
        argv::Invocation::PluginInstall(name) => {
            if std::env::var("MOCK_CLAUDE_SCENARIO").as_deref() == Ok("plugin-fail") {
                eprintln!("[quantico] plugin install failed (scenario): {}", name);
                1
            } else {
                println!("[quantico] plugin installed: {}", name);
                0
            }
        }
        argv::Invocation::Unsupported(arg) => {
            eprintln!("quantico: unsupported argument: {}", arg);
            2
        }
        // --capture-bytes: write deterministic byte-stream fixture for diff harness.
        // Mutually exclusive with normal execution — no timing, no exit step, no side effects.
        argv::Invocation::CaptureBytes {
            scenario: name,
            scenario_file,
            path,
        } => do_capture_bytes(name.as_deref(), scenario_file.as_deref(), &path),
        argv::Invocation::Run {
            scenario: name,
            scenario_file,
            resume_session_id,
        } => {
            // Resolve scenario per the design doc precedence:
            //   1. --scenario-file / scenario_file (caller-supplied YAML)
            //   2. @quantico:<name>@ token in the prompt on stdin
            //   3. --scenario <name> CLI flag
            //   4. MOCK_CLAUDE_SCENARIO env var
            //   5. built-in "default" (handled in run_scenario)
            let resolved_name = if scenario_file.is_some() {
                name // scenario_file wins; --scenario is moot
            } else {
                let mut prompt_text = String::new();
                if !std::io::stdin().is_terminal() {
                    let _ = std::io::stdin().read_to_string(&mut prompt_text);
                }
                prompt_token::extract(&prompt_text)
                    .or(name)
                    .or_else(|| std::env::var("MOCK_CLAUDE_SCENARIO").ok())
            };
            run_scenario(
                resolved_name.as_deref(),
                scenario_file.as_deref(),
                resume_session_id.as_deref(),
            )
        }
    };
    std::process::exit(exit_code);
}

/// Collect all `emit_ansi` (and `emit`) payloads from `scenario` in order,
/// concatenated as raw bytes — no timing, no exit, no side effects.
/// This is the primitive used to produce deterministic byte-stream fixtures
/// for the diff harness (fbi-term-core vs @xterm/headless).
///
/// Note: `sleep_ms` and `exit` steps are intentionally skipped because they
/// are runtime behaviors irrelevant to the byte content of the fixture.
/// Only `emit_ansi` / `emit` steps produce output bytes; everything else is
/// ignored so the capture is purely about what bytes the scenario would write.
pub fn capture_bytes(scenario: &scenario::Scenario) -> Vec<u8> {
    let mut buf = Vec::new();
    for step in &scenario.steps {
        match step {
            scenario::Step::Emit(s) | scenario::Step::EmitAnsi(s) => {
                buf.extend_from_slice(s.as_bytes());
            }
            // sleep_ms: ignored — no timing in capture mode
            // exit: ignored — we exit 0 after writing the file, not mid-stream
            // sleep_forever, echo_env, write_jsonl, emit_limit_breach:
            //   all skipped because they either block or produce side effects
            //   that are meaningless for a static byte-stream fixture.
            _ => {}
        }
    }
    buf
}

/// Handler for `--capture-bytes <PATH>`: load scenario, collect emit payloads,
/// write to path as raw bytes, exit 0.
fn do_capture_bytes(name: Option<&str>, scenario_file: Option<&str>, path: &str) -> i32 {
    let scenario = if let Some(file_path) = scenario_file {
        match std::fs::read_to_string(file_path) {
            Ok(yaml) => match scenario::Scenario::parse(&yaml) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("quantico: bad scenario file: {}", e);
                    return 2;
                }
            },
            Err(e) => {
                eprintln!("quantico: cannot read scenario file: {}", e);
                return 2;
            }
        }
    } else {
        let n = name.unwrap_or("default");
        match scenario::lookup(n) {
            Some(s) => s,
            None => {
                eprintln!("quantico: unknown scenario: {}", n);
                return 2;
            }
        }
    };

    let bytes = capture_bytes(&scenario);
    match std::fs::write(path, &bytes) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("quantico: cannot write capture file {}: {}", path, e);
            1
        }
    }
}

fn run_scenario(
    name: Option<&str>,
    scenario_file: Option<&str>,
    resume_session_id: Option<&str>,
) -> i32 {
    let scenario = if let Some(path) = scenario_file {
        match std::fs::read_to_string(path) {
            Ok(yaml) => match scenario::Scenario::parse(&yaml) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("quantico: bad scenario file: {}", e);
                    return 2;
                }
            },
            Err(e) => {
                eprintln!("quantico: cannot read scenario file: {}", e);
                return 2;
            }
        }
    } else {
        let n = name.unwrap_or("default");
        match scenario::lookup(n) {
            Some(s) => s,
            None => {
                eprintln!("quantico: unknown scenario: {}", n);
                return 2;
            }
        }
    };

    let speed_mult: f64 = std::env::var("MOCK_CLAUDE_SPEED_MULT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "?".into());
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
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), "[quantico] resumed from {}", session_id);
    }

    let env_get = |k: &str| std::env::var(k).ok();
    let mut stdout = std::io::stdout();
    let mut ctx = executor::ExecCtx {
        stdout: &mut stdout,
        speed_mult,
        env: &env_get,
        cwd,
        argv,
        session_path,
    };
    match executor::run(&scenario, &mut ctx) {
        Ok(executor::Outcome::Exited(c)) => c,
        Ok(executor::Outcome::SleepingForever) => {
            // Block forever (until SIGKILL). SIGTERM honoured by default.
            loop {
                std::thread::park();
            }
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "quantico: io error: {}", e);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::{Scenario, Step};

    #[test]
    fn capture_bytes_concatenates_emit_ansi_steps() {
        let scenario = Scenario {
            name: "test".into(),
            steps: vec![
                Step::EmitAnsi("hello".into()),
                Step::SleepMs(100), // must be skipped
                Step::EmitAnsi(" world".into()),
                Step::Exit(0), // must be skipped
            ],
        };
        let captured = capture_bytes(&scenario);
        assert_eq!(captured, b"hello world");
    }

    #[test]
    fn capture_bytes_includes_emit_steps() {
        // Both Emit and EmitAnsi contribute bytes.
        let scenario = Scenario {
            name: "test".into(),
            steps: vec![Step::Emit("plain".into()), Step::EmitAnsi(" ansi".into())],
        };
        let captured = capture_bytes(&scenario);
        assert_eq!(captured, b"plain ansi");
    }

    #[test]
    fn capture_bytes_skips_non_emit_steps() {
        // sleep_forever, echo_env, write_jsonl produce no bytes in capture mode.
        let scenario = Scenario {
            name: "test".into(),
            steps: vec![
                Step::EmitAnsi("a".into()),
                Step::SleepMs(9999),
                Step::EchoEnv(vec!["HOME".into()]),
                Step::EmitAnsi("b".into()),
                Step::Exit(42),
            ],
        };
        let captured = capture_bytes(&scenario);
        assert_eq!(captured, b"ab");
    }

    #[test]
    fn capture_bytes_garbled_roundtrip() {
        // Verify the capture is byte-for-byte identical to what the normal run
        // path emits.  The garbled scenario YAML uses escape sequences like
        // `\xc3\x28`; serde_yaml interprets `\xc3` as the Unicode codepoint
        // U+00C3 (Ã) which is encoded in UTF-8 as the two bytes [0xc3, 0x83].
        // So the actual byte sequence in the String is [c3 83 28], not [c3 28].
        // Our job is to capture exactly what `s.as_bytes()` produces — the
        // same conversion the normal execution path uses — and assert that
        // the expected marker bytes are present.
        let scenario = crate::scenario::lookup("garbled").expect("garbled scenario must exist");
        let captured = capture_bytes(&scenario);
        // The YAML \xc3 → U+00C3 → UTF-8 [0xc3, 0x83]; followed by \x28 → [0x28].
        assert!(
            captured.windows(3).any(|w| w == [0xc3, 0x83, 0x28]),
            "expected serde_yaml-decoded bytes [c3 83 28] in capture (from YAML \\xc3\\x28)"
        );
        // \xff → U+00FF (ÿ) → UTF-8 [0xc3, 0xbf]; \xfe → U+00FE (þ) → [0xc3, 0xbe].
        assert!(
            captured.windows(2).any(|w| w == [0xc3, 0xbf]),
            "expected [c3 bf] (from YAML \\xff) in capture"
        );
        // The capture must match normal execution byte-for-byte.
        let mut normal_buf: Vec<u8> = Vec::new();
        {
            use std::path::PathBuf;
            fn fake_env(_: &str) -> Option<String> {
                None
            }
            let mut ctx = executor::ExecCtx {
                stdout: &mut normal_buf,
                speed_mult: 99999.0, // skip sleeps
                env: &fake_env,
                cwd: "/".into(),
                argv: vec![],
                session_path: PathBuf::from("/tmp/dummy-garbled-test.jsonl"),
            };
            let _ = executor::run(&scenario, &mut ctx);
        }
        assert_eq!(
            captured, normal_buf,
            "capture_bytes output must be byte-for-byte identical to normal execution"
        );
    }
}
