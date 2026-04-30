use std::io::Write;
use std::path::PathBuf;

/// Returns the JSONL path Claude would write for the current cwd + session id.
/// Format mirrors real Claude: `$HOME/.claude/projects/<encoded-cwd>/<session>.jsonl`.
/// Encoded cwd: `/` → `-`, leading `-` preserved (so `/workspace` → `-workspace`).
pub fn session_path(home: &str, cwd: &str, session_id: &str) -> PathBuf {
    let encoded = cwd.replace('/', "-");
    PathBuf::from(home)
        .join(".claude/projects")
        .join(encoded)
        .join(format!("{}.jsonl", session_id))
}

pub fn append(path: &PathBuf, kind: &str, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
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
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
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
