/// Computes the absolute epoch second from a relative (e.g., "+1h") or absolute spec.
pub fn resolve_reset_epoch(now_secs: u64, spec: &str) -> u64 {
    if let Some(rest) = spec.strip_prefix('+') {
        if let Some(num) = rest.strip_suffix('s') {
            return now_secs + num.parse::<u64>().unwrap_or(0);
        }
        if let Some(num) = rest.strip_suffix('m') {
            return now_secs + 60 * num.parse::<u64>().unwrap_or(0);
        }
        if let Some(num) = rest.strip_suffix('h') {
            return now_secs + 3600 * num.parse::<u64>().unwrap_or(0);
        }
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
