//! Shared OpenAI Responses API request-parameter compatibility.
//!
//! Request builders still own their prompts, inputs, schemas, and token
//! budgets. This module owns the small model-family policy that must remain
//! consistent across those builders.

pub(crate) const LOW_REASONING_EFFORT: &str = "low";

/// Walk `output[*].content[*]` for the first `output_text` part.
///
/// Reasoning models can emit a separate reasoning item before the assistant
/// message, so callers must not assume the text is in `output[0]`.
pub(crate) fn find_output_text(response: &serde_json::Value) -> Option<String> {
    let output = response.get("output")?.as_array()?;
    for item in output {
        let content = match item.get("content").and_then(|value| value.as_array()) {
            Some(content) => content,
            None => continue,
        };
        for part in content {
            if part.get("type").and_then(|value| value.as_str()) == Some("output_text") {
                if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                    return Some(text.to_string());
                }
            }
        }
    }

    // Keep compatibility with older response fixtures that omit the content
    // part's `type` field.
    response["output"][0]["content"][0]["text"]
        .as_str()
        .map(str::to_string)
}

/// GPT-5.6 and later use the modern prompt-cache controls. This is also a
/// useful compatibility boundary for Responses API request parameters: these
/// models are reasoning-first and should not receive legacy sampling knobs.
pub(crate) fn uses_modern_prompt_cache(model: &str) -> bool {
    model.starts_with("gpt-5.6") || model.starts_with("gpt-6")
}

pub(crate) fn supports_reasoning_controls(model: &str) -> bool {
    model.starts_with("gpt-5") || model.starts_with("gpt-6")
}

/// Reasoning effort used for short metadata-normalisation responses. Prefer
/// `none` when the model supports it so hidden reasoning cannot consume the
/// tight structured-output budget. GPT-6.1 Sol and GPT-6 Astra start at `low`.
pub(crate) fn short_response_reasoning_effort(model: &str) -> Option<&'static str> {
    if model.starts_with("gpt-5.6") || model == "gpt-6-luna" || model == "gpt-6-sol" {
        Some("none")
    } else if model == "gpt-6.1-sol" || model == "gpt-6-astra" {
        Some(LOW_REASONING_EFFORT)
    } else {
        None
    }
}

/// Add sampling and reasoning parameters supported by `model`.
///
/// GPT-5.6 and GPT-6-family models use reasoning controls and omit legacy
/// `temperature` / `top_p` settings. Earlier models keep deterministic
/// sampling for backwards-compatible output.
pub(crate) fn apply_responses_model_parameters(
    request: &mut serde_json::Value,
    model: &str,
    reasoning_effort: Option<&str>,
) {
    if !uses_modern_prompt_cache(model) {
        if let Some(object) = request.as_object_mut() {
            object.insert("temperature".into(), serde_json::json!(0));
            object.insert("top_p".into(), serde_json::json!(1));
        }
    }

    if supports_reasoning_controls(model) {
        if let Some(effort) = reasoning_effort {
            request["reasoning"] = serde_json::json!({ "effort": effort });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpt_5_6_uses_reasoning_without_sampling_parameters() {
        let mut request = serde_json::json!({});
        apply_responses_model_parameters(&mut request, "gpt-5.6-luna", Some(LOW_REASONING_EFFORT));
        assert!(request.get("temperature").is_none());
        assert!(request.get("top_p").is_none());
        assert_eq!(request["reasoning"]["effort"], "low");
    }

    #[test]
    fn gpt_6_uses_reasoning_without_sampling_parameters() {
        let mut request = serde_json::json!({});
        apply_responses_model_parameters(&mut request, "gpt-6-luna", Some(LOW_REASONING_EFFORT));
        assert!(request.get("temperature").is_none());
        assert!(request.get("top_p").is_none());
        assert_eq!(request["reasoning"]["effort"], "low");
    }

    #[test]
    fn gpt_6_1_sol_uses_low_for_short_responses() {
        assert_eq!(short_response_reasoning_effort("gpt-6.1-sol"), Some("low"));
        assert_eq!(short_response_reasoning_effort("gpt-6-astra"), Some("low"));
        assert_eq!(short_response_reasoning_effort("gpt-6-luna"), Some("none"));
    }

    #[test]
    fn legacy_model_uses_deterministic_sampling_without_reasoning() {
        let mut request = serde_json::json!({});
        apply_responses_model_parameters(&mut request, "gpt-4o", Some(LOW_REASONING_EFFORT));
        assert_eq!(request["temperature"], 0);
        assert_eq!(request["top_p"], 1);
        assert!(request.get("reasoning").is_none());
    }

    #[test]
    fn output_text_search_skips_a_reasoning_item() {
        let response = serde_json::json!({
            "output": [
                {
                    "type": "reasoning",
                    "content": []
                },
                {
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": "{\"city\":\"York\"}"
                    }]
                }
            ]
        });

        assert_eq!(
            find_output_text(&response).as_deref(),
            Some("{\"city\":\"York\"}")
        );
    }

    #[test]
    fn output_text_search_supports_legacy_untyped_content() {
        let response = serde_json::json!({
            "output": [{
                "content": [{
                    "text": "{\"description\":\"merged\"}"
                }]
            }]
        });

        assert_eq!(
            find_output_text(&response).as_deref(),
            Some("{\"description\":\"merged\"}")
        );
    }
}
