//! Group B — Description.
//!
//! Plan §1 Group B. Canonical = single paragraph, sentence-cased,
//! factual tone, UTF-8 in the LangAlt primary. Derivatives adapt:
//!   * `IFD0:ImageDescription` is ASCII-folded.
//!   * `IPTC:Caption-Abstract` is truncated at 2000 bytes at a word
//!     boundary; encoding depends on whether the file declares UTF-8
//!     via `IPTC:CodedCharacterSet`.
//!
//! Conflict policy:
//!   1. All target sources empty and no AI context → no drafts.
//!   2. All target sources empty and AI-derived context exists → **AI description generation**.
//!   3. Exactly one target source non-empty → normalise + project.
//!   4. Multiple target sources non-empty AND equal after normalise →
//!      write the normalised form.
//!   5. Multiple target sources non-empty AND distinct → **AI merge**.
//!      No deterministic fallback — surfaces as a typed AI failure if
//!      the AI client is absent or the call errors.

use super::{
    collapse_whitespace_single_line, lang_alt_edit, text_edit, truncate_at_word, AiCallUsage,
    DescriptionInput, DescriptionMergePrompt, GroupOutput, NormaliseAiClient, NormaliseAiError,
};
use crate::draft_edits::SchemaMetadataEditMap;
use crate::known_ids;

const IPTC_CAPTION_ABSTRACT_LIMIT: usize = 2000;

fn normalise_description_text(s: &str) -> String {
    collapse_whitespace_single_line(s)
}

/// ASCII-fold for `IFD0:ImageDescription`. Strip diacritics, replace
/// common smart-quotes / dashes with ASCII equivalents, drop
/// anything outside the printable ASCII range.
fn ascii_fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let replacement: &str = match c {
            '“' | '”' | '„' | '‟' => "\"",
            '‘' | '’' | '‚' | '‛' => "'",
            '–' | '—' => "--",
            '…' => "...",
            '«' | '»' => "\"",
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => "a",
            'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => "A",
            'é' | 'è' | 'ê' | 'ë' => "e",
            'É' | 'È' | 'Ê' | 'Ë' => "E",
            'í' | 'ì' | 'î' | 'ï' => "i",
            'Í' | 'Ì' | 'Î' | 'Ï' => "I",
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' => "o",
            'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' => "O",
            'ú' | 'ù' | 'û' | 'ü' => "u",
            'Ú' | 'Ù' | 'Û' | 'Ü' => "U",
            'ñ' => "n",
            'Ñ' => "N",
            'ç' => "c",
            'Ç' => "C",
            'ß' => "ss",
            _ if c.is_ascii() => {
                out.push(c);
                continue;
            }
            _ => "",
        };
        out.push_str(replacement);
    }
    out
}

fn project_caption_abstract(canonical: &str, charset_is_utf8: bool) -> String {
    let body = if charset_is_utf8 {
        canonical.to_string()
    } else {
        ascii_fold(canonical)
    };
    truncate_at_word(&body, IPTC_CAPTION_ABSTRACT_LIMIT)
}

/// Build the prompt body sent to the AI merge call. Pure function so
/// tests can pin the wire shape.
pub fn build_description_merge_prompt(input: &DescriptionInput) -> DescriptionMergePrompt {
    let mut description_sources = std::collections::BTreeMap::new();
    if let Some(s) = input
        .description
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        description_sources.insert("XMP-dc:Description".into(), s.trim().to_string());
    }
    if let Some(s) = input
        .image_description
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        description_sources.insert("IFD0:ImageDescription".into(), s.trim().to_string());
    }
    if let Some(s) = input
        .caption_abstract
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        description_sources.insert("IPTC:Caption-Abstract".into(), s.trim().to_string());
    }

    let mut ai_context = std::collections::BTreeMap::new();
    if let Some(s) = input
        .ai_description
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        ai_context.insert(
            "XMP-mlib:AIDescription".into(),
            serde_json::Value::String(s.trim().to_string()),
        );
    }
    if let Some(s) = input
        .ai_interpretation
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        ai_context.insert(
            "XMP-mlib:AIInterpretation".into(),
            serde_json::Value::String(s.trim().to_string()),
        );
    }
    if !input.ai_ocr_text.is_empty() {
        ai_context.insert(
            "XMP-mlib:AIOcrText".into(),
            serde_json::Value::Array(
                input
                    .ai_ocr_text
                    .iter()
                    .map(|s| serde_json::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    if !input.ai_objects.is_empty() {
        ai_context.insert(
            "XMP-mlib:AIObjects".into(),
            serde_json::Value::Array(
                input
                    .ai_objects
                    .iter()
                    .map(|s| serde_json::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }

    let location = match &input.location_context {
        Some(lc) => {
            let mut m = serde_json::Map::new();
            if let Some(s) = lc.location.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("location".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.city.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("city".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.state.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("state".into(), serde_json::Value::String(s.into()));
            }
            if let Some(s) = lc.country.as_deref().filter(|s| !s.trim().is_empty()) {
                m.insert("country".into(), serde_json::Value::String(s.into()));
            }
            serde_json::Value::Object(m)
        }
        None => serde_json::Value::Null,
    };

    DescriptionMergePrompt {
        description_sources,
        ai_context,
        location,
        keywords: input.keywords_context.clone(),
        date: input.date_context.clone(),
    }
}

/// Outcome of Group B normalisation. Tracks whether the AI fired so
/// stats / audit log can count.
#[derive(Debug, Clone, Default)]
pub struct DescriptionOutcome {
    pub output: Option<GroupOutput>,
    pub ai_fired: bool,
    pub ai_error: Option<NormaliseAiError>,
    pub ai_usage: Option<AiCallUsage>,
    /// The canonical description string the group resolved on, regardless
    /// of whether any drafts were emitted. Populated whenever Group B
    /// reaches a non-empty canonical (cases 2/3/4/5 success); `None` for
    /// all-empty case 1 and for AI failures.
    pub canonical: Option<String>,
}

fn has_ai_description_generation_context(input: &DescriptionInput) -> bool {
    input
        .ai_description
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
        || input
            .ai_interpretation
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
        || input.ai_ocr_text.iter().any(|s| !s.trim().is_empty())
        || input.ai_objects.iter().any(|s| !s.trim().is_empty())
}

/// Run Group B (Description) normalisation. Async because case-2 or case-5 may
/// call the injected AI client.
pub async fn normalise_description(
    input: &DescriptionInput,
    ai: Option<&dyn NormaliseAiClient>,
) -> DescriptionOutcome {
    let primary = normalise_description_text(input.description.as_deref().unwrap_or(""));
    let image_desc = normalise_description_text(input.image_description.as_deref().unwrap_or(""));
    let caption = normalise_description_text(input.caption_abstract.as_deref().unwrap_or(""));

    let target_sources: Vec<(&str, String)> = vec![
        ("XMP-dc:Description", primary),
        ("IFD0:ImageDescription", image_desc),
        ("IPTC:Caption-Abstract", caption),
    ];
    let non_empty: Vec<(&str, String)> = target_sources
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .cloned()
        .collect();

    let mut ai_usage: Option<AiCallUsage> = None;
    let (canonical, ai_fired) = if non_empty.is_empty() {
        if has_ai_description_generation_context(input) {
            let prompt = build_description_merge_prompt(input);
            match ai {
                Some(client) => match client.merge_description(prompt).await {
                    Ok((merged, usage)) => {
                        ai_usage = Some(usage);
                        (normalise_description_text(&merged), true)
                    }
                    Err(e) => {
                        return DescriptionOutcome {
                            ai_error: Some(NormaliseAiError::from_client_string(e)),
                            ..Default::default()
                        };
                    }
                },
                None => {
                    return DescriptionOutcome {
                        ai_error: Some(NormaliseAiError::key_missing()),
                        ..Default::default()
                    };
                }
            }
        } else {
            return DescriptionOutcome::default();
        }
    } else {
        let distinct: std::collections::BTreeSet<&str> =
            non_empty.iter().map(|(_, v)| v.as_str()).collect();
        if distinct.len() == 1 {
            (non_empty[0].1.clone(), false)
        } else {
            let prompt = build_description_merge_prompt(input);
            match ai {
                Some(client) => match client.merge_description(prompt).await {
                    Ok((merged, usage)) => {
                        ai_usage = Some(usage);
                        (normalise_description_text(&merged), true)
                    }
                    Err(e) => {
                        return DescriptionOutcome {
                            ai_error: Some(NormaliseAiError::from_client_string(e)),
                            ..Default::default()
                        };
                    }
                },
                None => {
                    return DescriptionOutcome {
                        ai_error: Some(NormaliseAiError::key_missing()),
                        ..Default::default()
                    };
                }
            }
        }
    };

    if canonical.is_empty() {
        return DescriptionOutcome {
            ai_fired,
            ai_usage,
            ..Default::default()
        };
    }

    let projection_image = ascii_fold(&canonical);
    let projection_caption = project_caption_abstract(&canonical, input.iptc_charset_is_utf8);

    let mut edits = SchemaMetadataEditMap::new();
    if input.description.as_deref() != Some(canonical.as_str()) {
        edits.insert(
            known_ids::xmp_description(),
            lang_alt_edit(canonical.clone()),
        );
    }
    if input.image_description.as_deref() != Some(projection_image.as_str()) {
        edits.insert(known_ids::image_description(), text_edit(projection_image));
    }
    if input.caption_abstract.as_deref() != Some(projection_caption.as_str()) {
        edits.insert(known_ids::iptc_caption(), text_edit(projection_caption));
    }

    DescriptionOutcome {
        output: if edits.is_empty() {
            None
        } else {
            Some(GroupOutput { edits })
        },
        ai_fired,
        ai_error: None,
        ai_usage,
        canonical: Some(canonical),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{LocationContext, TitleGenPrompt};
    use super::*;
    use crate::metadata_value::MetadataValue;

    fn text(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(&crate::known_ids::test_id(k)).unwrap().value {
            Some(MetadataValue::Text(v)) => v.clone(),
            other => panic!("expected text value for {}, got {:?}", k, other),
        }
    }

    fn lang_alt_x_default(g: &GroupOutput, k: &str) -> String {
        match &g.edits.get(&crate::known_ids::test_id(k)).unwrap().value {
            Some(MetadataValue::LangAlt(v)) => v.get("x-default").unwrap().clone(),
            other => panic!("expected lang-alt value for {}, got {:?}", k, other),
        }
    }

    #[tokio::test]
    async fn all_empty_returns_no_drafts() {
        let out = normalise_description(&DescriptionInput::default(), None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
    }

    #[tokio::test]
    async fn single_source_propagates_to_all_targets() {
        let input = DescriptionInput {
            description: Some("A sunset on the bay.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        assert_eq!(text(&g, "IFD0:ImageDescription"), "A sunset on the bay.");
        assert_eq!(text(&g, "IPTC:Caption-Abstract"), "A sunset on the bay.");
    }

    #[tokio::test]
    async fn whitespace_normalisation_triggers_drafts() {
        let input = DescriptionInput {
            description: Some("  A   sunset  ".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        assert_eq!(lang_alt_x_default(&g, "XMP-dc:Description"), "A sunset");
    }

    #[tokio::test]
    async fn equal_after_normalise_propagates() {
        let input = DescriptionInput {
            description: Some("A sunset.".into()),
            image_description: Some("A sunset.".into()),
            caption_abstract: Some("A sunset.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        assert_eq!(out.canonical.as_deref(), Some("A sunset."));
    }

    #[tokio::test]
    async fn canonical_none_when_all_sources_empty() {
        let out = normalise_description(&DescriptionInput::default(), None).await;
        assert!(out.canonical.is_none());
    }

    #[tokio::test]
    async fn canonical_populated_for_single_source() {
        let input = DescriptionInput {
            description: Some("A misty morning.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        assert_eq!(out.canonical.as_deref(), Some("A misty morning."));
    }

    #[tokio::test]
    async fn ascii_fold_for_image_description() {
        let input = DescriptionInput {
            description: Some("André Müller’s café".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        assert_eq!(text(&g, "IFD0:ImageDescription"), "Andre Muller's cafe");
        assert!(!g.edits.contains_key(&crate::known_ids::xmp_description()));
    }

    #[tokio::test]
    async fn caption_abstract_truncated_at_2000_bytes() {
        let long = "word ".repeat(500);
        let trimmed = long.trim_end().to_string();
        let input = DescriptionInput {
            description: Some(trimmed.clone()),
            iptc_charset_is_utf8: true,
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        let g = out.output.unwrap();
        let cap = text(&g, "IPTC:Caption-Abstract");
        assert!(cap.len() <= IPTC_CAPTION_ABSTRACT_LIMIT);
        assert!(!cap.ends_with(' '));
        assert!(cap.ends_with("word"));
    }

    #[tokio::test]
    async fn distinct_sources_with_no_ai_returns_key_missing_error() {
        let input = DescriptionInput {
            description: Some("Primary version.".into()),
            image_description: Some("Different version.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiKeyMissing);
    }

    #[tokio::test]
    async fn distinct_sources_with_ai_use_merged_canonical() {
        struct MockAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                Ok(("Merged factual description.".into(), AiCallUsage::default()))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
        }
        let input = DescriptionInput {
            description: Some("Primary.".into()),
            image_description: Some("Different.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, Some(&MockAi)).await;
        let g = out.output.unwrap();
        assert_eq!(
            lang_alt_x_default(&g, "XMP-dc:Description"),
            "Merged factual description."
        );
        assert!(out.ai_fired);
    }

    #[tokio::test]
    async fn ai_error_returns_no_drafts_and_records_typed_error() {
        struct FailingAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for FailingAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                Err("HTTP 429: too many requests".into())
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
        }
        let input = DescriptionInput {
            description: Some("Primary.".into()),
            image_description: Some("Different.".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, Some(&FailingAi)).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiRateLimited);
        assert!(err.detail.contains("HTTP 429"));
    }

    #[test]
    fn merge_prompt_strips_empty_sources_and_includes_ai_context() {
        let input = DescriptionInput {
            description: Some("Primary".into()),
            image_description: Some("".into()),
            ai_description: Some("AI-generated".into()),
            ai_ocr_text: vec!["signage".into()],
            ai_objects: vec!["statue".into()],
            keywords_context: vec!["statue".into(), "london".into()],
            date_context: Some("2024-08-12".into()),
            location_context: Some(LocationContext {
                city: Some("London".into()),
                country: Some("UK".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let prompt = build_description_merge_prompt(&input);
        assert!(prompt
            .description_sources
            .contains_key("XMP-dc:Description"));
        assert!(!prompt
            .description_sources
            .contains_key("IFD0:ImageDescription"));
        assert!(prompt.ai_context.contains_key("XMP-mlib:AIDescription"));
        assert!(prompt.ai_context.contains_key("XMP-mlib:AIOcrText"));
        assert!(prompt.ai_context.contains_key("XMP-mlib:AIObjects"));
        assert_eq!(
            prompt.keywords,
            vec!["statue".to_string(), "london".to_string()]
        );
        assert_eq!(prompt.date.as_deref(), Some("2024-08-12"));
        assert_eq!(prompt.location["city"], "London");
        assert_eq!(prompt.location["country"], "UK");
    }

    #[tokio::test]
    async fn idempotent_after_one_pass() {
        let input = DescriptionInput {
            description: Some("A sunset.".into()),
            ..Default::default()
        };
        let first = normalise_description(&input, None).await.output.unwrap();
        let post = DescriptionInput {
            description: Some("A sunset.".into()),
            image_description: Some(text(&first, "IFD0:ImageDescription")),
            caption_abstract: Some(text(&first, "IPTC:Caption-Abstract")),
            ..Default::default()
        };
        let second = normalise_description(&post, None).await;
        assert!(second.output.is_none());
    }

    #[tokio::test]
    async fn all_targets_empty_and_no_ai_context_returns_no_drafts() {
        let input = DescriptionInput::default();
        let out = normalise_description(&input, None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        assert!(out.ai_error.is_none());
        assert!(out.canonical.is_none());
    }

    #[tokio::test]
    async fn all_targets_empty_with_ai_description_generates_description() {
        struct MockAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                Ok((
                    "Generated factual description.".into(),
                    AiCallUsage::default(),
                ))
            }
            async fn generate_title(
                &self,
                _: TitleGenPrompt,
            ) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
        }
        let input = DescriptionInput {
            ai_description: Some("AI-derived metadata".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, Some(&MockAi)).await;
        assert!(out.ai_fired);
        assert!(out.ai_error.is_none());
        assert_eq!(
            out.canonical.as_deref(),
            Some("Generated factual description.")
        );
        let g = out.output.unwrap();
        assert_eq!(
            lang_alt_x_default(&g, "XMP-dc:Description"),
            "Generated factual description."
        );
        assert_eq!(
            text(&g, "IFD0:ImageDescription"),
            "Generated factual description."
        );
        assert_eq!(
            text(&g, "IPTC:Caption-Abstract"),
            "Generated factual description."
        );
    }

    #[tokio::test]
    async fn all_targets_empty_with_ai_context_but_no_client_returns_key_missing() {
        let input = DescriptionInput {
            ai_description: Some("AI-derived metadata".into()),
            ..Default::default()
        };
        let out = normalise_description(&input, None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiKeyMissing);
    }

    #[test]
    fn all_targets_empty_with_ai_objects_or_ocr_can_generate() {
        let input_ocr = DescriptionInput {
            ai_ocr_text: vec!["ocr text".into()],
            ..Default::default()
        };
        assert!(has_ai_description_generation_context(&input_ocr));

        let input_objects = DescriptionInput {
            ai_objects: vec!["objects".into()],
            ..Default::default()
        };
        assert!(has_ai_description_generation_context(&input_objects));

        let input_empty_lists = DescriptionInput {
            ai_ocr_text: vec![],
            ai_objects: vec![],
            ..Default::default()
        };
        assert!(!has_ai_description_generation_context(&input_empty_lists));
    }
}
