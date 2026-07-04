# AI Image Description (OpenAI Responses API) — V1 Design

Status: design, pre-implementation. Companion to
`experiments/openai_image_analysis/MODEL_CHOICE.md`.

## Goal

Generate per-image AI descriptions via OpenAI `/responses`, store them as
XMP draft edits that flow through the existing apply pipeline. Sets up
inputs for a follow-up metadata-normalization feature.

## Scope (V1)

- Settings screen: API key, model selector (auto-saves on change).
- Manual single-image trigger from `DetailsPane` ("Generate AI Description"
  button next to "+ Add Property").
- Backend command accepts `Vec<rel_path>` (multi-image ready) but processes
  **sequentially** (no semaphore, no parallelism).
- Single unified progress dialog covers: cost-estimation phase →
  confirmation → execution → result summary.
- Results land as typed draft edits under custom `XMP-mlib:*` namespace.
- Per-run audit log (cost, tokens, prompt version, outcomes).

## Explicitly out of scope (V1)

- Parallel / semaphore-bounded processing.
- Batch API, Flex tier.
- Reverse-geocoding hint into image prompt.
- HEIC / RAW decoding (rely on `image` crate; report decode failures).
- API key OS-keyring storage (plaintext settings.json acceptable).
- Auto-retry on truncation (`status=="incomplete"`). Prompt-side mitigation
  only.
- Local token-math fallback when `/responses/input_tokens` errors. Hard
  fail instead.
- Gallery multi-select UI trigger.
- First-run consent dialog (warning text in Settings screen suffices).
- Image-prompt tuning UI (resize, detail level).

## Architecture

### Backend

New module `src-tauri/src/openai_describe.rs`. Ports the experiment with
adaptations:

- `pub async fn describe_one(...)` — single-image: load → resize-to-1024
  JPEG q85 → base64 → `/responses` call → parse strict-JSON → return
  `DescribeOutcome { fields, usage, raw_json }`.
- Sequential `for` loop over `Vec<rel_path>` in the command handler. No
  `JoinSet`, no semaphore.
- `reqwest-retry` middleware: exp-backoff on 429/5xx, max 3 attempts,
  honour `Retry-After`. Each retry attempt emits a `describe_retry` event
  so the dialog can surface "rate-limited, retrying…".
- Cancellation flag in new `DescribeState` (mirrors `ApplyEditsState`).
  Checked at each loop iteration boundary (never mid-request).
- On successful image: merge fields into typed draft store via
  `draft_edits::save_typed_draft_edits` immediately, before next image
  starts → crash-safe partial progress.
- Emits events:
  - `describe_estimate_started { total }` — preflight begins
  - `describe_estimate_progress { current, total, rel_path, tokens, cost_usd }`
  - `describe_estimate_complete { total_input_tokens, predicted_cost_usd, upper_bound_cost_usd }`
  - `describe_started { total }` — user confirmed, real work begins
  - `describe_progress { current, total, rel_path, status, error }`
    where `status ∈ { ok, retrying, failed_decode, failed_api, refused, incomplete }`
  - `describe_retry { rel_path, attempt, reason }` — separate from progress so
    dialog can show "rate-limited…" inline without bumping the counter
  - `describe_complete { applied: [...], failed: [{rel_path, reason}], usage_summary }`

### Tauri commands

- `estimate_describe_cost_cmd(folder, rel_paths) -> ()` — emits events, no
  return payload (UI reads events).
- `describe_images_cmd(folder, rel_paths) -> DescribeResult` — runs after
  confirm; emits progress, returns final summary.
- `cancel_describe_cmd()` — signals cancellation flag.
- `load_settings_cmd() -> Settings`
- `save_settings_cmd(Settings)`

The estimate + run split lets the UI gate on user confirm between them.
Both share `DescribeState` so cancel works in either phase.

### Settings

`src-tauri/src/settings.rs`. Plaintext JSON in `app_data_dir/settings.json`,
atomic write (same pattern as `draft_edits.rs`).

```rust
struct Settings {
    openai_api_key: String,   // plaintext, V1
    openai_model: String,     // default "gpt-4o"
}
```

Recommended models hard-coded (from MODEL_CHOICE.md):
`gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-4o` (default), `gpt-5.4`, `gpt-5.5`.
Pricing table inlined; no `is_recommended_for_image_description` filter
function needed since the list is already the recommended set.

### Custom XMP namespace — embedded config

ExifTool accepts `-config <path>` pointing at any file; it does not need
to live next to the user's exiftool install. Plan:

1. Author `src-tauri/resources/mlib.ExifTool_config` registering namespace:
   ```perl
   %Image::ExifTool::UserDefined = (
     'Image::ExifTool::XMP::Main' => {
       mlib => {
         SubDirectory => { TagTable => 'Image::ExifTool::UserDefined::mlib' },
       },
     },
   );
   %Image::ExifTool::UserDefined::mlib = (
     GROUPS    => { 0 => 'XMP', 1 => 'XMP-mlib', 2 => 'Image' },
     NAMESPACE => { 'mlib' => 'https://medialibrary.local/ns/1.0/' },
     WRITABLE  => 'string',
     AIDescription   => { },
     AIInterpretation=> { },
     AITags          => { List => 'Bag' },
     AIObjects       => { List => 'Bag' },
     AIOcrText       => { List => 'Bag' },
     AIModel         => { },
     AIGeneratedAt   => { Groups => { 2 => 'Time' }, %Image::ExifTool::XMP::dateTimeInfo },
     AIPromptVersion => { },
   );
   1; #end
   ```
2. Embed file bytes at compile time via `include_bytes!`.
3. On app start, write bytes to `app_data_dir/mlib.ExifTool_config` if
   absent or hash differs (so updates ship cleanly with new app versions).
4. Pass `-config <that_path>` as the **first** argument on every exiftool
   invocation (read + write). Modify `scanner.rs` exiftool spawns and
   `write_args.rs` arg builder.

Outcome: user's exiftool install untouched. Config lives entirely inside
our app dir.

### Tag schema overrides

Add `XMP-mlib:*` entries to `tag_schema.rs` overrides table so:

- `AITags`, `AIObjects`, `AIOcrText` → `Bag(Text)`
- `AIDescription`, `AIInterpretation`, `AIModel`, `AIPromptVersion` → `Text`
- `AIGeneratedAt` → `DateTime`

Existing editors + datatype badges then "just work".

### Frontend

- New `SettingsDialog.tsx`. Menubar entry "Settings…". Fields auto-save on
  blur / select. Includes inline warning text near the API-key field:
  > "Enabling this feature uploads your selected images to OpenAI for
  > analysis. Don't enable if your images contain content you cannot send
  > to a third-party service."
- Generalise `ApplyProgressDialog` → `ProgressDialog` with props:
  - `title`, `phase` ('estimating' | 'awaiting-confirm' | 'running' | 'done')
  - `current`, `total`, `currentFile`
  - `inlineNote` (e.g. "Rate-limited, retrying in 4s…")
  - `costEstimate?` (shown during `awaiting-confirm`, includes expected +
    upper-bound, plus per-model rate context)
  - `results?` (shown during `done`: list of succeeded + failed with reasons)
  - `actions`: dynamic — `Cancel` during estimating/running, `Confirm`+`Cancel`
    during awaiting-confirm, `Close` during done.
- New hook `useDescribeImages(rel_paths)`:
  1. `invoke('estimate_describe_cost_cmd', ...)`. Listen to estimate events,
     drive `current/total/cost` in dialog.
  2. Move to `awaiting-confirm` phase when estimate complete.
  3. On Confirm → `invoke('describe_images_cmd', ...)`.
  4. Listen to describe events, drive progress + retry note.
  5. On `describe_complete` → flip dialog to `done` showing summary.
- `DetailsPane` button "Generate AI Description". Before launching: if the
  target image already has any `XMP-mlib:AIDescription` value (saved or
  drafted), show a confirm "Existing AI description will be overwritten.
  Proceed?" — same `ask()` pattern used for Apply.

### Audit log

New `describe_log.rs` mirroring `apply_log.rs` shape. Per-run JSONL entry:

```
{ ts, model, prompt_version, n_images, n_succeeded, n_failed,
  total_input_tokens, total_cached_tokens, total_output_tokens,
  predicted_cost_usd, actual_cost_usd, errors: [...] }
```

Stored under `app_data_dir/describe_log.jsonl`. Append-only.

### Prompt + schema

Lifted from experiment with one addition for output-truncation control:

> For `ocr_text`: if the image contains many distinct text regions or block
> text longer than ~50 words, transcribe only the largest / most prominent
> regions and append a final entry `"[…and additional text omitted]"`. Do
> not OCR document body text verbatim.

`PROMPT_VERSION` constant bumped whenever instructions or schema change so
the audit log can distinguish runs.

Sampling params unchanged: `temperature=0`, `top_p=1`,
`max_output_tokens=600`. No auto-retry on `status=="incomplete"` — surface
as `failed_api` with a clear reason; user can rerun.

### Failure modes & handling

| Mode                              | Detection                         | Behaviour                                                  |
| --------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| Image decode fails                | `image` crate error pre-call      | Skip image, mark failed, continue batch                    |
| `/responses/input_tokens` errors  | non-2xx during preflight          | Abort whole run (hard fail, no fallback)                   |
| 429 / 5xx during describe         | reqwest-retry layer               | Auto-retry (≤3) w/ exp-backoff; emit `describe_retry`      |
| Retries exhausted                 | error returned to handler         | Mark image failed, continue batch                          |
| Content-moderation refusal        | `response.error` or refusal field | Mark failed with refusal text, continue batch              |
| `status=="incomplete"`            | response field                    | Mark failed (do not auto-retry); surface raw text in error |
| Unparseable JSON (after `strict`) | `serde_json::from_str` err        | Mark failed; surface raw text                              |
| User cancel                       | flag check between images         | Stop loop; preserve drafts written so far                  |

All failures aggregated into `describe_complete.failed`, shown in the
result phase of the dialog.

### Tests

- Mock OpenAI via `wiremock` (or hand-rolled axum mock) — drive happy
  path, 429-then-200, 5xx-exhausted, incomplete-status, refused-content,
  malformed-JSON, network drop mid-stream.
- Unit tests for: cost math, prompt-version bumping, exiftool-config
  materialisation hash check, partial-progress draft persistence,
  cancellation between images.
- Frontend: Vitest for dialog phase transitions (estimating → confirm →
  running → done), retry inline note, results list rendering.

## Coupling to follow-up metadata-normalization feature

Per-image describe is a clean precursor:

- AI fields stored under isolated `XMP-mlib:*` namespace → step-2 can read
  them separately from human-curated `XMP-dc:Description` / Keywords etc.
- Step 2 is pure-text → cheap; cacheable; re-runnable without re-paying
  per-image vision cost.
- `AIPromptVersion` + `AIGeneratedAt` + `AIModel` let step 2 detect stale
  AI data and trigger a re-describe when prompt evolves.
- Reverse-geocoding deferred to step 2 deliberately: keeps the image
  prompt input stable (better prompt-cache hit rate) and lets one
  geocoded lookup serve multiple downstream uses.

## File / module map

```
src-tauri/
  resources/
    mlib.ExifTool_config              (new — embedded via include_bytes!)
  src/
    openai_describe.rs                (new)
    settings.rs                       (new)
    describe_log.rs                   (new)
    lib.rs                            (register commands + DescribeState)
    scanner.rs                        (pass -config <embedded path>)
    write_args.rs                     (pass -config <embedded path>)
    tag_schema.rs                     (XMP-mlib overrides)
src/
  components/
    ProgressDialog.tsx                (renamed/generalised from ApplyProgressDialog)
    SettingsDialog.tsx                (new)
    DetailsPane.tsx                   (Generate AI Description button)
  hooks/
    useDescribeImages.ts              (new)
    useSettings.ts                    (new)
```

## Open questions deferred

- HEIC / RAW handling — defer until users hit it.
- Reverse-geocoded landmark hint into describe prompt — opt-in toggle
  later; would improve long-tail recognition per MODEL_CHOICE.
- Per-org rate-limit headroom — revisit if 429s become common.
- Parallel processing — add semaphore-bounded concurrency once measured
  throughput is the bottleneck.
- Batch API "queue overnight" mode — separate menu item later.
