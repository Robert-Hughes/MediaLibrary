use base64::Engine;
use clap::Parser;
use image::ImageReader;
use reqwest::Client;
use std::collections::HashMap;
use std::env;
use std::io::Cursor;

/// Max dimension (long side) to resize an image to before uploading.
///
/// Rationale: OpenAI's vision models internally resize images so the short side
/// fits within ~768px (for "high" detail) or down to a 512px tile grid. Uploading
/// a multi-megapixel original wastes bandwidth, balloons the base64 payload by
/// ~33%, and increases request latency — the server discards the extra pixels
/// anyway. Downscaling client-side to 1024px long side gives the model the same
/// effective input it would have used, at a fraction of the upload size.
const MAX_IMAGE_DIMENSION: u32 = 1024;

/// Hard cap on output tokens per response.
///
/// Hitting this cap does NOT cause the model to gracefully compact its
/// response — generation is a hard cutoff mid-token, leaving the structured
/// JSON output truncated and unparseable. So this must be set comfortably
/// above the realistic worst case, and we must check `status == "incomplete"`
/// on the response to detect cases where we underestimated.
const MAX_OUTPUT_TOKENS: u32 = 600;

/// Expected output tokens for a typical photo (used for cost estimation only).
///
/// Description ~100 tokens, objects/tags arrays ~120, ocr_text often empty.
/// Bounded above by MAX_OUTPUT_TOKENS.
const EXPECTED_OUTPUT_TOKENS: u32 = 250;

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Parser, Debug)]
#[command(name = "openai_image_analysis")]
#[command(about = "OpenAI API experimentation tool", long_about = None)]
struct Args {
    /// List available models with pricing information
    #[arg(long)]
    list_models: bool,
}

/// Pricing information for a model
#[derive(Debug, Clone)]
struct ModelPricing {
    input_per_1m: f64,
    cached_input_per_1m: f64,
    output_per_1m: f64,
    supports_batch: bool,
}

/// Get pricing information for models (prices per 1M tokens in USD)
fn get_model_pricing() -> HashMap<String, ModelPricing> {
    let mut pricing = HashMap::new();

    // Standard models
    pricing.insert("gpt-5.5".to_string(), ModelPricing {
        input_per_1m: 5.00,
        cached_input_per_1m: 0.50,
        output_per_1m: 30.00,
        supports_batch: true,
    });

    pricing.insert("gpt-5.5-pro".to_string(), ModelPricing {
        input_per_1m: 30.00,
        cached_input_per_1m: 0.0,
        output_per_1m: 180.00,
        supports_batch: true,
    });

    pricing.insert("gpt-5.4".to_string(), ModelPricing {
        input_per_1m: 2.50,
        cached_input_per_1m: 0.25,
        output_per_1m: 15.00,
        supports_batch: true,
    });

    pricing.insert("gpt-5.4-mini".to_string(), ModelPricing {
        input_per_1m: 0.75,
        cached_input_per_1m: 0.075,
        output_per_1m: 4.50,
        supports_batch: true,
    });

    pricing.insert("gpt-5.4-nano".to_string(), ModelPricing {
        input_per_1m: 0.20,
        cached_input_per_1m: 0.02,
        output_per_1m: 1.25,
        supports_batch: true,
    });

    pricing.insert("gpt-5.4-pro".to_string(), ModelPricing {
        input_per_1m: 30.00,
        cached_input_per_1m: 0.0,
        output_per_1m: 180.00,
        supports_batch: true,
    });

    // Realtime models
    pricing.insert("gpt-realtime-1.5".to_string(), ModelPricing {
        input_per_1m: 4.00,  // Text input
        cached_input_per_1m: 0.40,
        output_per_1m: 16.00,
        supports_batch: false,
    });

    pricing.insert("gpt-realtime-mini".to_string(), ModelPricing {
        input_per_1m: 0.60,  // Text input
        cached_input_per_1m: 0.06,
        output_per_1m: 2.40,
        supports_batch: false,
    });

    // Image generation models
    pricing.insert("gpt-image-2".to_string(), ModelPricing {
        input_per_1m: 5.00,  // Text input
        cached_input_per_1m: 1.25,
        output_per_1m: 30.00,
        supports_batch: false,
    });

    pricing.insert("gpt-image-1.5".to_string(), ModelPricing {
        input_per_1m: 5.00,  // Text input
        cached_input_per_1m: 1.25,
        output_per_1m: 10.00,
        supports_batch: false,
    });

    pricing.insert("gpt-image-1-mini".to_string(), ModelPricing {
        input_per_1m: 2.00,  // Text input
        cached_input_per_1m: 0.20,
        output_per_1m: 8.00,
        supports_batch: false,
    });

    // Transcription models
    pricing.insert("gpt-4o-transcribe".to_string(), ModelPricing {
        input_per_1m: 2.50,
        cached_input_per_1m: 0.0,
        output_per_1m: 10.00,
        supports_batch: false,
    });

    pricing.insert("gpt-4o-mini-transcribe".to_string(), ModelPricing {
        input_per_1m: 1.25,
        cached_input_per_1m: 0.0,
        output_per_1m: 5.00,
        supports_batch: false,
    });

    // Legacy models
    pricing.insert("gpt-5.3-chat-latest".to_string(), ModelPricing {
        input_per_1m: 1.75,
        cached_input_per_1m: 0.175,
        output_per_1m: 14.00,
        supports_batch: true,
    });

    pricing.insert("gpt-5.3-codex".to_string(), ModelPricing {
        input_per_1m: 1.75,
        cached_input_per_1m: 0.175,
        output_per_1m: 14.00,
        supports_batch: true,
    });

    // GPT-4 series (legacy)
    pricing.insert("gpt-4o".to_string(), ModelPricing {
        input_per_1m: 2.50,
        cached_input_per_1m: 1.25,
        output_per_1m: 10.00,
        supports_batch: true,
    });

    pricing.insert("gpt-4o-mini".to_string(), ModelPricing {
        input_per_1m: 0.15,
        cached_input_per_1m: 0.075,
        output_per_1m: 0.60,
        supports_batch: true,
    });

    pricing.insert("gpt-4.1".to_string(), ModelPricing {
        input_per_1m: 2.50,
        cached_input_per_1m: 1.25,
        output_per_1m: 10.00,
        supports_batch: true,
    });

    pricing.insert("gpt-4.1-mini".to_string(), ModelPricing {
        input_per_1m: 0.40,
        cached_input_per_1m: 0.20,
        output_per_1m: 1.60,
        supports_batch: true,
    });

    pricing.insert("gpt-4.1-nano".to_string(), ModelPricing {
        input_per_1m: 0.10,
        cached_input_per_1m: 0.05,
        output_per_1m: 0.40,
        supports_batch: true,
    });

    pricing
}

/// Check if a model is a checkpoint/snapshot with a date
fn is_checkpoint_model(model_id: &str) -> bool {
    // Look for date patterns like 2024-01-01, 20240101, etc.
    let date_patterns = [
        r"\d{4}-\d{2}-\d{2}",  // 2024-01-01
        r"\d{8}",              // 20240101
        r"\d{4}\.\d{2}\.\d{2}", // 2024.01.01
    ];

    for pattern in &date_patterns {
        if regex::Regex::new(pattern).unwrap().is_match(model_id) {
            return true;
        }
    }

    false
}

/// Check if a model supports vision/image inputs
/// Based on https://developers.openai.com/api/docs/guides/images-vision
fn supports_vision(model_id: &str) -> bool {
    // Models that support vision according to the documentation
    let vision_models = [
        // GPT-5 series
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.2",
        "gpt-5-mini",
        "gpt-5-nano",
        // GPT-4 series
        "gpt-4o",
        "gpt-4.1",
        "gpt-4o-mini",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        // Codex variants
        "gpt-5.3-codex",
        "gpt-5-codex-mini",
        "gpt-5.1-codex-mini",
        "gpt-5.2-codex",
        // Chat variants
        "gpt-5.2-chat-latest",
        // o-series
        "o4-mini",
        "o1",
        "o1-pro",
        "o3",
        // Special models
        "computer-use-preview",
    ];

    // Check if the model ID starts with any of the vision model prefixes
    vision_models.iter().any(|&vm| model_id.starts_with(vm))
}

/// Calculate the number of tokens an image will use based on its dimensions and the model
fn calculate_image_tokens(width: u32, height: u32, model_id: &str) -> u32 {
    let is_gpt4_o_mini = model_id.starts_with("gpt-4o-mini") || model_id.starts_with("gpt-4.1-mini") || model_id.starts_with("gpt-4.1-nano");
    let is_o1 = model_id.starts_with("o1") || model_id.starts_with("o3");
    let is_patch_model = model_id.starts_with("gpt-5") || model_id.starts_with("o4");

    if is_patch_model {
        let multiplier = if model_id.ends_with("-nano") {
            2.46
        } else if model_id.ends_with("-mini") {
            if model_id.starts_with("o4") { 1.72 } else { 1.62 }
        } else {
            1.62 // Default fallback
        };
        let patches = ((width as f64 / 32.0).ceil() * (height as f64 / 32.0).ceil()) as u32;
        return (patches as f64 * multiplier).ceil() as u32;
    }

    let base_tokens = if is_gpt4_o_mini { 2833 } else if is_o1 { 75 } else { 85 };
    let tile_tokens = if is_gpt4_o_mini { 5667 } else if is_o1 { 150 } else { 170 };

    // Initial resize to fit within 2048x2048
    let mut w = width as f64;
    let mut h = height as f64;
    if w > 2048.0 || h > 2048.0 {
        let aspect_ratio = w / h;
        if aspect_ratio > 1.0 {
            w = 2048.0;
            h = 2048.0 / aspect_ratio;
        } else {
            h = 2048.0;
            w = 2048.0 * aspect_ratio;
        }
    }

    // Scale short side to 768px
    if w < h && w > 768.0 {
        h = h * (768.0 / w);
        w = 768.0;
    } else if h <= w && h > 768.0 {
        w = w * (768.0 / h);
        h = 768.0;
    }

    let tiles = (w / 512.0).ceil() as u32 * (h / 512.0).ceil() as u32;
    tiles * tile_tokens + base_tokens
}
/// Initialize logging
fn init_logging() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();
}

/// Load API key from environment
fn get_api_key() -> String {
    env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY must be set")
}

/// Load, downscale, and re-encode an image as JPEG bytes.
///
/// We downscale to MAX_IMAGE_DIMENSION on the long side before sending. There's
/// no benefit to uploading a high-res image and having the OpenAI server
/// downscale it internally — we pay for the bandwidth + base64 overhead and the
/// model only ever sees the lower-resolution version anyway. Doing the resize
/// locally also gives us deterministic, inspectable inputs and lets us drop the
/// per-image `detail` parameter (the resize already bounds the token cost).
///
/// Images smaller than the cap are still re-encoded to JPEG quality 85 to strip
/// metadata and normalise the encoding.
fn load_and_downscale_image(path: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let img = ImageReader::open(path)?.with_guessed_format()?.decode()?;

    let (w, h) = (img.width(), img.height());
    let resized = if w.max(h) > MAX_IMAGE_DIMENSION {
        // Preserve aspect ratio; fit long side to MAX_IMAGE_DIMENSION.
        img.resize(
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        img
    };

    // Re-encode as JPEG. JPEG at q=85 is a good size/quality tradeoff for
    // photographic content and is universally supported by the vision API.
    let rgb = resized.to_rgb8();
    let mut buf = Vec::new();
    {
        let mut cursor = Cursor::new(&mut buf);
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85);
        encoder.encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )?;
    }

    tracing::info!(
        "Image {}: {}x{} -> {}x{}, {} bytes JPEG",
        path,
        w,
        h,
        rgb.width(),
        rgb.height(),
        buf.len()
    );

    Ok(buf)
}

/// Load image from file and create content item for Responses API.
///
/// The image is downscaled locally (see `load_and_downscale_image`) and always
/// uploaded as JPEG, regardless of source format. We drop the per-image
/// `detail` field because we've already bounded the resolution client-side.
pub fn image_content_item(path: &str) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let jpeg_bytes = load_and_downscale_image(path)?;
    let data = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
    let image_url = format!("data:image/jpeg;base64,{}", data);

    Ok(serde_json::json!({
        "type": "input_image",
        "image_url": image_url,
    }))
}

/// System-level instructions sent in the Responses API `instructions` field.
///
/// Rationale:
/// - Putting the system prompt in `instructions` (separate from the user
///   message) makes it a stable prefix across calls, which helps prompt
///   caching kick in when we process many images with the same setup.
/// - Imperative phrasing + explicit prohibitions ("no preamble") suppresses
///   the model's default tendency to start with filler like "The image shows".
/// - Constraining length keeps output cost bounded and predictable.
const SYSTEM_INSTRUCTIONS: &str = "\
You are an image description engine for a media library. Output a literal, \
factual description of the image contents only. Do not speculate about the \
photographer's intent, the meaning, or the emotional tone. Do not start with \
phrases like 'The image shows', 'This is a photo of', 'I can see', or similar \
preamble — begin directly with the description. Use 2-4 sentences in present \
tense. \
\
Provide `tags` as a list of short search-friendly terms a photographer would \
use to organise this image in a media library: subject (e.g. 'portrait', \
'landscape', 'still-life'), setting (e.g. 'beach', 'urban', 'indoor'), \
notable content ('sunset', 'snow', 'crowd', 'wedding'), and stylistic \
qualities ('black-and-white', 'long-exposure', 'macro') where applicable. \
Prefer lowercase, hyphenated, single-concept tags. Aim for 5-15 tags. \
\
For `ocr_text`, list each distinct text region as a separate entry (a sign, \
a label, a caption are each their own entry). Transcribe verbatim. Empty \
array if no text is visible. \
\
If the image is blank, blurry, or unidentifiable, say so plainly in the \
description.";

/// JSON schema for structured output.
///
/// Rationale: a downstream media library consumer wants machine-parseable
/// fields, not free-form prose. Using `text.format.json_schema` with
/// `strict: true` guarantees the model returns valid JSON matching this shape
/// — no regex post-processing, no malformed-JSON retries.
fn description_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Literal description of the image contents, 2-4 sentences."
            },
            "objects": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Distinct nouns visible in the image (people, animals, objects, landmarks)."
            },
            // `tags` (renamed from `scene_type`) is an array of short
            // search-friendly terms, matching how photographers tag photos in
            // media-library software (subject, setting, content, style).
            "tags": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Photographer-style tags: lowercase, hyphenated, single-concept (e.g. 'sunset', 'portrait', 'black-and-white'). 5-15 entries."
            },
            // `ocr_text` is an array — distinct text regions (sign, label,
            // caption) stay distinct rather than being concatenated, so
            // downstream code can index or display them separately.
            "ocr_text": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Each visible text region transcribed verbatim, as a separate entry. Empty array if no text."
            }
        },
        "required": ["description", "objects", "tags", "ocr_text"],
        "additionalProperties": false
    })
}

/// Build request for Responses API with images only.
///
/// The user message contains only image content items — no text. The full task
/// description lives in SYSTEM_INSTRUCTIONS, and the schema enforces the
/// output shape, so a per-call user prompt adds nothing. Dropping it saves a
/// few tokens per request and keeps the per-call payload trivially constant.
fn build_response_request(
    model: &str,
    image_paths: &[&str],
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut content: Vec<serde_json::Value> = Vec::new();

    for path in image_paths {
        content.push(image_content_item(path)?);
    }

    // System prompt goes in `instructions` (stable prefix → cacheable).
    // User message holds only the per-call content (text + images).
    // `text.format` requests a strict JSON-schema-conformant response.
    //
    // Determinism / cost-control knobs:
    // - `temperature: 0`     Lowest variance. Note: this does NOT give
    //                        bit-exact reproducibility (MoE routing and GPU
    //                        nondeterminism still leak through), but it
    //                        eliminates the bulk of sampling-driven variation
    //                        so repeated calls on the same image give nearly
    //                        identical descriptions.
    // - `top_p: 1`           Explicit; nucleus sampling neutralised so
    //                        temperature is the sole knob.
    // - `seed: 42`           Best-effort reproducibility for the
    //                        non-deterministic remainder. OpenAI treats this
    //                        as a hint, not a guarantee.
    // - `max_output_tokens`  Bounds worst-case cost and stops runaway
    //                        responses. Set to 600: a typical photo response
    //                        is ~250 tokens (description ~100, objects/tags
    //                        ~120, empty ocr), but document scans or signs
    //                        with heavy OCR can push the ocr_text array
    //                        substantially higher. 600 gives headroom without
    //                        being wasteful — if the model truncates here we
    //                        want to know.
    //
    // Note: reasoning models (o-series, gpt-5 reasoning variants) ignore
    // temperature/top_p. That's fine — they're not the target here.
    let request = serde_json::json!({
        "model": model,
        "instructions": SYSTEM_INSTRUCTIONS,
        "input": [{
            "type": "message",
            "role": "user",
            "content": content
        }],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "image_description",
                "strict": true,
                "schema": description_schema()
            }
        },
        "temperature": 0,
        "top_p": 1,
        "seed": 42,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
    });

    Ok(request)
}

/// Call OpenAI Responses API
async fn call_responses_api(
    client: &Client,
    api_key: &str,
    model: &str,
    image_paths: &[&str],
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let url = format!("{}/responses", OPENAI_BASE_URL);

    let request_body = build_response_request(model, image_paths)?;

    tracing::info!("Sending request to {}", url);
    tracing::debug!("Request body: {}", serde_json::to_string_pretty(&request_body)?);

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    tracing::info!("Response status: {}", status);

    if !status.is_success() {
        return Err(format!("API request failed with status {}: {}", status, body).into());
    }

    let json: serde_json::Value = serde_json::from_str(&body)?;
    tracing::debug!("Response: {}", serde_json::to_string_pretty(&json)?);

    Ok(json)
}

/// Example: List available models (for debugging)
async fn list_models(client: &Client, api_key: &str) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let url = format!("{}/models", OPENAI_BASE_URL);

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await?;

    let body = response.text().await?;
    let json: serde_json::Value = serde_json::from_str(&body)?;

    Ok(json)
}

/// List models with pricing information
async fn list_models_with_pricing(client: &Client, api_key: &str) -> Result<(), Box<dyn std::error::Error>> {
    let models_response = list_models(client, api_key).await?;
    let pricing_table = get_model_pricing();

    println!("\n=== Available Models with Vision Support and Pricing ===\n");

    let mut vision_models = Vec::new();

    if let Some(models) = models_response["data"].as_array() {
        for model in models {
            if let Some(model_id) = model["id"].as_str() {
                // Only include models that support vision, are not checkpoints, and have pricing data
                if supports_vision(model_id) && !is_checkpoint_model(model_id) && pricing_table.contains_key(model_id) {
                    vision_models.push((model_id.to_string(), model.clone()));
                }
            }
        }
    }

    if vision_models.is_empty() {
        println!("No vision-capable models found.");
        return Ok(());
    }

    // Sort by estimated cost for a 1024x1024 image (descending)
    vision_models.sort_by(|a, b| {
        let pricing_a = pricing_table.get(&a.0);
        let pricing_b = pricing_table.get(&b.0);

        let cost_a = pricing_a.map(|p| {
            let tokens = calculate_image_tokens(1024, 1024, &a.0);
            (tokens as f64 / 1_000_000.0) * p.input_per_1m
        }).unwrap_or(0.0);

        let cost_b = pricing_b.map(|p| {
            let tokens = calculate_image_tokens(1024, 1024, &b.0);
            (tokens as f64 / 1_000_000.0) * p.input_per_1m
        }).unwrap_or(0.0);

        cost_b.partial_cmp(&cost_a).unwrap_or(std::cmp::Ordering::Equal)
    });

    use comfy_table::{Table, Cell, CellAlignment};

    let mut table = Table::new();
    table.load_preset(comfy_table::presets::ASCII_MARKDOWN);
    table.set_header(vec![
        Cell::new("Model").set_alignment(CellAlignment::Left),
        Cell::new("Input").set_alignment(CellAlignment::Right),
        Cell::new("Cached").set_alignment(CellAlignment::Right),
        Cell::new("Output").set_alignment(CellAlignment::Right),
        Cell::new("Batch / Flex").set_alignment(CellAlignment::Center),
        Cell::new("1024x1024").set_alignment(CellAlignment::Right),
        Cell::new("10k Images").set_alignment(CellAlignment::Right),
        Cell::new("Images/$1").set_alignment(CellAlignment::Right),
        Cell::new("Created").set_alignment(CellAlignment::Right),
    ]);

    for (model_id, model) in vision_models {
        let created_str = if let Some(created) = model["created"].as_i64() {
            chrono::DateTime::from_timestamp(created, 0)
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| "-".to_string())
        } else {
            "-".to_string()
        };

        if let Some(pricing) = pricing_table.get(&model_id) {
            let tokens_1024 = calculate_image_tokens(1024, 1024, &model_id);
            let cost_1024 = (tokens_1024 as f64 / 1_000_000.0) * pricing.input_per_1m;
            let cost_10k = cost_1024 * 10_000.0;
            let flex_str = if pricing.supports_batch { "Yes" } else { "No" };

            let cached_str = if pricing.cached_input_per_1m > 0.0 {
                format!("${:.2}", pricing.cached_input_per_1m)
            } else {
                "-".to_string()
            };

            let images_per_dollar = if cost_1024 > 0.0 {
                format!("{}", (1.0 / cost_1024).floor() as u64)
            } else {
                "N/A".to_string()
            };

            table.add_row(vec![
                model_id,
                format!("${:.2}", pricing.input_per_1m),
                cached_str,
                format!("${:.2}", pricing.output_per_1m),
                flex_str.to_string(),
                format!("${:.6}", cost_1024),
                format!("${:.2}", cost_10k),
                images_per_dollar,
                created_str,
            ]);
        } else {
            table.add_row(vec![
                model_id,
                "N/A".to_string(),
                "N/A".to_string(),
                "N/A".to_string(),
                "-".to_string(),
                "N/A".to_string(),
                "N/A".to_string(),
                "N/A".to_string(),
                created_str,
            ]);
        }
    }

    println!("{table}");

    println!("Note: Only models with vision/image input support are shown (excluding checkpoint/snapshot models)");
    println!("Prices are per 1M tokens in USD");
    println!("Source: https://developers.openai.com/api/docs/pricing");
    println!("Vision support: https://developers.openai.com/api/docs/guides/images-vision");

    Ok(())
}

/// Recursively truncate long strings in a JSON value for previewing
fn truncate_json_strings(value: &serde_json::Value, max_len: usize) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > max_len {
                serde_json::Value::String(format!("{}... (truncated, total {} chars)", &s[..max_len], s.len()))
            } else {
                value.clone()
            }
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(|v| truncate_json_strings(v, max_len)).collect())
        }
        serde_json::Value::Object(obj) => {
            let mut new_obj = serde_json::Map::new();
            for (k, v) in obj {
                new_obj.insert(k.clone(), truncate_json_strings(v, max_len));
            }
            serde_json::Value::Object(new_obj)
        }
        _ => value.clone(),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logging();

    // Load .env file if present
    dotenv::dotenv().ok();

    let args = Args::parse();
    let api_key = get_api_key();
    let client = Client::new();

    // Handle --list-models mode
    if args.list_models {
        list_models_with_pricing(&client, &api_key).await?;
        return Ok(());
    }

    // Normal mode: Responses API
    let model = "gpt-4o";
    tracing::info!("OpenAI API experimentation tool");
    tracing::info!("Using model: {}", model);

    // Example: Image + text request
    // Replace these with actual image paths from your workspace
    let sample_images = vec![
        "D:\\OneDrive\\Pictures\\2010\\Image0149.jpg", // Note: The user hasn't provided this image, it might fail to load. We wrap it in a warning but let it proceed to check file exist.
    ];

    if sample_images.is_empty() {
        return Err("No sample images configured. Add image paths to sample_images vector in main().".into());
    }

    // No per-call user text: the full task description is in
    // SYSTEM_INSTRUCTIONS and the response schema enforces output shape, so a
    // user prompt would just be tokens for nothing.

    // --- Pre-flight cost estimation ---
    let pricing_table = get_model_pricing();
    let pricing = pricing_table.get(model);

    println!("\n=== Pre-flight Cost Estimation ===");

    let mut total_input_tokens = 0;

    // Use official OpenAI token counting API.
    //
    // The /responses/input_tokens endpoint rejects sampling/generation params
    // (`temperature`, `top_p`, `seed`, `max_output_tokens`) with an
    // "unknown_parameter" 400 — it only accepts the input-shaping fields
    // (model, instructions, input, text). Strip those before sending.
    match build_response_request(model, &sample_images) {
        Ok(request_body) => {
            let mut count_body = request_body.clone();
            if let Some(obj) = count_body.as_object_mut() {
                for k in ["temperature", "top_p", "seed", "max_output_tokens"] {
                    obj.remove(k);
                }
            }

            let count_url = format!("{}/responses/input_tokens", OPENAI_BASE_URL);
            tracing::info!("Calling token counting API: {}", count_url);

            let count_response = client
                .post(&count_url)
                .header("Authorization", format!("Bearer {}", api_key))
                .header("Content-Type", "application/json")
                .json(&count_body)
                .send()
                .await;

            match count_response {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(body) = resp.text().await {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                            if let Some(tokens) = json["input_tokens"].as_u64() {
                                total_input_tokens = tokens as u32;
                                println!("Exact input tokens (via API): {}", total_input_tokens);
                            } else {
                                return Err(format!("Token API 200 but no 'input_tokens'. Body: {}", body).into());
                            }
                        } else {
                            return Err(format!("Token API returned non-JSON response: {}", body).into());
                        }
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    let err_body = resp.text().await.unwrap_or_default();
                    return Err(format!("Token API returned {}. {}", status, err_body).into());
                }
                Err(e) => {
                    return Err(format!("Token API request failed: {}", e).into());
                }
            }
        }
        Err(e) => return Err(format!("Failed to build request for token estimation: {}", e).into()),
    }

    if total_input_tokens == 0 {
        return Err("Cost estimation unavailable due to token API failure.".into());
    }

    match build_response_request(model, &sample_images) {
        Ok(request) => {
            let preview_request = truncate_json_strings(&request, 100);
            let request_str = serde_json::to_string_pretty(&preview_request)?;
            tracing::info!("Request to be sent (truncated for preview):\n{}", request_str);

            println!("Exact input tokens (via API): {}", total_input_tokens);
            println!(
                "Expected output tokens: {}  (worst case capped at {})",
                EXPECTED_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS
            );

            if let Some(p) = pricing {
                let input_cost = (total_input_tokens as f64 / 1_000_000.0) * p.input_per_1m;
                // Expected cost: input + typical-photo output.
                let expected_output_cost =
                    (EXPECTED_OUTPUT_TOKENS as f64 / 1_000_000.0) * p.output_per_1m;
                let expected_total = input_cost + expected_output_cost;
                // Upper-bound cost: input + full output budget. This is the
                // most you'll pay for a single call given max_output_tokens.
                let max_output_cost =
                    (MAX_OUTPUT_TOKENS as f64 / 1_000_000.0) * p.output_per_1m;
                let upper_bound_total = input_cost + max_output_cost;

                println!(
                    "Expected cost   (Standard): ${:.6}  (Input: ${:.6}, Output: ${:.6})",
                    expected_total, input_cost, expected_output_cost
                );
                println!(
                    "Upper-bound cost (Standard): ${:.6}  (Input: ${:.6}, Output: ${:.6} @ {} tok cap)",
                    upper_bound_total, input_cost, max_output_cost, MAX_OUTPUT_TOKENS
                );
                if p.supports_batch {
                    println!(
                        "Expected cost   (Flex):     ${:.6}",
                        expected_total * 0.5
                    );
                    println!(
                        "Upper-bound cost (Flex):     ${:.6}",
                        upper_bound_total * 0.5
                    );
                }
            } else {
                println!("Cost estimation unavailable: Model not in pricing table.");
            }
            println!("==================================");

            // Confirmation prompt
            print!("Send this request to OpenAI API? (y/n): ");

            use std::io::Write;
            std::io::stdout().flush().unwrap();
            let mut confirmation = String::new();
            std::io::stdin().read_line(&mut confirmation).expect("Failed to read line");

            if confirmation.trim().to_lowercase() != "y" {
                tracing::info!("Request cancelled by user");
                return Ok(());
            }

            match call_responses_api(&client, &api_key, model, &sample_images).await {
                Ok(response) => {
                    tracing::info!("API Response: {}", serde_json::to_string_pretty(&response)?);

                    // Detect truncation up front. When `status == "incomplete"`
                    // the model hit a limit mid-generation (most commonly
                    // max_output_tokens) and any JSON in the text field will
                    // be truncated and unparseable. Warn loudly — the right
                    // fix is to raise MAX_OUTPUT_TOKENS, not to try to repair
                    // the JSON.
                    let status = response["status"].as_str().unwrap_or("");
                    if status == "incomplete" {
                        let reason = response["incomplete_details"]["reason"]
                            .as_str()
                            .unwrap_or("unknown");
                        tracing::warn!(
                            "Response is incomplete (reason: {}). Structured JSON is likely truncated.",
                            reason
                        );
                        println!(
                            "\n!!! WARNING: response status='incomplete', reason='{}'. Raise MAX_OUTPUT_TOKENS and retry.",
                            reason
                        );
                    }

                    // With structured output, the model returns a JSON string in
                    // the `text` field that conforms to our schema. Parse and
                    // pretty-print it so the output is readable instead of a
                    // single escaped one-liner.
                    let raw_text = response["output"][0]["content"][0]["text"]
                        .as_str()
                        .unwrap_or("");
                    match serde_json::from_str::<serde_json::Value>(raw_text) {
                        Ok(parsed) => {
                            println!(
                                "\n=== Structured Response ===\n{}",
                                serde_json::to_string_pretty(&parsed)?
                            );
                        }
                        Err(e) => {
                            tracing::warn!("Response text was not valid JSON: {}", e);
                            println!("\n=== Text Response (raw) ===\n{}", raw_text);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("API call failed: {}", e);
                }
            }
        }
        Err(e) => {
            tracing::error!("Failed to build request: {}", e);
        }
    }

    Ok(())
}