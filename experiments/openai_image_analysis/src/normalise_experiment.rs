use clap::ValueEnum;
use medialibrary_tauri_lib::normalise::{
    build_description_merge_prompt, build_title_gen_prompt, DescriptionInput, LocationContext,
    TitleInput,
};
use medialibrary_tauri_lib::openai_http::OpenAiHttp;
use medialibrary_tauri_lib::openai_normalise::OpenAiNormaliseClient;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use super::{
    extract_response_text, get_model_pricing, image_content_item, post_response_body, Client,
    UsageStats, OPENAI_BASE_URL,
};

#[derive(Clone, Copy, Debug, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningSetting {
    /// Preserve production's current omission, which means GPT-5.6 defaults to medium.
    Omitted,
    None,
    Low,
}

impl ReasoningSetting {
    fn label(self) -> &'static str {
        match self {
            Self::Omitted => "omitted_default_medium",
            Self::None => "none",
            Self::Low => "low",
        }
    }

    fn apply(self, body: &mut Value) {
        match self {
            Self::Omitted => {
                body.as_object_mut().map(|object| object.remove("reasoning"));
            }
            Self::None => body["reasoning"] = serde_json::json!({ "effort": "none" }),
            Self::Low => body["reasoning"] = serde_json::json!({ "effort": "low" }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct NormaliseCase {
    path: PathBuf,
    current_description: String,
    current_title: String,
    ai_description: Option<String>,
    ai_interpretation: Option<String>,
    ai_ocr_text: Vec<String>,
    ai_objects: Vec<String>,
    location: Option<LocationContext>,
    keywords: Vec<String>,
    date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct GeneratedValue {
    value: Option<String>,
    usage: Option<UsageStats>,
    elapsed_ms: u128,
    status: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct JudgeResult {
    model: String,
    result: Option<Value>,
    usage: Option<UsageStats>,
    elapsed_ms: u128,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct NormaliseExperimentRecord {
    path: PathBuf,
    model: String,
    reasoning: String,
    current_description: String,
    generated_description: GeneratedValue,
    current_title: String,
    generated_title: GeneratedValue,
    prompt_context: NormaliseCase,
    judge: Option<JudgeResult>,
}

fn first_string(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        let text = text.trim();
        return (!text.is_empty()).then(|| text.to_owned());
    }
    if let Some(object) = value.as_object() {
        for key in ["x-default", "X-default", "default"] {
            if let Some(text) = object.get(key).and_then(Value::as_str) {
                let text = text.trim();
                if !text.is_empty() {
                    return Some(text.to_owned());
                }
            }
        }
        for child in object.values() {
            if let Some(text) = first_string(Some(child)) {
                return Some(text);
            }
        }
    }
    if let Some(array) = value.as_array() {
        for child in array {
            if let Some(text) = first_string(Some(child)) {
                return Some(text);
            }
        }
    }
    None
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else { return Vec::new() };
    let values = value.as_array().cloned().unwrap_or_else(|| vec![value.clone()]);
    values
        .iter()
        .filter_map(|item| first_string(Some(item)))
        .collect()
}

fn metadata_value<'a>(row: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| row.get(*name))
}

fn load_case(path: &Path) -> Result<NormaliseCase, Box<dyn std::error::Error>> {
    let args = [
        "-j",
        "-struct",
        "-G1",
        "-XMP-dc:Description",
        "-IFD0:ImageDescription",
        "-IPTC:Caption-Abstract",
        "-XMP-dc:Title",
        "-IPTC:ObjectName",
        "-XMP-mlib:AIDescription",
        "-XMP-mlib:AIInterpretation",
        "-XMP-mlib:AIOcrText",
        "-XMP-mlib:AIObjects",
        "-XMP-iptcCore:Location",
        "-XMP-photoshop:City",
        "-XMP-photoshop:State",
        "-XMP-photoshop:Country",
        "-XMP-dc:Subject",
        "-XMP-lr:HierarchicalSubject",
        "-ExifIFD:DateTimeOriginal",
    ];
    let output = Command::new("exiftool").args(args).arg(path).output()?;
    if !output.status.success() {
        return Err(format!(
            "exiftool failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let rows: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    let row = rows.first().ok_or("exiftool returned no JSON row")?;

    let current_description = first_string(metadata_value(
        row,
        &["XMP-dc:Description", "IFD0:ImageDescription", "IPTC:Caption-Abstract"],
    ))
    .ok_or_else(|| format!("{} has no existing normalized description", path.display()))?;
    let current_title = first_string(metadata_value(row, &["XMP-dc:Title", "IPTC:ObjectName"]))
        .ok_or_else(|| format!("{} has no existing normalized title", path.display()))?;

    let location = LocationContext {
        location: first_string(metadata_value(row, &["XMP-iptcCore:Location"])),
        city: first_string(metadata_value(row, &["XMP-photoshop:City"])),
        state: first_string(metadata_value(row, &["XMP-photoshop:State"])),
        country: first_string(metadata_value(row, &["XMP-photoshop:Country"])),
    };
    let location = (location.location.is_some()
        || location.city.is_some()
        || location.state.is_some()
        || location.country.is_some())
    .then_some(location);

    let mut keywords = Vec::new();
    let mut seen = HashSet::new();
    for value in string_list(metadata_value(row, &["XMP-dc:Subject"])) {
        if seen.insert(value.clone()) {
            keywords.push(value);
        }
    }
    for path_value in string_list(metadata_value(row, &["XMP-lr:HierarchicalSubject"])) {
        let leaf = path_value
            .rsplit('|')
            .next()
            .unwrap_or(&path_value)
            .trim()
            .to_owned();
        if !leaf.is_empty() && seen.insert(leaf.clone()) {
            keywords.push(leaf);
        }
    }

    Ok(NormaliseCase {
        path: path.to_owned(),
        current_description,
        current_title,
        ai_description: first_string(metadata_value(row, &["XMP-mlib:AIDescription"])),
        ai_interpretation: first_string(metadata_value(row, &["XMP-mlib:AIInterpretation"])),
        ai_ocr_text: string_list(metadata_value(row, &["XMP-mlib:AIOcrText"])),
        ai_objects: string_list(metadata_value(row, &["XMP-mlib:AIObjects"])),
        location,
        keywords,
        date: first_string(metadata_value(row, &["ExifIFD:DateTimeOriginal"])),
    })
}

fn generated_description_prompt(case: &NormaliseCase) -> medialibrary_tauri_lib::normalise::DescriptionMergePrompt {
    build_description_merge_prompt(&DescriptionInput {
        description: None,
        image_description: None,
        caption_abstract: None,
        iptc_charset_is_utf8: true,
        ai_description: case.ai_description.clone(),
        ai_interpretation: case.ai_interpretation.clone(),
        ai_ocr_text: case.ai_ocr_text.clone(),
        ai_objects: case.ai_objects.clone(),
        location_context: case.location.clone(),
        keywords_context: case.keywords.clone(),
        date_context: case.date.clone(),
    })
}

fn generated_title_prompt(
    case: &NormaliseCase,
    description: &str,
) -> medialibrary_tauri_lib::normalise::TitleGenPrompt {
    build_title_gen_prompt(&TitleInput {
        title: None,
        object_name: None,
        description_canonical: Some(description.to_owned()),
        location_context: case.location.clone(),
        keywords_context: case.keywords.clone(),
    })
    .expect("generated description is non-empty")
}

async fn generate_field(
    client: &Client,
    api_key: &str,
    mut body: Value,
    reasoning: ReasoningSetting,
    field: &str,
) -> GeneratedValue {
    reasoning.apply(&mut body);
    let started = Instant::now();
    match post_response_body(client, api_key, &body).await {
        Ok(response) => {
            let elapsed_ms = started.elapsed().as_millis();
            let usage = UsageStats::from_response(&response);
            let status = response["status"].as_str().map(str::to_owned);
            if status.as_deref() == Some("incomplete") {
                return GeneratedValue {
                    value: None,
                    usage: Some(usage),
                    elapsed_ms,
                    status,
                    error: Some(format!(
                        "incomplete: {}",
                        response["incomplete_details"]["reason"]
                            .as_str()
                            .unwrap_or("unknown")
                    )),
                };
            }
            let parsed = extract_response_text(&response)
                .ok_or_else(|| "response contained no structured text".to_owned())
                .and_then(|text| serde_json::from_str::<Value>(text).map_err(|e| e.to_string()));
            match parsed {
                Ok(value) => GeneratedValue {
                    value: value[field].as_str().map(str::to_owned),
                    usage: Some(usage),
                    elapsed_ms,
                    status,
                    error: value[field]
                        .as_str()
                        .is_none()
                        .then(|| format!("structured output missing {field}")),
                },
                Err(error) => GeneratedValue {
                    value: None,
                    usage: Some(usage),
                    elapsed_ms,
                    status,
                    error: Some(error),
                },
            }
        }
        Err(error) => GeneratedValue {
            value: None,
            usage: None,
            elapsed_ms: started.elapsed().as_millis(),
            status: None,
            error: Some(error.to_string()),
        },
    }
}

fn judge_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["descriptionWinner", "titleWinner", "descriptionReason", "titleReason"],
        "properties": {
            "descriptionWinner": { "type": "string", "enum": ["A", "B", "tie"] },
            "titleWinner": { "type": "string", "enum": ["A", "B", "tie"] },
            "descriptionReason": { "type": "string" },
            "titleReason": { "type": "string" }
        }
    })
}

async fn judge_pair(
    client: &Client,
    api_key: &str,
    judge_model: &str,
    case: &NormaliseCase,
    generated_description: &str,
    generated_title: &str,
    swap: bool,
) -> JudgeResult {
    let (description_a, description_b, title_a, title_b) = if swap {
        (
            generated_description,
            case.current_description.as_str(),
            generated_title,
            case.current_title.as_str(),
        )
    } else {
        (
            case.current_description.as_str(),
            generated_description,
            case.current_title.as_str(),
            generated_title,
        )
    };
    let comparison = format!(
        "Compare two candidate metadata sets for the supplied image. Judge factual accuracy first, then useful specificity, completeness, concise natural wording, and absence of invention. A title should be short, representative, and useful for browsing. Do not prefer a candidate merely because it is longer.\n\nDescription A:\n{}\n\nDescription B:\n{}\n\nTitle A: {}\nTitle B: {}",
        description_a, description_b, title_a, title_b
    );
    let image = match image_content_item(case.path.to_string_lossy().as_ref()) {
        Ok(image) => image,
        Err(error) => {
            return JudgeResult {
                model: judge_model.to_owned(),
                result: None,
                usage: None,
                elapsed_ms: 0,
                error: Some(error.to_string()),
            }
        }
    };
    let mut body = serde_json::json!({
        "model": judge_model,
        "input": [{
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": comparison },
                image
            ]
        }],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "normalise_comparison",
                "strict": true,
                "schema": judge_schema()
            }
        },
        "max_output_tokens": 600
    });
    if judge_model.starts_with("gpt-5.6") {
        body["reasoning"] = serde_json::json!({ "effort": "low" });
    } else {
        body["temperature"] = serde_json::json!(0);
        body["top_p"] = serde_json::json!(1);
    }
    let started = Instant::now();
    match post_response_body(client, api_key, &body).await {
        Ok(response) => {
            let usage = UsageStats::from_response(&response);
            let parsed = extract_response_text(&response)
                .ok_or_else(|| "judge response contained no structured text".to_owned())
                .and_then(|text| serde_json::from_str::<Value>(text).map_err(|e| e.to_string()))
                .map(|mut result| {
                    result["candidateMapping"] = if swap {
                        serde_json::json!({"A": "generated_luna", "B": "existing_nano"})
                    } else {
                        serde_json::json!({"A": "existing_nano", "B": "generated_luna"})
                    };
                    result
                });
            match parsed {
                Ok(result) => JudgeResult {
                    model: judge_model.to_owned(),
                    result: Some(result),
                    usage: Some(usage),
                    elapsed_ms: started.elapsed().as_millis(),
                    error: None,
                },
                Err(error) => JudgeResult {
                    model: judge_model.to_owned(),
                    result: None,
                    usage: Some(usage),
                    elapsed_ms: started.elapsed().as_millis(),
                    error: Some(error),
                },
            }
        }
        Err(error) => JudgeResult {
            model: judge_model.to_owned(),
            result: None,
            usage: None,
            elapsed_ms: started.elapsed().as_millis(),
            error: Some(error.to_string()),
        },
    }
}

fn resolved_winner(judge: &JudgeResult, field: &str) -> Option<&'static str> {
    let result = judge.result.as_ref()?;
    let winner = result[field].as_str()?;
    if winner == "tie" {
        return Some("tie");
    }
    let mapping = result["candidateMapping"].as_object()?;
    match mapping.get(winner)?.as_str()? {
        "generated_luna" => Some("luna"),
        "existing_nano" => Some("existing"),
        _ => None,
    }
}

pub async fn run(
    image_paths: &[String],
    output_path: Option<&str>,
    reasoning_settings: &[ReasoningSetting],
    judge_model: Option<&str>,
    model: &str,
    client: &Client,
    api_key: &str,
    yes: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if image_paths.is_empty() {
        return Err("normalise experiment requires at least one --normalise-case".into());
    }
    let reasoning_settings: Vec<ReasoningSetting> = if reasoning_settings.is_empty() {
        vec![ReasoningSetting::Omitted, ReasoningSetting::None, ReasoningSetting::Low]
    } else {
        reasoning_settings.to_vec()
    };
    let mut cases = Vec::new();
    for path in image_paths {
        let case = load_case(Path::new(path))?;
        if case.ai_description.is_none()
            && case.ai_interpretation.is_none()
            && case.ai_ocr_text.is_empty()
            && case.ai_objects.is_empty()
        {
            return Err(format!("{} has no retained AI context", path).into());
        }
        cases.push(case);
    }

    let generation_calls = cases.len() * reasoning_settings.len() * 2;
    let judge_calls = judge_model
        .map(|_| cases.len() * reasoning_settings.len())
        .unwrap_or(0);
    println!(
        "Normalise experiment: {} case(s), reasoning={:?}, generation calls={}, judge calls={}",
        cases.len(), reasoning_settings, generation_calls, judge_calls
    );
    for case in &cases {
        println!("  {}", case.path.display());
    }
    if !yes {
        print!("Send {} request(s) to OpenAI API? (y/n): ", generation_calls + judge_calls);
        std::io::stdout().flush()?;
        let mut confirmation = String::new();
        std::io::stdin().read_line(&mut confirmation)?;
        if confirmation.trim().to_lowercase() != "y" {
            return Ok(());
        }
    }

    let production_http = OpenAiHttp::new(OPENAI_BASE_URL, api_key, 0);
    let production_client = OpenAiNormaliseClient::new(production_http, model);
    let mut records = Vec::new();
    let mut generation_usage = UsageStats::default();
    let mut judge_usage = UsageStats::default();
    let mut description_wins = [0usize; 3]; // luna, existing, tie
    let mut title_wins = [0usize; 3];

    for (case_index, case) in cases.iter().enumerate() {
        for (reasoning_index, reasoning) in reasoning_settings.iter().copied().enumerate() {
            println!("\n--- {} / {} ---", case.path.display(), reasoning.label());
            let description_prompt = generated_description_prompt(case);
            let description = generate_field(
                client,
                api_key,
                production_client.description_request_body(&description_prompt),
                reasoning,
                "description",
            )
            .await;
            if let Some(usage) = description.usage {
                generation_usage.add(&usage);
            }
            println!("Current description: {}", case.current_description);
            println!(
                "Luna description: {}",
                description.value.as_deref().unwrap_or("<failed>")
            );

            let title = if let Some(generated_description) = description.value.as_deref() {
                let title_prompt = generated_title_prompt(case, generated_description);
                generate_field(
                    client,
                    api_key,
                    production_client.title_request_body(&title_prompt),
                    reasoning,
                    "title",
                )
                .await
            } else {
                GeneratedValue {
                    value: None,
                    usage: None,
                    elapsed_ms: 0,
                    status: None,
                    error: Some("description generation failed".into()),
                }
            };
            if let Some(usage) = title.usage {
                generation_usage.add(&usage);
            }
            println!("Current title: {}", case.current_title);
            println!("Luna title: {}", title.value.as_deref().unwrap_or("<failed>"));

            let judge = match (
                judge_model,
                description.value.as_deref(),
                title.value.as_deref(),
            ) {
                (Some(judge_model), Some(generated_description), Some(generated_title)) => {
                    let judged = judge_pair(
                        client,
                        api_key,
                        judge_model,
                        case,
                        generated_description,
                        generated_title,
                        (case_index + reasoning_index) % 2 == 1,
                    )
                    .await;
                    if let Some(usage) = judged.usage {
                        judge_usage.add(&usage);
                    }
                    if let Some(winner) = resolved_winner(&judged, "descriptionWinner") {
                        description_wins[match winner { "luna" => 0, "existing" => 1, _ => 2 }] += 1;
                    }
                    if let Some(winner) = resolved_winner(&judged, "titleWinner") {
                        title_wins[match winner { "luna" => 0, "existing" => 1, _ => 2 }] += 1;
                    }
                    println!("Judge: {}", serde_json::to_string_pretty(&judged.result)?);
                    Some(judged)
                }
                _ => None,
            };

            records.push(NormaliseExperimentRecord {
                path: case.path.clone(),
                model: model.to_owned(),
                reasoning: reasoning.label().to_owned(),
                current_description: case.current_description.clone(),
                generated_description: description,
                current_title: case.current_title.clone(),
                generated_title: title,
                prompt_context: case.clone(),
                judge,
            });
        }
    }

    if let Some(path) = output_path {
        let mut output = std::io::BufWriter::new(std::fs::File::create(path)?);
        for record in &records {
            serde_json::to_writer(&mut output, record)?;
            output.write_all(b"\n")?;
        }
        output.flush()?;
        println!("Wrote {}", path);
    }

    println!(
        "\nNormalise summary: records={} generation input={} cached={} cache_writes={} output={} reasoning={}",
        records.len(),
        generation_usage.input_tokens,
        generation_usage.cached_input_tokens,
        generation_usage.cache_write_input_tokens,
        generation_usage.output_tokens,
        generation_usage.reasoning_tokens
    );
    if let Some(pricing) = get_model_pricing().get(model) {
        println!("Generation cost: ${:.6}", generation_usage.cost(pricing));
    }
    if judge_model.is_some() {
        println!(
            "Judge winners — descriptions: luna={} existing={} tie={}; titles: luna={} existing={} tie={}",
            description_wins[0],
            description_wins[1],
            description_wins[2],
            title_wins[0],
            title_wins[1],
            title_wins[2]
        );
        println!(
            "Judge usage: input={} cached={} cache_writes={} output={} reasoning={}",
            judge_usage.input_tokens,
            judge_usage.cached_input_tokens,
            judge_usage.cache_write_input_tokens,
            judge_usage.output_tokens,
            judge_usage.reasoning_tokens
        );
        if let Some(judge_model) = judge_model {
            if let Some(pricing) = get_model_pricing().get(judge_model) {
                println!("Judge cost: ${:.6}", judge_usage.cost(pricing));
            }
        }
    }
    Ok(())
}
