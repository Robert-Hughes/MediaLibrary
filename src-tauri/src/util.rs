/// Shared logging utilities used by lib.rs and scanner.rs.

use std::sync::OnceLock;

/// "<seconds>.<millis>" since the unix epoch — used as a uniform log prefix.
pub fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap();
    let millis = now.as_millis();
    format!("{}.{:03}", millis / 1000, millis % 1000)
}

static VERBOSE: OnceLock<bool> = OnceLock::new();

/// True when MEDIA_LIBRARY_VERBOSE is set to a non-empty, non-"0" value.
/// Result is cached for the lifetime of the process.
pub fn is_verbose() -> bool {
    *VERBOSE.get_or_init(|| {
        std::env::var("MEDIA_LIBRARY_VERBOSE")
            .map(|v| !v.is_empty() && v != "0")
            .unwrap_or(false)
    })
}

/// Print a timestamped log line to stderr.  Always emitted.
#[macro_export]
macro_rules! log_ts {
    ($($arg:tt)*) => {
        eprintln!("[{}] {}", $crate::util::timestamp(), format!($($arg)*))
    };
}

/// Print a timestamped log line to stderr only when MEDIA_LIBRARY_VERBOSE is on.
#[macro_export]
macro_rules! log_verbose {
    ($($arg:tt)*) => {
        if $crate::util::is_verbose() {
            eprintln!("[{}] [verbose] {}", $crate::util::timestamp(), format!($($arg)*))
        }
    };
}
