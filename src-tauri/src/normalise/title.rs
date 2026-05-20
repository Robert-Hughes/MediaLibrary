//! Group C — Title.
//!
//! Plan §1 Group C. Canonical = short title-case phrase, ≤8 words, no
//! trailing punctuation.
//!
//! Cases 1, 2 are deterministic (primary or derivative wins).
//! Case 3 fires the AI title-generation path when all targets are
//! empty and `description_canonical` is non-empty AND an AI client is
//! supplied. Without an AI client this case surfaces a typed failure
//! rather than silently no-op'ing.
//!
//! Title-case enforcement is **not** applied here — risks mangling
//! proper nouns ("iPhone" → "IPhone") without a stopword list. The AI
//! prompt enforces title-case when the generation path fires.

use super::{
    collapse_whitespace_single_line, truncate_at_word, AiCallUsage, GroupOutput,
    NormaliseAiClient, NormaliseAiError, TitleGenPrompt, TitleInput,
};
use crate::draft_edits::{DraftEdit, EditIntent};
use crate::scanner::Variant;
use std::collections::HashMap;

pub const TITLE_TARGET_TAGS: &[&str] = &["XMP-dc:Title", "IPTC:ObjectName"];

const IPTC_OBJECT_NAME_LIMIT: usize = 64;

fn normalise_title_text(s: &str) -> String {
    let collapsed = collapse_whitespace_single_line(s);
    collapsed
        .trim_end_matches(|c: char| matches!(c, '.' | '!' | '?' | ',' | ':' | ';'))
        .trim_end()
        .to_string()
}

fn derive_title_canonical(input: &TitleInput) -> Option<String> {
    if let Some(p) = input.title.as_deref() {
        let n = normalise_title_text(p);
        if !n.is_empty() {
            return Some(n);
        }
    }
    if let Some(d) = input.object_name.as_deref() {
        let n = normalise_title_text(d);
        if !n.is_empty() {
            return Some(n);
        }
    }
    None
}

/// Build the Group C AI-title prompt body. Pure function so tests can
/// pin the wire shape.
pub fn build_title_gen_prompt(input: &TitleInput) -> Option<TitleGenPrompt> {
    let description = input
        .description_canonical
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
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
    Some(TitleGenPrompt {
        description,
        location,
        keywords: input.keywords_context.clone(),
    })
}

/// Outcome of Title normalisation. Mirrors `DescriptionOutcome` so the
/// dispatcher can record AI-fired stats and audit-log errors.
#[derive(Debug, Clone, Default)]
pub struct TitleOutcome {
    pub output: Option<GroupOutput>,
    pub ai_fired: bool,
    /// Populated when case-3 (AI title generation) was required but
    /// failed or the AI client was unavailable. Surfaced as a failure
    /// row by the dispatcher; never set for deterministic cases.
    pub ai_error: Option<NormaliseAiError>,
    pub ai_usage: Option<AiCallUsage>,
}

fn title_is_normalised(input: &TitleInput, canonical: &str) -> bool {
    let object_projection = truncate_at_word(canonical, IPTC_OBJECT_NAME_LIMIT);
    input.title.as_deref() == Some(canonical)
        && input.object_name.as_deref() == Some(object_projection.as_str())
}

/// Run Group C (Title) normalisation for one image.
pub async fn normalise_title(
    input: &TitleInput,
    ai: Option<&dyn NormaliseAiClient>,
) -> TitleOutcome {
    let mut ai_fired = false;
    let mut ai_usage: Option<AiCallUsage> = None;

    let canonical_opt = derive_title_canonical(input);
    let canonical = match canonical_opt {
        Some(c) => c,
        None => {
            // Case 3: AI title generation from description.
            match build_title_gen_prompt(input) {
                None => return TitleOutcome::default(),
                Some(prompt) => match ai {
                    None => {
                        return TitleOutcome {
                            ai_error: Some(NormaliseAiError::key_missing()),
                            ..Default::default()
                        };
                    }
                    Some(client) => match client.generate_title(prompt).await {
                        Ok((generated, usage)) => {
                            ai_fired = true;
                            ai_usage = Some(usage);
                            let n = normalise_title_text(&generated);
                            if n.is_empty() {
                                return TitleOutcome { ai_fired, ai_usage, ..Default::default() };
                            }
                            n
                        }
                        Err(e) => {
                            return TitleOutcome {
                                ai_error: Some(NormaliseAiError::from_client_string(e)),
                                ..Default::default()
                            };
                        }
                    },
                },
            }
        }
    };

    if title_is_normalised(input, &canonical) {
        return TitleOutcome { ai_fired, ai_usage, ..Default::default() };
    }
    let object = truncate_at_word(&canonical, IPTC_OBJECT_NAME_LIMIT);
    let mut edits = HashMap::new();
    if input.title.as_deref() != Some(canonical.as_str()) {
        edits.insert(
            "XMP-dc:Title".to_string(),
            DraftEdit {
                value: Some(Variant::String(canonical.clone())),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    if input.object_name.as_deref() != Some(object.as_str()) {
        edits.insert(
            "IPTC:ObjectName".to_string(),
            DraftEdit {
                value: Some(Variant::String(object)),
                intent: EditIntent::Set,
                display: None,
            },
        );
    }
    TitleOutcome {
        output: if edits.is_empty() { None } else { Some(GroupOutput { edits }) },
        ai_fired,
        ai_error: None,
        ai_usage,
    }
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

    #[tokio::test]
    async fn primary_wins() {
        let input = TitleInput {
            title: Some("Sunset Over Mont Blanc".into()),
            object_name: Some("Old ObjectName".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert!(!out.edits.contains_key("XMP-dc:Title"));
        assert_eq!(s(&out, "IPTC:ObjectName"), "Sunset Over Mont Blanc");
    }

    #[tokio::test]
    async fn primary_empty_uses_derivative() {
        let input = TitleInput {
            title: None,
            object_name: Some("From IPTC".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "From IPTC");
    }

    #[tokio::test]
    async fn trailing_punctuation_stripped() {
        let input = TitleInput {
            title: Some("Sunset Over Mont Blanc.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Sunset Over Mont Blanc");
    }

    #[tokio::test]
    async fn trailing_multiple_punctuation_stripped() {
        let input = TitleInput {
            title: Some("Wow!?".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Wow");
    }

    #[tokio::test]
    async fn whitespace_normalised() {
        let input = TitleInput {
            title: Some("  Lots   of   space  ".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "XMP-dc:Title"), "Lots of space");
    }

    #[tokio::test]
    async fn capitalisation_preserved() {
        let input = TitleInput {
            title: Some("iPhone in the Snow".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        assert_eq!(s(&out, "IPTC:ObjectName"), "iPhone in the Snow");
    }

    #[tokio::test]
    async fn empty_targets_no_ai_returns_key_missing_error() {
        let input = TitleInput {
            description_canonical: Some("A photo of a cat.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiKeyMissing);
    }

    #[tokio::test]
    async fn case_3_ai_generates_title_from_description() {
        struct MockAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for MockAi {
            async fn merge_description(
                &self,
                _: DescriptionMergePrompt,
            ) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, p: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                assert_eq!(p.description, "Climbers descending Mont Blanc at sunset.");
                assert_eq!(p.keywords, vec!["mountains".to_string()]);
                Ok(("Climbers At Sunset".into(), AiCallUsage::default()))
            }
        }
        let input = TitleInput {
            description_canonical: Some("Climbers descending Mont Blanc at sunset.".into()),
            keywords_context: vec!["mountains".into()],
            ..Default::default()
        };
        let out = normalise_title(&input, Some(&MockAi)).await;
        let g = out.output.unwrap();
        assert_eq!(s(&g, "XMP-dc:Title"), "Climbers At Sunset");
        assert!(out.ai_fired);
    }

    #[tokio::test]
    async fn case_3_ai_error_records_error_and_no_drafts() {
        struct FailingAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for FailingAi {
            async fn merge_description(&self, _: DescriptionMergePrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                Err("rate limited".into())
            }
        }
        let input = TitleInput {
            description_canonical: Some("A photo.".into()),
            ..Default::default()
        };
        let out = normalise_title(&input, Some(&FailingAi)).await;
        assert!(out.output.is_none());
        let err = out.ai_error.expect("ai_error must be populated");
        assert_eq!(err.kind, crate::batch_job::BatchFailureKind::AiCallFailed);
    }

    #[tokio::test]
    async fn case_3_no_description_no_ai_call() {
        struct ShouldNotFireAi;
        #[async_trait::async_trait]
        impl NormaliseAiClient for ShouldNotFireAi {
            async fn merge_description(&self, _: DescriptionMergePrompt) -> Result<(String, AiCallUsage), String> {
                unreachable!()
            }
            async fn generate_title(&self, _: TitleGenPrompt) -> Result<(String, AiCallUsage), String> {
                panic!("AI should not fire when description is empty")
            }
        }
        let input = TitleInput::default();
        let out = normalise_title(&input, Some(&ShouldNotFireAi)).await;
        assert!(out.output.is_none());
        assert!(!out.ai_fired);
    }

    #[tokio::test]
    async fn iptc_object_name_truncated_at_64_bytes() {
        let long = "word ".repeat(20);
        let trimmed = long.trim_end().to_string();
        let input = TitleInput {
            title: Some(trimmed.clone()),
            ..Default::default()
        };
        let out = normalise_title(&input, None).await.output.unwrap();
        let obj = s(&out, "IPTC:ObjectName");
        assert!(obj.len() <= IPTC_OBJECT_NAME_LIMIT);
        assert!(!obj.ends_with(' '));
        assert!(obj.ends_with("word"));
    }

    #[tokio::test]
    async fn idempotent_after_one_pass() {
        let initial = TitleInput {
            title: Some("My Title".into()),
            ..Default::default()
        };
        let first = normalise_title(&initial, None).await.output.unwrap();
        let post = TitleInput {
            title: Some("My Title".into()),
            object_name: Some(s(&first, "IPTC:ObjectName")),
            ..Default::default()
        };
        let second = normalise_title(&post, None).await;
        assert!(second.output.is_none());
    }
}
