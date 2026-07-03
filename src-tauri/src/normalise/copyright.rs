//! Group F — Copyright.
//!
//! Plan §1 Group F. Canonical = single-line string, leading/trailing
//! whitespace trimmed. No tone/tense normalisation. No AI.
//!
//! Conflict policy: pick a canonical, then project.
//!   1. Primary non-empty → canonical = normalise(primary).
//!   2. Primary empty, ≥1 derivative non-empty → canonical =
//!      normalise(longest non-empty derivative). The only group where
//!      length-based pick is used; copyright notices are typically
//!      appended to, so the longest is usually the most complete.
//!   3. All target empty → no drafts.

use super::{collapse_whitespace_single_line, CopyrightInput, GroupOutput};
use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use std::collections::HashMap;

pub const COPYRIGHT_TARGET_TAGS: &[&str] =
    &["XMP-dc:Rights", "EXIF:Copyright", "IPTC:CopyrightNotice"];

fn derive_copyright_canonical(input: &CopyrightInput) -> Option<String> {
    if let Some(primary) = input.rights.as_deref() {
        let n = collapse_whitespace_single_line(primary);
        if !n.is_empty() {
            return Some(n);
        }
    }
    let derivatives: [&Option<String>; 2] = [&input.exif_copyright, &input.iptc_copyright];
    let mut best: Option<String> = None;
    for d in derivatives.iter() {
        if let Some(v) = d.as_deref() {
            let n = collapse_whitespace_single_line(v);
            if n.is_empty() {
                continue;
            }
            if best.as_deref().map(|b| b.len() < n.len()).unwrap_or(true) {
                best = Some(n);
            }
        }
    }
    best
}

fn copyright_is_normalised(input: &CopyrightInput, canonical: &str) -> bool {
    input.rights.as_deref() == Some(canonical)
        && input.exif_copyright.as_deref() == Some(canonical)
        && input.iptc_copyright.as_deref() == Some(canonical)
}

/// Run Group F (Copyright) normalisation for one image.
pub fn normalise_copyright(input: &CopyrightInput) -> Option<GroupOutput> {
    let canonical = derive_copyright_canonical(input)?;
    if copyright_is_normalised(input, &canonical) {
        return None;
    }
    let edit = DraftEdit {
        value: Some(Variant::String(canonical.clone())),
        intent: EditIntent::Set,
        display: None,
    };
    let mut edits = HashMap::new();
    for tag in COPYRIGHT_TARGET_TAGS {
        edits.insert((*tag).to_string(), edit.clone());
    }
    Some(GroupOutput { edits })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(k).unwrap().value {
            Some(Variant::String(v)) => v.clone(),
            other => panic!("expected String, got {:?}", other),
        }
    }

    #[test]
    fn primary_wins_when_non_empty() {
        let input = CopyrightInput {
            rights: Some("© 2025 Acme".into()),
            exif_copyright: Some("Old EXIF copyright".into()),
            iptc_copyright: None,
        };
        let out = normalise_copyright(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025 Acme");
        assert_eq!(s(&out, "EXIF:Copyright"), "© 2025 Acme");
        assert_eq!(s(&out, "IPTC:CopyrightNotice"), "© 2025 Acme");
    }

    #[test]
    fn longest_derivative_wins_when_primary_empty() {
        let input = CopyrightInput {
            rights: None,
            exif_copyright: Some("© Acme".into()),
            iptc_copyright: Some("© 2025 Acme. All rights reserved.".into()),
        };
        let out = normalise_copyright(&input).unwrap();
        let want = "© 2025 Acme. All rights reserved.";
        assert_eq!(s(&out, "XMP-dc:Rights"), want);
        assert_eq!(s(&out, "EXIF:Copyright"), want);
        assert_eq!(s(&out, "IPTC:CopyrightNotice"), want);
    }

    #[test]
    fn whitespace_normalised_in_canonical() {
        let input = CopyrightInput {
            rights: Some("  ©   2025   Acme \t Corp  ".into()),
            ..Default::default()
        };
        let out = normalise_copyright(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025 Acme Corp");
    }

    #[test]
    fn empty_primary_falls_through_to_derivatives() {
        let input = CopyrightInput {
            rights: Some("   ".into()),
            exif_copyright: Some("© 2025".into()),
            iptc_copyright: None,
        };
        let out = normalise_copyright(&input).unwrap();
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025");
    }

    #[test]
    fn all_empty_returns_no_drafts() {
        assert!(normalise_copyright(&CopyrightInput::default()).is_none());
    }

    #[test]
    fn idempotent_after_one_pass() {
        let initial = CopyrightInput {
            rights: Some("© 2025 Acme".into()),
            ..Default::default()
        };
        let first = normalise_copyright(&initial).unwrap();
        let c = s(&first, "XMP-dc:Rights");
        let post = CopyrightInput {
            rights: Some(c.clone()),
            exif_copyright: Some(c.clone()),
            iptc_copyright: Some(c),
        };
        assert!(normalise_copyright(&post).is_none());
    }

    #[test]
    fn equal_but_unnormalised_triggers_normalisation() {
        let input = CopyrightInput {
            rights: Some("  © 2025 Acme  ".into()),
            exif_copyright: Some("© 2025 Acme".into()),
            iptc_copyright: Some("© 2025 Acme".into()),
        };
        let out = normalise_copyright(&input).expect("trims primary even when derivatives match");
        assert_eq!(s(&out, "XMP-dc:Rights"), "© 2025 Acme");
    }
}
