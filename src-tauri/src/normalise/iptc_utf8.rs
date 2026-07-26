//! IPTC UTF-8 conversion group.
//!
//! This group deliberately emits only a normal `CodedCharacterSet=UTF8`
//! draft. When the user applies that draft, the metadata write planner
//! derives same-value rewrites for existing non-ASCII IPTC text. Rewriting is
//! necessary because changing the marker alone changes interpretation of the
//! existing bytes; it does not transcode them.

use crate::draft_edits::SchemaMetadataEditMap;
use crate::normalise::{text_edit, GroupOutput, IptcUtf8Input};

fn is_utf8_marker(value: Option<&str>) -> bool {
    matches!(value, Some("UTF8" | "\u{1b}%G"))
}

pub fn normalise_iptc_utf8(input: &IptcUtf8Input) -> Option<GroupOutput> {
    if !input.has_iptc || is_utf8_marker(input.coded_character_set.as_deref()) {
        return None;
    }
    let mut edits = SchemaMetadataEditMap::new();
    edits.insert(
        crate::known_ids::iptc_coded_character_set(),
        text_edit("UTF8".to_string()),
    );
    Some(GroupOutput { edits })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_legacy_marker_creates_utf8_draft_for_iptc_files() {
        for marker in [None, Some("Latin")] {
            let output = normalise_iptc_utf8(&IptcUtf8Input {
                has_iptc: true,
                coded_character_set: marker.map(str::to_string),
            })
            .expect("conversion draft");
            let edit = output
                .edits
                .get(&crate::known_ids::iptc_coded_character_set())
                .expect("charset edit");
            assert_eq!(
                edit.value,
                Some(crate::metadata_value::MetadataValue::Text("UTF8".into()))
            );
        }
    }

    #[test]
    fn utf8_or_no_iptc_is_a_noop() {
        for marker in ["UTF8", "\u{1b}%G"] {
            assert!(normalise_iptc_utf8(&IptcUtf8Input {
                has_iptc: true,
                coded_character_set: Some(marker.to_string()),
            })
            .is_none());
        }
        assert!(normalise_iptc_utf8(&IptcUtf8Input::default()).is_none());
    }
}
