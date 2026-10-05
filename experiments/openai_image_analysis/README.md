# OpenAI Experiments

Rust app for experimenting with OpenAI's Responses API. It supports image
description and location-normalization evaluations.

## Setup

1. Copy `.env.example` to `.env`:

   ```
   cp .env.example .env
   ```

2. Add your OpenAI API key to `.env`:

   ```
   OPENAI_API_KEY=sk-...
   ```

3. Build and run:
   ```
   cargo run
   ```

## Usage

The harness is command-line driven and reuses the production request builder and
pricing table. List the supported benchmark models with:

```sh
cargo run -- --list-models
```

Run one or more images by repeating `--image`:

```sh
cargo run -- --model gpt-6-luna --image photo1.jpg --image photo2.jpg
```

Use `--output-next-to-image` only on temporary benchmark copies; it writes each
structured result beside its input. Use `--yes` for reviewed unattended runs.
The end-of-run summary reports actual token usage, cost, prompt-cache behavior,
and estimate error.

## Location normalization

The location mode reads raw GeocodeJSON and JSONv2 evidence from a
`MediaLibraryTargetApplyLog.jsonl`, deduplicates identical evidence pairs, and
runs the production (`baseline`) or candidate (`strict`) prompt. Repeating each
request makes output instability visible.

```sh
cargo run -- \
  --model gpt-5.6-luna \
  --location-apply-log "D:\Pictures\MediaLibraryTargetApplyLog.jsonl" \
  --location-case "IMG_0001.jpg" \
  --location-case "IMG_0002.jpg" \
  --location-prompt strict \
  --repeat 3 \
  --location-output location-results.jsonl
```

Omit `--location-case` to evaluate every unique evidence pair in the log. Use
`--yes` for an unattended run after reviewing the request count. The output
JSONL records the model, prompt variant, repetition, structured result, token
usage, and any error for each call.

Location experiments allow up to 1,000 output tokens because reasoning models
count hidden reasoning against `max_output_tokens`; a 250-token cap can be
exhausted before the structured answer is emitted.

## Key Functions

- `build_response_request()` - Builds request with text + multiple images
- `build_text_only_request()` - Simple text-only request for comparison
- `call_responses_api()` - Makes the actual API call
- `ImageInput::from_file()` - Loads an image file and converts to base64
- `load_location_cases()` - Extracts and deduplicates evidence from an apply log
- `run_location_experiment()` - Runs repeated prompt/model location evaluations

## Dependencies

- `reqwest` - HTTP client for API calls
- `serde` / `serde_json` - JSON serialization
- `base64` - Image encoding
- `image` - Image processing (optional, for future use)
- `tracing` - Logging
- `dotenv` - Environment variable loading

## Luna normalisation and cache experiments

See [LUNA_NORMALISE_AND_CACHE.md](LUNA_NORMALISE_AND_CACHE.md) for the measured normalisation recommendation, current Luna/Terra pricing, and the rationale for explicit cache mode without an explicit breakpoint.
