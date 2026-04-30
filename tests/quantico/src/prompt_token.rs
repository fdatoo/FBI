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
        assert_eq!(
            extract("hi @quantico:limit-breach@ thanks"),
            Some("limit-breach".into())
        );
    }

    #[test]
    fn missing() {
        assert_eq!(extract("just a prompt"), None);
    }

    #[test]
    fn first_token_wins() {
        assert_eq!(
            extract("a @quantico:default@ b @quantico:other@"),
            Some("default".into())
        );
    }
}
