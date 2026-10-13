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

## Paired description prompt evaluation

The versioned [description corpus](description-corpus.json) contains 20 known
failures and 20 controls. This mode compares [the frozen v1 baseline](prompts/description-v1.txt)
with [the evaluated v2 prompt](prompts/description-v2.txt), now used in production, using exactly
the same production image preprocessing and request settings for both. Only the
instructions change; no expected answer, filename, GPS or album hint is sent.

```powershell
cargo run --manifest-path experiments\openai_image_analysis\Cargo.toml -- `
  --model gpt-6-luna `
  --description-corpus experiments\openai_image_analysis\description-corpus.json `
  --description-image-root D:\Cloud\Pictures `
  --description-eval-output "Update Metadata Scripts\description-prompt-eval-RUN" `
  --repeat 2 --yes
```

This mode permits **only gpt-6-luna**, with no judge-model calls or fallback.
Forty cases, two prompts and two repetitions produce 160 generation requests.
The runner counterbalances prompt order, reuses the same JPEG bytes for each
pair, and writes responses immediately. It never writes beside source photos.
Use a new output directory per run; an existing responses.jsonl is rejected.

Saved artifacts include both prompts, corpus, preprocessed input images,
request settings, raw Responses API results, usage/cost and automatic screening
scores. Both prompt snapshots remain fixed when the app prompt changes. A test verifies
that the production v2 prompt matches the evaluated v2 snapshot exactly.

Scoring distinguishes `correct_specific`, `supported_generic`, `incorrect`,
`unresolved` and `provisional_specific`. Absence of a known bad label alone is
not a pass: other wrong animal identities are rejected, omitted subjects are
unresolved, and contradictory objects/tags override cautious prose. OCR is not
used as identity evidence because text can name somewhere else. Two tentative
animal replacements are excluded from confirmed-specific scores. Regex rules
are a **screening aid**, not a semantic judge; review paired results for new
wrong names, unsupported details and excessive loss of useful specificity.
See [DESCRIPTION_EVALUATION.md](DESCRIPTION_EVALUATION.md) for the corpus and
final-review rubric.

Finalize scores offline with a complete visual-review annotation file:

```powershell
python -B experiments\openai_image_analysis\score_description_eval.py RUN_DIRECTORY REVIEW_JSON
python -B -m unittest discover -s experiments\openai_image_analysis -p test_score_description_eval.py
```

Each review is keyed by `case_id`, `prompt` and `repetition`, and supplies
`identity`, `rationale`, `indexed_false_claims`, `unsupported_details` and
`salient_subject_present`. The file also names the reviewer. The scorer rejects
missing/duplicate reviews, false indexed claims marked as safe, and provisional
species marked confirmed. Evidence-backed reference corrections are recorded
separately and applied to both prompts; the original manifest is preserved.

Offline checks:

```powershell
cargo fmt --manifest-path experiments\openai_image_analysis\Cargo.toml -- --check
cargo clippy --manifest-path experiments\openai_image_analysis\Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path experiments\openai_image_analysis\Cargo.toml
```

## Paired metadata-context evaluation

Add `--description-context SNAPSHOT.json` to the paired description command to
compare `v2` (image only) against `v2_context` (the same v2 instructions and image,
plus one contextual text block). Only **gpt-6-luna** is permitted, with no paid
judge or fallback. Two repetitions over the same 40 cases make 160 calls.

The snapshot is a JSON object keyed by every corpus case ID, with exactly these
allowed fields per case:

- `file_path`: full path including folders and filename; must resolve to the
  actual corpus image.
- `location_created`: existing structured `XMP-iptcExt:LocationCreated`, if present.
- `capture_timestamp`: existing `ExifIFD:DateTimeOriginal` with optional
  `ExifIFD:OffsetTimeOriginal` and `ExifIFD:SubSecTimeOriginal` components.

Extract these fields read-only from the source files before the run. Do not use
captions, keywords, AI descriptions or reference labels as context. Omit missing
fields and do not supply filesystem modification dates or inferred timezones.
The text block labels metadata as context rather than instructions, distinguishes
camera position from pictured subjects and requires visible support for identities.
It asks the model not to repeat file paths or timestamps merely because they are supplied.

The runner saves the context snapshot, both variant names and an example context
request without image data alongside its usual raw responses and input images.
The offline scorer reads the variant names from the saved settings and requires a
complete review of both arms. Report specific recognition, wrong identities,
false indexed claims and invented details separately; inspect context-driven
claims even if the original wrong-label regex does not flag them.

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
