//! Shared OpenAI Responses API request-parameter compatibility.
//!
//! Request builders still own their prompts, inputs, schemas, and token
//! budgets. This module owns the small model-family policy that must remain
//! consistent across those builders.

pub(crate) const LOW_REASONING_EFFORT: &str = "low";

/// Add sampling and reasoning parameters supported by `model`.
///
/// GPT-5.6 reasoning models reject `temperature` and `top_p`; older models use
/// deterministic sampling. GPT-5 models accept an explicit reasoning effort.
pub(crate) fn apply_responses_model_parameters(
    request: &mut serde_json::Value,
    model: &str,
    reasoning_effort: Option<&str>,
) {
    if !model.starts_with("gpt-5.6") {
        if let Some(object) = request.as_object_mut() {
            object.insert("temperature".into(), serde_json::json!(0));
            object.insert("top_p".into(), serde_json::json!(1));
        }
    }

    if model.starts_with("gpt-5") {
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
    fn legacy_model_uses_deterministic_sampling_without_reasoning() {
        let mut request = serde_json::json!({});
        apply_responses_model_parameters(&mut request, "gpt-4o", Some(LOW_REASONING_EFFORT));
        assert_eq!(request["temperature"], 0);
        assert_eq!(request["top_p"], 1);
        assert!(request.get("reasoning").is_none());
    }
}
