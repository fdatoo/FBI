//// Minimal ANSI escape constants for server-side messages we inject into
//// terminal streams (e.g. system errors, banners). xterm.js renders these
//// the same way it renders the container's own output.
////
//// Keep this small. If we ever need full color/style tooling, pull in a
//// dedicated library — but most uses are "make this line stand out" and
//// don't justify the dependency surface.

const esc = "\u{001b}["

pub const reset = "\u{001b}[0m"

pub const bold = "\u{001b}[1m"

pub const dim = "\u{001b}[2m"

// Foreground colors.
pub const red = "\u{001b}[31m"

pub const green = "\u{001b}[32m"

pub const yellow = "\u{001b}[33m"

pub const blue = "\u{001b}[34m"

pub const magenta = "\u{001b}[35m"

pub const cyan = "\u{001b}[36m"

pub const gray = "\u{001b}[90m"

/// Wrap `s` with the given style and a reset. Useful when building short
/// banners — for streaming output where you write many styled chunks, prefer
/// concatenating the constants directly.
pub fn styled(s: String, with style: String) -> String {
  style <> s <> reset
}

/// Carriage-return + line-feed. Terminals running in raw mode (which is how
/// xterm.js receives our bytes) need both bytes for a clean newline.
pub const newline = "\r\n"

/// Internal: the CSI introducer, kept for callers that want to compose more
/// elaborate sequences without retyping the escape byte.
pub fn csi(rest: String) -> String {
  esc <> rest
}
