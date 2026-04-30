use fbi_term_core::Parser;
use std::process::Command;

const FIXTURES: &[&str] = &[
    "alt-screen-cycle",
    "bracketed-paste-cycle",
    "chatty",
    "cjk-wide",
    "crash-fast",
    "cursor-styles",
    "default",
    "env-echo",
    "garbled",
    "hang",
    "limit-breach-human",
    "limit-breach",
    "mouse-modes-cycle",
    "plugin-fail",
    "resume-aware",
    "scroll-region-stress",
    "scrollback-stress",
    "slow-startup",
    "tool-heavy",
    "truecolor",
];

const COLS: u16 = 80;
const ROWS: u16 = 24;

/// Convert bare LF (\n not preceded by \r) to CRLF.
/// This normalizes the "pending wrap + LF" edge case where alacritty and
/// xterm.js behave differently: alacritty keeps the pending-wrap flag through
/// a bare LF, while xterm.js clears it. With CRLF the cursor is always reset
/// to column 0 first, so both emulators produce identical output.
fn normalize_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 16);
    let mut prev = 0u8;
    for &b in bytes {
        if b == b'\n' && prev != b'\r' {
            out.push(b'\r');
        }
        out.push(b);
        prev = b;
    }
    out
}

fn dump_rust(name: &str) -> serde_json::Value {
    let path = format!("tests/fixtures/{}.bin", name);
    let raw = std::fs::read(&path).expect("fixture exists");
    let bytes = normalize_lf(&raw);
    let mut p = Parser::new(COLS, ROWS);
    p.feed(&bytes);
    let dump = p.grid_dump();
    serde_json::to_value(&dump).unwrap()
}

fn dump_node(name: &str) -> serde_json::Value {
    let path = format!("tests/fixtures/{}.bin", name);
    let raw = std::fs::read(&path).expect("fixture exists");
    let bytes = normalize_lf(&raw);
    // Write preprocessed bytes to a temp file
    let tmp_path = format!("/tmp/diff_xterm_{}.bin", name);
    std::fs::write(&tmp_path, &bytes).expect("write temp file");
    let dims = format!("{}x{}", COLS, ROWS);
    let out = Command::new("node")
        .args(["tests/support/xterm_ref.mjs", &tmp_path, &dims])
        .output()
        .expect("node available; deps installed");
    std::fs::remove_file(&tmp_path).ok();
    if !out.status.success() {
        panic!(
            "xterm_ref.mjs failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    serde_json::from_slice(&out.stdout).expect("xterm_ref output is JSON")
}

fn normalize(v: &mut serde_json::Value) {
    // Normalize wide-char cells: in Rust, wide spacers are null; in xterm.js,
    // they are default spaces. Normalize both to skip spacers and set wide=false.
    normalize_wide_cells(v);

    // Trim trailing default cells per row.
    let cells = v.get_mut("cells").unwrap().as_array_mut().unwrap();
    for row in cells.iter_mut() {
        let arr = row.as_array_mut().unwrap();
        while let Some(last) = arr.last() {
            if is_default_cell(last) {
                arr.pop();
            } else {
                break;
            }
        }
    }

    // Normalize fields that differ between Rust and xterm.js representation.
    // scroll_region: xterm.js always outputs {top:0, bottom:rows-1}, so canonicalize both.
    if let Some(sr) = v.get_mut("scroll_region") {
        *sr = serde_json::json!({"top": 0, "bottom": ROWS - 1});
    }
    // mode_flags: xterm.js only exposes auto_wrap (as proxy). Remove extra fields.
    if let Some(mf) = v.get_mut("mode_flags") {
        let auto_wrap = mf
            .get("auto_wrap")
            .cloned()
            .unwrap_or(serde_json::json!(true));
        *mf = serde_json::json!({"auto_wrap": auto_wrap});
    }
    // cursor.visible: xterm.js always returns true (proxy). Normalize both to true.
    if let Some(cursor) = v.get_mut("cursor") {
        if let Some(vis) = cursor.get_mut("visible") {
            *vis = serde_json::json!(true);
        }
    }
}

/// Normalize wide-char cells across both Rust and xterm.js outputs.
///
/// In alacritty: wide char cell has wide=true; the NEXT cell is null (spacer).
/// In xterm.js: CJK chars have wide=true (spacer follows as default space);
///   emoji have wide=false (no spacer — xterm.js headless treats emoji as narrow).
///
/// Strategy (using only the `wide` flag, NOT unicode_width):
/// 1. Walk each row. After a cell with wide=true, mark next as spacer.
///    In alacritty the spacer is already null; in xterm it's a default space.
///    Replace both spacer representations with null.
/// 2. Set wide=false on all wide=true cells.
/// 3. Strip all null cells from both sides (dense comparison).
///    This also handles the emoji case: alacritty emits null spacers after
///    emoji (wide=true) that get stripped; xterm emits no spacers since it
///    treats emoji as narrow — the explicit source spaces between emoji land
///    in the same positions in both after stripping nulls.
fn normalize_wide_cells(v: &mut serde_json::Value) {
    let cells = v.get_mut("cells").unwrap().as_array_mut().unwrap();
    for row in cells.iter_mut() {
        let arr = row.as_array_mut().unwrap();
        // Pass 1: mark spacers, normalize wide flag
        let mut step1: Vec<serde_json::Value> = Vec::with_capacity(arr.len());
        let mut skip_next = false;
        for cell in arr.drain(..) {
            if skip_next {
                skip_next = false;
                step1.push(serde_json::Value::Null); // spacer → null
                continue;
            }
            if cell.is_null() {
                step1.push(cell); // already null spacer (Rust side)
                continue;
            }
            let obj = cell.as_object().unwrap();
            let is_wide = obj.get("wide").and_then(|v| v.as_bool()).unwrap_or(false);
            if is_wide {
                skip_next = true;
                let mut new_cell = obj.clone();
                new_cell.insert("wide".to_string(), serde_json::json!(false));
                step1.push(serde_json::Value::Object(new_cell));
            } else {
                step1.push(cell);
            }
        }
        // Pass 2: strip all nulls (dense representation)
        *arr = step1.into_iter().filter(|c| !c.is_null()).collect();
    }
}

fn is_default_cell(c: &serde_json::Value) -> bool {
    if c.is_null() {
        return true;
    }
    let obj = c.as_object().unwrap();
    obj.get("ch").map_or(true, |v| v == " ")
        && !obj
            .get("bold")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && !obj
            .get("italic")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && !obj
            .get("inverse")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && !obj
            .get("underline")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && !obj
            .get("strikethrough")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && !obj
            .get("dim")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && !obj
            .get("wide")
            .map_or(false, |v| v.as_bool().unwrap_or(false))
        && obj.get("fg_mode").map_or(true, |v| v == "default")
        && obj.get("bg_mode").map_or(true, |v| v == "default")
}

#[test]
fn diff_all_fixtures() {
    let mut failures = Vec::new();
    for &name in FIXTURES {
        let mut rust = dump_rust(name);
        let mut node = dump_node(name);
        normalize(&mut rust);
        normalize(&mut node);
        if rust != node {
            failures.push(format!(
                "fixture '{}' diverged:\n  rust: {}\n  node: {}\n",
                name,
                serde_json::to_string_pretty(&rust).unwrap(),
                serde_json::to_string_pretty(&node).unwrap(),
            ));
        }
    }
    if !failures.is_empty() {
        panic!("diff harness failures:\n\n{}", failures.join("\n---\n"));
    }
}
