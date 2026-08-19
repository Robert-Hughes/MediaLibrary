//! Embedded user-defined ExifTool config that registers the `XMP-mlib`
//! namespace.
//!
//! Why embedded rather than shipped as a loose file: we want the AI-metadata
//! namespace to be available wherever the app runs, but we must not write
//! into the user's existing exiftool install. The bytes live inside the
//! binary at build time and are materialised on first use to a stable path
//! under `<cache_dir>/MediaLibrary/`. The path is then passed to every
//! exiftool invocation via `-config <path>`.
//!
//! Re-materialisation is content-addressed: the on-disk file is overwritten
//! only when its contents differ from the embedded bytes, so app updates
//! that ship a new config take effect transparently.

use std::path::PathBuf;
use std::process::Command;
use std::sync::{OnceLock, RwLock};

const EMBEDDED_CONFIG: &[u8] = include_bytes!("../resources/mlib.ExifTool_config");

/// Lazy cache of the materialised config path.  `Some` if we successfully
/// wrote (or found an up-to-date) config file; `None` if materialisation
/// failed (e.g. no writable cache dir).  When `None`, callers fall back to
/// invoking exiftool without `-config`, which still works for every tag
/// outside the `XMP-mlib` namespace.
static CONFIG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static EXIFTOOL_COMMAND: OnceLock<RwLock<String>> = OnceLock::new();

pub fn set_exiftool_command(command: impl Into<String>) {
    let command = command.into();
    let lock =
        EXIFTOOL_COMMAND.get_or_init(|| RwLock::new(crate::settings::default_exiftool_command()));
    *lock.write().expect("ExifTool command lock poisoned") = command;
}

fn configured_exiftool_command() -> String {
    EXIFTOOL_COMMAND
        .get_or_init(|| RwLock::new(crate::settings::default_exiftool_command()))
        .read()
        .expect("ExifTool command lock poisoned")
        .clone()
}

/// Return the materialised config path, writing it to disk on first call.
///
/// Returns `None` if the file could not be materialised — callers should
/// continue without `-config` in that case, logging the issue once.
pub fn config_path() -> Option<&'static PathBuf> {
    CONFIG_PATH
        .get_or_init(|| match materialise_config() {
            Ok(path) => Some(path),
            Err(e) => {
                log::warn!(
                    "[exiftool_config] Could not materialise embedded config ({}); \
                     XMP-mlib writes will fail until resolved",
                    e
                );
                None
            }
        })
        .as_ref()
}

fn materialise_config() -> Result<PathBuf, String> {
    let dir = dirs::cache_dir()
        .ok_or_else(|| "no cache_dir available on this platform".to_string())?
        .join("MediaLibrary");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create_dir_all({}): {}", dir.display(), e))?;
    let path = dir.join("mlib.ExifTool_config");

    // Content-addressed write: only touch the file when contents differ.
    // Cheap byte-compare; the file is ~1 KB.
    let needs_write = match std::fs::read(&path) {
        Ok(existing) => existing != EMBEDDED_CONFIG,
        Err(_) => true,
    };
    if needs_write {
        std::fs::write(&path, EMBEDDED_CONFIG)
            .map_err(|e| format!("write({}): {}", path.display(), e))?;
        log::info!(
            "[exiftool_config] Wrote embedded config to {}",
            path.display()
        );
    }
    Ok(path)
}

pub(crate) fn describe_command(command: &Command) -> String {
    std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(display_command_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

fn display_command_arg(arg: &std::ffi::OsStr) -> String {
    let value = arg.to_string_lossy();
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "/._-:=+@".contains(ch))
    {
        return value.into_owned();
    }

    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Build a `Command` that runs exiftool with `-config <embedded-path>` already
/// applied.  Use everywhere we shell out to exiftool so the `XMP-mlib`
/// namespace is always registered.
///
/// When config materialisation failed at startup, falls back to a bare
/// exiftool command — the user's exiftool install still handles every
/// non-`XMP-mlib` tag normally.
pub fn exiftool_command() -> Command {
    let mut cmd = Command::new(configured_exiftool_command());
    if let Some(path) = config_path() {
        cmd.arg("-config").arg(path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: suppress console window flash on each exiftool spawn.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_config_contains_mlib_namespace_marker() {
        // Sanity guard: if someone empties or corrupts the resource file,
        // the build still succeeds (it's just bytes) but the namespace
        // would be silently broken.  Catch that here.
        let s = std::str::from_utf8(EMBEDDED_CONFIG).expect("config is UTF-8");
        assert!(s.contains("XMP-mlib"), "config must declare XMP-mlib group");
        assert!(
            s.contains("AIDescription"),
            "config must declare AIDescription field"
        );
        assert!(
            s.contains("ReverseGeocodeGeocodeJSON") && s.contains("ReverseGeocodeJSONv2"),
            "config must declare both raw reverse-geocode evidence fields"
        );
        assert!(
            s.contains("medialibrary.local/ns/"),
            "namespace URI must be present"
        );
    }

    #[test]
    fn describe_command_includes_program_and_exact_arguments() {
        let mut command = Command::new("/path with spaces/exiftool");
        command.args(["-config", "/tmp/config with spaces", "-ver"]);

        assert_eq!(
            describe_command(&command),
            "'/path with spaces/exiftool' -config '/tmp/config with spaces' -ver"
        );
    }

    #[test]
    fn materialise_then_reuse_is_idempotent() {
        // First call writes the file; second call must not re-write
        // (content-addressed short-circuit).  We can't easily observe the
        // skip, but we can at least verify the path is stable and the
        // contents match the embedded bytes.
        let p1 = materialise_config().expect("materialise should succeed in test env");
        let p2 = materialise_config().expect("second materialise should succeed");
        assert_eq!(p1, p2);
        let on_disk = std::fs::read(&p1).expect("read materialised config");
        assert_eq!(on_disk, EMBEDDED_CONFIG);
    }
}
