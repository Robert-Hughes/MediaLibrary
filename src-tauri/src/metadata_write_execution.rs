//! Shared ExifTool argfile rendering and raw write execution.
//!
//! This module deliberately knows nothing about draft identities or metadata
//! targets. All semantic values are written in one `-n` invocation so ExifTool
//! does not reinterpret canonical values through PrintConv.

use std::io::Write;
use std::path::Path;

fn escape_c_write_value(value: &str) -> Result<String, String> {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '\0' => {
                return Err("ExifTool argfile cannot encode argument containing NUL".to_string())
            }
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            ' ' => escaped.push_str("\\x20"),
            control if control <= '\u{1f}' || control == '\u{7f}' => {
                escaped.push_str(&format!("\\x{:02x}", control as u32));
            }
            other => escaped.push(other),
        }
    }
    Ok(escaped)
}

fn render_write_argument(arg: &str) -> Result<String, String> {
    if arg.contains('\0') {
        return Err("ExifTool argfile cannot encode argument containing NUL".to_string());
    }
    let Some(equals) = arg.find('=') else {
        return Err(format!(
            "ExifTool write argument has no assignment operator: {arg:?}"
        ));
    };
    let (assignment, value) = arg.split_at(equals + 1);
    if !assignment.starts_with('-')
        || assignment.contains(['\n', '\r', '\t', '\\'])
        || assignment.starts_with('#')
    {
        return Err(format!(
            "ExifTool write argument has an unsafe selector: {arg:?}"
        ));
    }
    Ok(format!("{assignment}{}", escape_c_write_value(value)?))
}

pub(crate) fn build_exiftool_write_argfile_args(
    path: &Path,
    args: &[String],
) -> Result<Vec<String>, String> {
    let mut logical_args = vec![
        "-overwrite_original".to_string(),
        "-charset".to_string(),
        "utf8".to_string(),
        "-charset".to_string(),
        "filename=utf8".to_string(),
        "-n".to_string(),
        "-ec".to_string(),
    ];
    logical_args.extend(
        args.iter()
            .map(|arg| render_write_argument(arg))
            .collect::<Result<Vec<_>, _>>()?,
    );
    let path = path.to_string_lossy().into_owned();
    if path.is_empty()
        || path.contains(['\0', '\n', '\r'])
        || path.starts_with('#')
        || path.starts_with(char::is_whitespace)
    {
        return Err(format!("Unsafe ExifTool argfile path: {path:?}"));
    }
    logical_args.push(path);
    Ok(logical_args)
}

pub(crate) fn render_exiftool_argfile(logical_args: &[String]) -> Result<String, String> {
    let mut rendered_lines = Vec::with_capacity(logical_args.len());
    for arg in logical_args {
        if arg.is_empty()
            || arg.contains(['\0', '\n', '\r'])
            || arg.starts_with('#')
            || arg.starts_with(char::is_whitespace)
        {
            return Err(format!("Unsafe ordinary ExifTool argfile line: {arg:?}"));
        }
        rendered_lines.push(arg.to_string());
    }
    let mut contents = rendered_lines.join("\n");
    contents.push('\n');
    Ok(contents)
}

/// Run one ExifTool write invocation with pre-rendered UTF-8 argfile contents.
pub(crate) fn run_exiftool_write(rendered_contents: &str) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("Failed to create ExifTool argfile: {e}"))?;
    let argfile_path = dir.path().join("medialibrary-exiftool.args");
    let mut argfile = std::fs::File::create(&argfile_path)
        .map_err(|e| format!("Failed to create ExifTool argfile: {e}"))?;
    argfile
        .write_all(rendered_contents.as_bytes())
        .map_err(|e| format!("Failed to write ExifTool argfile as UTF-8: {e}"))?;
    argfile
        .flush()
        .map_err(|e| format!("Failed to flush ExifTool argfile: {e}"))?;
    drop(argfile);

    let mut cmd = crate::exiftool_config::exiftool_command();
    cmd.arg("-@").arg(&argfile_path);

    let output = cmd.output().map_err(|e| {
        format!(
            "Failed to execute ExifTool: {}. Please ensure ExifTool is installed.",
            e
        )
    })?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!("ExifTool raw write failed: {}", stderr.trim()));
    }
    if !stderr.trim().is_empty() {
        log::warn!(
            "[apply_edits] ExifTool raw write emitted stderr: {}",
            stderr.trim()
        );
    }
    Ok(())
}

pub(crate) struct ApplyDiagnostics {
    pub(crate) error: Option<String>,
    pub(crate) warning: Option<String>,
}

pub(crate) fn format_apply_diagnostics(
    write_result: &Result<(), String>,
    verified_count: usize,
    total_count: usize,
) -> ApplyDiagnostics {
    if let Err(error) = write_result {
        let info = format!("ExifTool raw write failed ({error})");
        if verified_count == total_count {
            ApplyDiagnostics {
                error: None,
                warning: Some(format!(
                    "{}, but all intended tags verified successfully on readback.",
                    info
                )),
            }
        } else {
            ApplyDiagnostics {
                error: Some(format!(
                    "{}; post-write verification found {}/{} tags applied.",
                    info, verified_count, total_count
                )),
                warning: None,
            }
        }
    } else {
        ApplyDiagnostics {
            error: None,
            warning: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_write_layout_always_includes_numeric_mode() {
        let args = build_exiftool_write_argfile_args(
            Path::new("file.jpg"),
            &["-IFD0:Orientation=6".to_string()],
        )
        .unwrap();
        assert_eq!(
            render_exiftool_argfile(&args).unwrap(),
            "-overwrite_original\n-charset\nutf8\n-charset\nfilename=utf8\n-n\n-ec\n-IFD0:Orientation=6\nfile.jpg\n"
        );
    }

    #[test]
    fn ec_rendering_preserves_every_significant_text_edge_without_cstr() {
        let cases = [
            ("carriage\rreturn", "carriage\\rreturn"),
            ("line\nfeed", "line\\nfeed"),
            ("tab\tvalue", "tab\\tvalue"),
            (r"back\\slash", r"back\\\\slash"),
            ("#comment-looking", "#comment-looking"),
            (" leading", "\\x20leading"),
            ("trailing ", "trailing\\x20"),
            ("VAT @ 20% costs $5", "VAT\\x20@\\x2020%\\x20costs\\x20$5"),
            ("café 日本語 😀", "café\\x20日本語\\x20😀"),
            ("", ""),
        ];
        for (input, expected) in cases {
            assert_eq!(
                render_write_argument(&format!("-XMP-dc:Description={input}")).unwrap(),
                format!("-XMP-dc:Description={expected}")
            );
        }
        assert!(render_write_argument("-XMP-dc:Description=embedded\0nul")
            .unwrap_err()
            .contains("NUL"));
    }

    #[test]
    fn argfile_preserves_argument_order_physical_lines_and_deterministic_bytes() {
        let logical = build_exiftool_write_argfile_args(
            Path::new("VAT @ $ café.jpg"),
            &[
                "-XMP-dc:Title= first ".to_string(),
                "-XMP-dc:Description=line one\nline two".to_string(),
                "-XMP-dc:Rights=#reserved".to_string(),
            ],
        )
        .unwrap();
        let first = render_exiftool_argfile(&logical).unwrap();
        let second = render_exiftool_argfile(&logical).unwrap();
        assert_eq!(first.as_bytes(), second.as_bytes());
        assert_eq!(
            first,
            "-overwrite_original\n-charset\nutf8\n-charset\nfilename=utf8\n-n\n-ec\n-XMP-dc:Title=\\x20first\\x20\n-XMP-dc:Description=line\\x20one\\nline\\x20two\n-XMP-dc:Rights=#reserved\nVAT @ $ café.jpg\n"
        );
        assert_eq!(first.lines().count(), logical.len());
        assert!(first.ends_with('\n'));
    }
}
