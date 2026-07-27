//! Shared ExifTool argfile rendering and raw write execution.
//!
//! This module deliberately knows nothing about draft identities or metadata
//! targets. All semantic values are written in one `-n` invocation so ExifTool
//! does not reinterpret canonical values through PrintConv.

use std::io::Write;
use std::path::Path;

pub(crate) fn render_argfile_argument(arg: &str) -> Result<String, String> {
    if arg.contains('\0') {
        return Err("ExifTool argfile cannot encode argument containing NUL".to_string());
    }

    let needs_cstr = arg.contains('\n')
        || arg.contains('\r')
        || arg.contains('\t')
        || arg.contains('\\')
        || arg.starts_with('#')
        || arg.starts_with(char::is_whitespace)
        || arg.ends_with(char::is_whitespace)
        || arg.is_empty();

    if !needs_cstr {
        return Ok(arg.to_string());
    }

    let mut escaped = String::new();
    for ch in arg.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c => escaped.push(c),
        }
    }

    Ok(format!("#[CSTR]{}", escaped))
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
    ];
    logical_args.extend(args.iter().cloned());
    logical_args.push(path.to_string_lossy().into_owned());
    Ok(logical_args)
}

pub(crate) fn render_exiftool_argfile(logical_args: &[String]) -> Result<String, String> {
    let mut rendered_lines = Vec::with_capacity(logical_args.len());
    for arg in logical_args {
        rendered_lines.push(render_argfile_argument(arg)?);
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
            "-overwrite_original\n-charset\nutf8\n-charset\nfilename=utf8\n-n\n-IFD0:Orientation=6\nfile.jpg\n"
        );
    }

    #[test]
    fn cstr_rendering_preserves_every_significant_text_edge() {
        let cases = [
            ("carriage\rreturn", "#[CSTR]carriage\\rreturn"),
            ("line\nfeed", "#[CSTR]line\\nfeed"),
            ("tab\tvalue", "#[CSTR]tab\\tvalue"),
            (r"back\\slash", r"#[CSTR]back\\\\slash"),
            ("#comment-looking", "#[CSTR]#comment-looking"),
            (" leading", "#[CSTR] leading"),
            ("trailing ", "#[CSTR]trailing "),
            ("", "#[CSTR]"),
        ];
        for (input, expected) in cases {
            assert_eq!(render_argfile_argument(input).unwrap(), expected);
        }
        assert!(render_argfile_argument("embedded\0nul")
            .unwrap_err()
            .contains("NUL"));
    }

    #[test]
    fn argfile_preserves_argument_order_physical_lines_and_deterministic_bytes() {
        let logical = build_exiftool_write_argfile_args(
            Path::new("file.jpg"),
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
            "-overwrite_original\n-charset\nutf8\n-charset\nfilename=utf8\n-n\n#[CSTR]-XMP-dc:Title= first \n#[CSTR]-XMP-dc:Description=line one\\nline two\n-XMP-dc:Rights=#reserved\nfile.jpg\n"
        );
        assert_eq!(first.lines().count(), logical.len());
        assert!(first.ends_with('\n'));
    }
}
