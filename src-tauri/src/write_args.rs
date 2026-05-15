//! exiftool argv construction for write-back.
//!
//! See `METADATA_FORMATS_DESIGN.md` §6 and `METADATA_FORMATS_PLAN.md` §5.
//!
//! This module produces unambiguous exiftool argv from typed `DraftEdit`s and
//! `TagInfo` schema entries.  It is **pure** — no exiftool subprocess, no
//! filesystem — so it is fully unit-testable and the test matrix can be
//! exhaustive.
//!
//! Output shape: `BuiltArgs { numeric, text }`.  Two groups so the caller can
//! run two exiftool invocations — one with `-n` for numeric/enum/boolean
//! values, one without for text/lang-alt/list-of-text — because `-n` is
//! global to an invocation.  Numeric runs first; text-group edits can depend
//! on numeric tags being already set (rare but possible for derived fields).

use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use crate::tag_schema::{EnumRepr, TagInfo, TagKind};

/// Output of `build_args` for one draft edit.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct BuiltArgs {
    /// Args for the `-n` exiftool invocation (raw numeric/enum/bool form).
    pub numeric: Vec<String>,
    /// Args for the no-`-n` invocation (text, lang-alt, lists of text).
    pub text: Vec<String>,
}

impl BuiltArgs {
    pub fn is_empty(&self) -> bool {
        self.numeric.is_empty() && self.text.is_empty()
    }

    /// Merge other into self, preserving group ordering.
    pub fn extend(&mut self, other: BuiltArgs) {
        self.numeric.extend(other.numeric);
        self.text.extend(other.text);
    }
}

/// Build exiftool argv for one tag/edit pair.
///
/// `tag` is the full `Group:Name` key as it appears in metadata (e.g.
/// `XMP-dc:Subject`).  `info` is `None` when the tag is not in the registry
/// — in that case we fall back to a text Set with a single `-TAG=value`.
pub fn build_args(tag: &str, info: Option<&TagInfo>, edit: &DraftEdit) -> BuiltArgs {
    // Validate tag name early.  exiftool tag names use alnum + a small set of
    // punctuation; refuse anything containing arg-list metacharacters that
    // could confuse exiftool's own parser.
    if tag.is_empty() || tag.contains('\n') || tag.contains('\0') {
        return BuiltArgs::default();
    }

    match edit.intent {
        EditIntent::Delete => BuiltArgs {
            // Delete is always `-TAG=` with no value.  Goes in the text group
            // since it has no value to interpret.
            numeric: vec![],
            text: vec![format!("-{}=", tag)],
        },
        EditIntent::Set => build_set(tag, info, edit.value.as_ref()),
        EditIntent::ListAdd => build_list_op(tag, info, edit.value.as_ref(), "+="),
        EditIntent::ListRemove => build_list_op(tag, info, edit.value.as_ref(), "-="),
    }
}

fn build_set(tag: &str, info: Option<&TagInfo>, value: Option<&Variant>) -> BuiltArgs {
    let kind = info.map(|i| &i.kind);
    match (kind, value) {
        // No value: treat as delete.
        (_, None) | (_, Some(Variant::Null)) => BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}=", tag)],
        },
        // Bag / Seq: explicit clear, then one -TAG=item per element.
        // Empty assignment first is the documented exiftool idiom for
        // "replace the whole list".
        (Some(TagKind::Bag(_)) | Some(TagKind::Seq(_)), Some(Variant::List(items))) => {
            // Lists of text live in the text group; lists of numeric kinds
            // are rare in exiftool's writable tag set and we currently treat
            // them as text too (numeric list items are scalar in the wire).
            let mut text = Vec::with_capacity(items.len() + 1);
            text.push(format!("-{}=", tag));
            for item in items {
                text.push(format!("-{}={}", tag, render_scalar_text(item)));
            }
            BuiltArgs { numeric: vec![], text }
        }
        // Bag / Seq with a single non-list value: treat as a single-element
        // list — easier than refusing it and matches user intent ("set the
        // keyword list to just this one item").
        (Some(TagKind::Bag(_)) | Some(TagKind::Seq(_)), Some(v)) => BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}=", tag), format!("-{}={}", tag, render_scalar_text(v))],
        },
        // LangAlt: emit one -TAG-lang=value per language.  Value must be a
        // Variant::Object whose keys are language codes; `x-default` is
        // expected as one of them.  Anything else is best-effort treated as
        // x-default.
        (Some(TagKind::LangAlt), Some(Variant::Object(langs))) => {
            let mut text = Vec::with_capacity(langs.len());
            for (lang, v) in langs {
                text.push(format!("-{}-{}={}", tag, lang, render_scalar_text(v)));
            }
            // Always include x-default if not explicitly provided.
            if !langs.contains_key("x-default") {
                if let Some(first) = langs.values().next() {
                    text.push(format!("-{}-x-default={}", tag, render_scalar_text(first)));
                }
            }
            BuiltArgs { numeric: vec![], text }
        }
        (Some(TagKind::LangAlt), Some(v)) => BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}-x-default={}", tag, render_scalar_text(v))],
        },
        // Numeric / boolean / enum-integer / GPS / rational: -n group.
        (Some(TagKind::Integer { .. }), Some(v))
        | (Some(TagKind::Real), Some(v))
        | (Some(TagKind::Rational), Some(v))
        | (Some(TagKind::Boolean), Some(v)) => BuiltArgs {
            numeric: vec![format!("-{}={}", tag, render_scalar_numeric(v))],
            text: vec![],
        },
        (Some(TagKind::Enum { repr: EnumRepr::Integer, .. }), Some(v)) => BuiltArgs {
            numeric: vec![format!("-{}={}", tag, render_scalar_numeric(v))],
            text: vec![],
        },
        // Enum-string: text group (we send the label/code as-is).
        (Some(TagKind::Enum { repr: EnumRepr::String, .. }), Some(v)) => BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}={}", tag, render_scalar_text(v))],
        },
        // DateTime: numeric group.  Per design §6, datetimes "where we send
        // raw" belong with the -n invocation; exiftool accepts the canonical
        // `YYYY:MM:DD HH:MM:SS±ZZ:ZZ` literal under -n without trying to
        // PrintConv-parse a localised string back into the field.  This
        // matches the worked example in design §5 and avoids surprises when
        // the system locale would otherwise reformat the string.
        (Some(TagKind::DateTime), Some(v)) => BuiltArgs {
            numeric: vec![format!("-{}={}", tag, render_scalar_text(v))],
            text: vec![],
        },
        // Struct: emit using exiftool's -struct serialization, NOT JSON.
        // exiftool parses struct values as `{field=value,nested={k=v},
        // list=[a,b]}` with `\` as the escape char for the metacharacters
        // `,{}[]=\`.  JSON would be silently mis-parsed (every quote
        // becomes part of the field name) and verification would always
        // mismatch — see METADATA_FORMATS_DESIGN.md §5 worked example for
        // mwg-rs:Regions.
        (Some(TagKind::Struct(_)), Some(v)) => BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}={}", tag, render_struct_text(v))],
        },
        // Binary: not writable in this app.  Caller should have rejected.
        (Some(TagKind::Binary), _) => BuiltArgs::default(),
        // Unknown / Text / Alt / fallback (no schema): text group.
        (_, Some(v)) => BuiltArgs {
            numeric: vec![],
            text: vec![format!("-{}={}", tag, render_scalar_text(v))],
        },
    }
}

fn build_list_op(tag: &str, info: Option<&TagInfo>, value: Option<&Variant>, op: &str) -> BuiltArgs {
    // For non-list tags, ListAdd/ListRemove devolve to Set/Delete to avoid
    // weird argv that exiftool would silently mis-execute.
    let is_list_kind = matches!(
        info.map(|i| &i.kind),
        Some(TagKind::Bag(_)) | Some(TagKind::Seq(_)) | Some(TagKind::Alt(_))
    );
    if !is_list_kind {
        log::warn!("[write_args] List op {} on non-list tag {} — treating as Set/Delete", op, tag);
        return match op {
            "-=" => BuiltArgs { numeric: vec![], text: vec![format!("-{}=", tag)] },
            _ => build_set(tag, info, value),
        };
    }

    let items: Vec<&Variant> = match value {
        Some(Variant::List(xs)) => xs.iter().collect(),
        Some(v) => vec![v],
        None => vec![],
    };

    let mut text = Vec::with_capacity(items.len());
    for item in items {
        text.push(format!("-{}{}{}", tag, op, render_scalar_text(item)));
    }
    BuiltArgs { numeric: vec![], text }
}

/// Render a `Variant` as a string suitable for a `-TAG=value` argv element,
/// using the text-pass (no `-n`) convention.
fn render_scalar_text(v: &Variant) -> String {
    match v {
        Variant::Null => String::new(),
        Variant::Bool(b) => if *b { "True".to_string() } else { "False".to_string() },
        Variant::Integer(n) => n.to_string(),
        Variant::Float(f) => f.to_string(),
        Variant::String(s) => s.clone(),
        // Lists at the leaf of a non-list tag are flattened to a
        // comma-joined string.  Should never happen for properly typed
        // edits but be defensive.
        Variant::List(items) => items
            .iter()
            .map(render_scalar_text)
            .collect::<Vec<_>>()
            .join(", "),
        Variant::Object(_) => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// Render a `Variant` using exiftool's `-struct` serialization syntax.
///
/// Exiftool's struct format (see Image::ExifTool docs, "Structured
/// Information"):
///
///     {field1=value1,field2={nested=val},listfield=[a,b,c]}
///
/// The metacharacters `, { } [ ] = \` are escaped with a leading backslash
/// inside scalar leaves.  Empty objects become `{}`; empty lists `[]`.
///
/// We intentionally do NOT JSON-encode here.  exiftool does not understand
/// JSON in struct positions, and the round-trip via `-struct` reads is the
/// authoritative shape.
fn render_struct_text(v: &Variant) -> String {
    fn escape_scalar(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            if matches!(c, ',' | '{' | '}' | '[' | ']' | '=' | '\\') {
                out.push('\\');
            }
            out.push(c);
        }
        out
    }
    fn render(v: &Variant) -> String {
        match v {
            Variant::Null => String::new(),
            Variant::Bool(b) => if *b { "True".to_string() } else { "False".to_string() },
            Variant::Integer(n) => n.to_string(),
            Variant::Float(f) => f.to_string(),
            Variant::String(s) => escape_scalar(s),
            Variant::List(items) => {
                let inner: Vec<String> = items.iter().map(render).collect();
                format!("[{}]", inner.join(","))
            }
            Variant::Object(map) => {
                let inner: Vec<String> = map
                    .iter()
                    .map(|(k, val)| format!("{}={}", escape_scalar(k), render(val)))
                    .collect();
                format!("{{{}}}", inner.join(","))
            }
        }
    }
    render(v)
}

/// Render a `Variant` for the numeric (`-n`) pass.  Bool becomes `1`/`0` so
/// exiftool doesn't have to PrintConv-parse "True"/"False" back; integers
/// and floats stay as their natural decimal representation.
fn render_scalar_numeric(v: &Variant) -> String {
    match v {
        Variant::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        Variant::Integer(n) => n.to_string(),
        Variant::Float(f) => f.to_string(),
        Variant::String(s) => s.clone(),
        other => render_scalar_text(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tag_schema::{EnumOption, EnumRepr};
    use std::collections::BTreeMap;

    fn info(kind: TagKind) -> TagInfo {
        TagInfo {
            group: "X".to_string(),
            name: "Y".to_string(),
            writable: true,
            kind,
            description: None,
        }
    }

    fn set(v: Variant) -> DraftEdit {
        DraftEdit { value: Some(v), intent: EditIntent::Set, display: None }
    }
    fn delete() -> DraftEdit {
        DraftEdit { value: None, intent: EditIntent::Delete, display: None }
    }
    fn list_add(v: Variant) -> DraftEdit {
        DraftEdit { value: Some(v), intent: EditIntent::ListAdd, display: None }
    }
    fn list_remove(v: Variant) -> DraftEdit {
        DraftEdit { value: Some(v), intent: EditIntent::ListRemove, display: None }
    }

    #[test]
    fn set_text_yields_single_text_arg() {
        let i = info(TagKind::Text);
        let args = build_args("XMP-dc:Title", Some(&i), &set(Variant::String("hi".into())));
        assert!(args.numeric.is_empty());
        assert_eq!(args.text, vec!["-XMP-dc:Title=hi"]);
    }

    #[test]
    fn set_integer_yields_numeric_arg() {
        let i = info(TagKind::Integer { min: None, max: None });
        let args = build_args("XMP-xmp:Rating", Some(&i), &set(Variant::Integer(5)));
        assert!(args.text.is_empty());
        assert_eq!(args.numeric, vec!["-XMP-xmp:Rating=5"]);
    }

    #[test]
    fn set_boolean_uses_1_0_in_numeric_group() {
        let i = info(TagKind::Boolean);
        let args = build_args("XMP-xmpRights:Marked", Some(&i), &set(Variant::Bool(true)));
        assert_eq!(args.numeric, vec!["-XMP-xmpRights:Marked=1"]);
        assert!(args.text.is_empty());
    }

    #[test]
    fn set_enum_integer_uses_numeric_group() {
        let i = info(TagKind::Enum {
            repr: EnumRepr::Integer,
            options: vec![
                EnumOption { code: "1".into(), label: "Horizontal".into() },
                EnumOption { code: "6".into(), label: "Rotate 90 CW".into() },
            ],
        });
        let args = build_args("IFD0:Orientation", Some(&i), &set(Variant::Integer(6)));
        assert_eq!(args.numeric, vec!["-IFD0:Orientation=6"]);
    }

    #[test]
    fn set_bag_emits_clear_then_repeated_args() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_args(
            "XMP-dc:Subject",
            Some(&i),
            &set(Variant::List(vec![
                Variant::String("beach".into()),
                Variant::String("sunset".into()),
            ])),
        );
        assert_eq!(
            args.text,
            vec![
                "-XMP-dc:Subject=",
                "-XMP-dc:Subject=beach",
                "-XMP-dc:Subject=sunset"
            ]
        );
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn set_seq_emits_clear_then_ordered_args() {
        let i = info(TagKind::Seq(Box::new(TagKind::Text)));
        let args = build_args(
            "XMP-dc:Creator",
            Some(&i),
            &set(Variant::List(vec![
                Variant::String("Ada".into()),
                Variant::String("Bea".into()),
            ])),
        );
        assert_eq!(
            args.text,
            vec!["-XMP-dc:Creator=", "-XMP-dc:Creator=Ada", "-XMP-dc:Creator=Bea"]
        );
    }

    #[test]
    fn set_bag_with_scalar_treats_as_single_element() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_args("XMP-dc:Subject", Some(&i), &set(Variant::String("only".into())));
        assert_eq!(
            args.text,
            vec!["-XMP-dc:Subject=", "-XMP-dc:Subject=only"]
        );
    }

    #[test]
    fn set_langalt_with_object_emits_per_lang_args() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("x-default".to_string(), Variant::String("Hi".into()));
        langs.insert("en".to_string(), Variant::String("Hi".into()));
        langs.insert("fr".to_string(), Variant::String("Salut".into()));
        let args = build_args("XMP-dc:Description", Some(&i), &set(Variant::Object(langs)));
        // BTreeMap iteration order is alphabetic; assert presence not order.
        assert!(args.text.iter().any(|a| a == "-XMP-dc:Description-x-default=Hi"));
        assert!(args.text.iter().any(|a| a == "-XMP-dc:Description-en=Hi"));
        assert!(args.text.iter().any(|a| a == "-XMP-dc:Description-fr=Salut"));
        assert_eq!(args.text.len(), 3);
    }

    #[test]
    fn set_langalt_without_xdefault_synthesises_one() {
        let i = info(TagKind::LangAlt);
        let mut langs = BTreeMap::new();
        langs.insert("en".to_string(), Variant::String("Hello".into()));
        let args = build_args("XMP-dc:Description", Some(&i), &set(Variant::Object(langs)));
        assert!(args.text.iter().any(|a| a == "-XMP-dc:Description-en=Hello"));
        assert!(args.text.iter().any(|a| a == "-XMP-dc:Description-x-default=Hello"));
    }

    #[test]
    fn delete_emits_empty_assignment() {
        let i = info(TagKind::Text);
        let args = build_args("XMP-dc:Title", Some(&i), &delete());
        assert_eq!(args.text, vec!["-XMP-dc:Title="]);
        assert!(args.numeric.is_empty());
    }

    #[test]
    fn listadd_on_bag_emits_plus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_args(
            "XMP-dc:Subject",
            Some(&i),
            &list_add(Variant::List(vec![
                Variant::String("a".into()),
                Variant::String("b".into()),
            ])),
        );
        assert_eq!(
            args.text,
            vec!["-XMP-dc:Subject+=a", "-XMP-dc:Subject+=b"]
        );
    }

    #[test]
    fn listremove_on_bag_emits_minus_equal_per_item() {
        let i = info(TagKind::Bag(Box::new(TagKind::Text)));
        let args = build_args(
            "XMP-dc:Subject",
            Some(&i),
            &list_remove(Variant::String("old".into())),
        );
        assert_eq!(args.text, vec!["-XMP-dc:Subject-=old"]);
    }

    #[test]
    fn list_op_on_non_list_tag_degrades_safely() {
        let i = info(TagKind::Text);
        // ListAdd on a Text tag becomes a Set.
        let args = build_args("XMP-dc:Title", Some(&i), &list_add(Variant::String("hi".into())));
        assert_eq!(args.text, vec!["-XMP-dc:Title=hi"]);
        // ListRemove on a Text tag becomes a Delete.
        let args = build_args("XMP-dc:Title", Some(&i), &list_remove(Variant::String("hi".into())));
        assert_eq!(args.text, vec!["-XMP-dc:Title="]);
    }

    #[test]
    fn unknown_tag_falls_back_to_text() {
        let args = build_args(
            "MakerNotes:CustomCameraField",
            None,
            &set(Variant::String("abc".into())),
        );
        assert_eq!(args.text, vec!["-MakerNotes:CustomCameraField=abc"]);
    }

    #[test]
    fn binary_tag_yields_no_args() {
        let i = info(TagKind::Binary);
        let args = build_args("Thumbnail:Bin", Some(&i), &set(Variant::String("x".into())));
        assert!(args.is_empty());
    }

    #[test]
    fn invalid_tag_name_yields_no_args() {
        let i = info(TagKind::Text);
        let args = build_args("bad\nname", Some(&i), &set(Variant::String("x".into())));
        assert!(args.is_empty());
        let args = build_args("", Some(&i), &set(Variant::String("x".into())));
        assert!(args.is_empty());
    }

    #[test]
    fn float_renders_decimal_in_numeric_group() {
        let i = info(TagKind::Real);
        let args = build_args("Composite:GPSAltitude", Some(&i), &set(Variant::Float(123.45)));
        assert_eq!(args.numeric, vec!["-Composite:GPSAltitude=123.45"]);
    }

    #[test]
    fn datetime_uses_numeric_group() {
        // Phase 8.7: design §6 puts DateTime in the -n group so the literal
        // YYYY:MM:DD HH:MM:SS±ZZ:ZZ form bypasses PrintConv re-parsing.
        let i = info(TagKind::DateTime);
        let args = build_args(
            "EXIF:DateTimeOriginal",
            Some(&i),
            &set(Variant::String("2026:05:15 10:30:00".into())),
        );
        assert_eq!(args.numeric, vec!["-EXIF:DateTimeOriginal=2026:05:15 10:30:00"]);
        assert!(args.text.is_empty());
    }

    #[test]
    fn rational_uses_numeric_group() {
        let i = info(TagKind::Rational);
        let args = build_args("EXIF:ExposureTime", Some(&i), &set(Variant::Float(0.004)));
        assert_eq!(args.numeric, vec!["-EXIF:ExposureTime=0.004"]);
    }

    // ── Phase 8 fix: struct argv uses exiftool -struct syntax, not JSON ──

    #[test]
    fn struct_render_uses_brace_syntax_not_json() {
        let mut inner = BTreeMap::new();
        inner.insert("Name".to_string(), Variant::String("John".into()));
        inner.insert("Type".to_string(), Variant::String("Face".into()));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_args("XMP-mwg-rs:Region", Some(&i), &set(Variant::Object(inner)));
        // Brace form, not JSON.  Field ordering is alphabetic via BTreeMap.
        assert_eq!(args.text, vec!["-XMP-mwg-rs:Region={Name=John,Type=Face}"]);
        // Critically: should NOT contain JSON quotes.
        assert!(!args.text[0].contains("\""), "argv must not be JSON: {:?}", args.text);
    }

    #[test]
    fn struct_render_handles_nested_object_and_list() {
        let mut area = BTreeMap::new();
        area.insert("X".to_string(), Variant::Float(0.5));
        area.insert("Y".to_string(), Variant::Float(0.5));
        let mut region = BTreeMap::new();
        region.insert("Area".to_string(), Variant::Object(area));
        region.insert("Names".to_string(), Variant::List(vec![
            Variant::String("a".into()),
            Variant::String("b".into()),
        ]));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_args("X:R", Some(&i), &set(Variant::Object(region)));
        assert_eq!(args.text, vec!["-X:R={Area={X=0.5,Y=0.5},Names=[a,b]}"]);
    }

    #[test]
    fn struct_render_escapes_metacharacters_in_scalars() {
        let mut o = BTreeMap::new();
        // Value containing every metachar exiftool struct parser cares about.
        o.insert("k".to_string(), Variant::String("a,b{c}d[e]f=g\\h".into()));
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_args("X:S", Some(&i), &set(Variant::Object(o)));
        assert_eq!(args.text, vec![r"-X:S={k=a\,b\{c\}d\[e\]f\=g\\h}"]);
    }

    #[test]
    fn struct_render_empty_object_and_list() {
        let i = info(TagKind::Struct(BTreeMap::new()));
        let args = build_args("X:S", Some(&i), &set(Variant::Object(BTreeMap::new())));
        assert_eq!(args.text, vec!["-X:S={}"]);
    }

    #[test]
    fn builtargs_extend_concatenates_groups() {
        let mut a = BuiltArgs {
            numeric: vec!["-A=1".into()],
            text: vec!["-B=x".into()],
        };
        let b = BuiltArgs {
            numeric: vec!["-C=2".into()],
            text: vec!["-D=y".into()],
        };
        a.extend(b);
        assert_eq!(a.numeric, vec!["-A=1", "-C=2"]);
        assert_eq!(a.text, vec!["-B=x", "-D=y"]);
    }
}
