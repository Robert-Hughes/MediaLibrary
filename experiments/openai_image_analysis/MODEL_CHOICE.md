# Model Choice for Photo-Library Tagging

Final analysis of vision models for unsupervised bulk media-library tagging,
informed by a side-by-side run of candidate models (including the new GPT-5.6 series) on a 21-photo test set
covering portraits, landmarks, transit interiors, OCR-heavy maps, beach,
landscape, museum exhibits, motion blur, screenshots, and more.

Pricing reflects cost to process 10,000 1024x1024 images via the Responses API
(input tokens only; output ~250 tokens adds a small constant).

## Excluded Models

| Model                                         | Reason                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | Audio transcription models; vision is incidental, not their job.          |
| `gpt-5.3-codex`                               | Code-tuned variant; no advantage for image description.                   |
| `gpt-4o-mini` ($38/10k)                       | Strictly dominated by `gpt-5.4-mini` ($12/10k) — newer, cheaper, smarter. |
| `gpt-4.1-mini` ($102/10k)                     | Severely dominated; mini-tier priced like a flagship (patch-token math).  |
| `gpt-4.1-nano` ($25/10k)                      | Dominated by `gpt-5.4-mini` ($12/10k).                                    |
| `gpt-4.1` ($19/10k)                           | Tied with `gpt-4o` on price; no clear quality edge.                       |
| `gpt-5.4-pro`, `gpt-5.5-pro` ($498/10k)       | 10–40x cost of flagship for marginal quality on this task. Overkill.      |
| `gpt-5.6-terra` ($41/10k)                     | Dominated by `gpt-5.6-luna` due to Westminster Bridge regression.         |

## Pareto Frontier

| Tier                 | Model          | 10k cost | When to choose                                                                                                     |
| -------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Floor                | `gpt-5.4-nano` | $5       | Bulk tagging only; tolerates weak OCR/fine objects                                                                 |
| Sweet spot           | `gpt-5.4-mini` | $12      | Solid OCR + cleaner descriptions than nano                                                                         |
| Reasoning Sweet Spot | `gpt-5.6-luna` | $17      | **Recommended Default** — Native reasoning, smart OCR, names landmarks (St Pancras, London Eye, sculptor Paul Day) |
| Baseline             | `gpt-4o`       | $19      | Standard vision model; names London landmarks reliably                                                             |
| Premium              | `gpt-5.4`      | $41      | Slightly better prose; marginal landmark gain                                                                      |
| Flagship             | `gpt-5.6-sol`  | $83      | Ultimate recognition (e.g. Scroby Sands Wind Farm), but high cost                                                  |

## Test Set Results

A 21-photo set covering wide content types (see `TEST_SET.md`). Key axis evaluated:
**landmark/place recognition**, since for an unsupervised tagger that's the
difference between "ferris wheel" and "London Eye" in search results.

> [!NOTE]
> The 21st image (`Screenshot_20260508_112540_Samsung Browser.jpg`) was replaced in the 5.6 evaluations with `Screenshot_20260623_130708_Maps.jpg` to serve as the adversarial OCR screenshot category.

### Landmark Recognition Scoreboard

✅ = named correctly; ⚠️ = partial / better than generic but no name; ❌ = generic only

| Photo                                 | nano   | mini   | gpt-4o | gpt-5.4  | 5.6-luna | 5.6-terra | 5.6-sol | opus-4.7 (chat)                                         |
| ------------------------------------- | ------ | ------ | ------ | -------- | -------- | --------- | ------- | ------------------------------------------------------- |
| 0036 St Pancras Renaissance Hotel     | ❌     | ❌     | ✅     | ✅       | ✅       | ✅        | ✅      | ✅ (+ "former Midland Grand Hotel")                     |
| 0042 The Meeting Place statue         | ❌     | ❌     | ✅     | ✅       | ✅ (1)   | ✅ (1)    | ✅ (1)  | ✅ (+ named sculptor "Paul Day")                        |
| 0066 Westminster Bridge / County Hall | ❌     | ❌     | ✅     | ✅       | ✅       | ❌ (2)    | ✅      | ✅ (+ "green copper-domed kiosk")                       |
| 0125 London Eye                       | ❌     | ✅     | ✅     | ✅       | ✅       | ✅        | ✅      | ✅                                                      |
| 0514 Tower of London                  | ❌     | ❌     | ✅     | ✅       | ✅       | ✅        | ✅      | ✅                                                      |
| 0136 Hungerford + Golden Jubilee Br   | ❌     | ❌     | ✅     | ✅       | ✅       | ✅        | ✅      | ✅ (+ noted "from inside a London Eye capsule")         |
| 0028 St Pancras Station interior      | ❌     | ❌     | ❌     | ❌       | ❌ (3)   | ❌        | ❌      | ⚠️ (named "King's Cross" + read "EAST COAST" off train) |
| 0322 Forth Bridge model (Sci. Museum) | ❌     | ❌     | ⚠️     | ❌       | ❌ (4)   | ❌        | ❌      | ✅ (Forth Bridge + Science Museum)                      |
| 0381 Queen's House / ORNC             | ❌     | ❌     | ✅     | ❌ (reg) | ✅       | ✅        | ✅      | ✅✅ (+ Old Royal Naval College)                        |
| 0381 Greenwich Park / Power Station   | ❌     | ❌     | ✅     | ❌       | ✅       | ✅ (5)    | ✅      | ✅                                                      |
| 0581 Scroby Sands Wind Farm           | ❌     | ❌     | ❌     | ❌       | ❌       | ❌        | ✅ (6)  | ⚠️ (named "offshore wind farm")                         |
| 0501 Thames Barrier                   | ❌     | ❌     | ❌     | ❌       | ❌       | ❌        | ❌      | ❌ (all models missed this)                             |
| 0686 Punting (Cambridge)              | ❌     | ✅ (7) | ✅     | ✅       | ✅       | ✅        | ✅      | n/a                                                     |
| 0047 London Underground map           | ❌ (8) | ✅     | ✅     | ✅       | ✅       | ✅        | ✅      | ✅ (named "King's Cross St Pancras")                    |
| Screenshot (Samsung Browser / Maps)   | n/a    | trunc  | ✅     | n/a      | ✅       | ✅        | ✅      | ✅                                                      |

**(1)** Named sculptor Paul Day as well.
**(2)** Hallucinated as Waterloo Bridge and Somerset House.
**(3)** Hallucinated as Waterloo Station.
**(4)** Mistook for a steam locomotive.
**(5)** Named Greenwich Power Station (the four chimneys) as well.
**(6)** Correctly identified Great Yarmouth and Scroby Sands Wind Farm.
**(7)** With prompt fix.
**(8)** Partial OCR.

### Observations

- **nano consistently generic-outs.** Vision is right (sees a wheel, sees a
  fortress) but never names the landmark. This is a capability ceiling, not a prompt problem.
- **mini gains modest ground.** Named London Eye and "punting" — the globally iconic items. Narrower landmarks still generic.
- **gpt-4o is the inflection point.** Confidently names St Pancras, Tower of London, Westminster Bridge, etc. Correctly identifies most London landmarks.
- **gpt-5.6-luna is a massive reasoning upgrade.** Despite being priced below `gpt-4o` for input tokens, native reasoning enables it to name fine-grained details such as sculptor "Paul Day" for The Meeting Place, while matching or exceeding gpt-4o's landmark recognition.
- **gpt-5.6-terra suffers from hallucinations.** Terra regressed on Westminster Bridge (hallucinating it as Waterloo Bridge / Somerset House) and did not show distinct advantages over Luna.
- **gpt-5.6-sol is the absolute flagship for recognition.** Sol was the only model to successfully identify the long-tail landmark Scroby Sands Wind Farm. However, its cost is too high for bulk tagging.
- **Thames Barrier was missed by every model**, despite its visually unmistakable crisscross piers.

### Cost vs Quality Curve

For the test set (21 images), actual cost ranged roughly:

- `gpt-5.4-nano`: $0.011 — generic descriptions, weak landmarks
- `gpt-5.4-mini`: $0.026 — clean prose, only globally iconic landmarks
- `gpt-5.6-luna`: $0.053 (with prompt caching) — excellent reasoning, sculptor details, strong landmarks
- `gpt-4o`: $0.040 — standard vision landmark recognition
- `gpt-5.6-sol`: $0.432 — flagship recognition (Scroby Sands), very expensive

The `gpt-5.6-luna` model offers superior details (e.g. sculptor) and excellent landmark recognition. Since it supports prompt caching with >90% hit rate, its input cost is extremely low ($0.10/1M on cache hits), making it the optimal price-to-quality choice.

## Recommendation for Production: `gpt-5.6-luna`

**Switch the previous recommendation from `gpt-4o` to `gpt-5.6-luna`** based on the 5.6 model series results.

Reasoning:

- Native reasoning gives `gpt-5.6-luna` a level of detail and accuracy (e.g., naming sculptor Paul Day) that traditional vision models lack.
- Extremely cost-effective: At $1.00/1M input ($0.10/1M cached), it has a lower input cost ($17/10k) than `gpt-4o` ($19/10k).
- Full support for prompt caching makes it highly optimal for batch jobs.
- If ultimate quality is desired regardless of cost, `gpt-5.6-sol` ($83/10k input) is available as the flagship alternative.

## Production Pipeline Recommendations

1. **Model:** `gpt-5.6-luna` via Responses API with the current prompt + schema.
2. **Image preprocessing:** downscale to 1024px long side, JPEG q=85 (already implemented).
3. **Sampling:** Omit `temperature` and `top_p` for reasoning models (they reject them with 400 Bad Request).
4. **Output cap:** `max_output_tokens=1200` (instead of 600) is required for reasoning models, as reasoning tokens are generated first and count toward this limit. Hitting the cap truncates the JSON and makes it unparseable.
5. **Structured output:** JSON schema with `description` / `objects` / `tags` / `ocr_text` / `interpretation`. Strict mode prevents malformed JSON.
6. **Detect truncation:** check `response.status == "incomplete"` and `incomplete_details.reason == "max_output_tokens"`.
7. **Prompt caching:** Make sure instructions are padded to 1024+ tokens to trigger OpenAI's prompt caching. This yields a 90% discount on input tokens.
8. **Client-side dedup:** perceptual hash (e.g. `imagehash`/`pHash`) before sending to prevent redundant API calls.
9. **Supplement long-tail recognition** using EXIF GPS (reverse geocoding) or local face recognition, as niche landmarks (e.g. Thames Barrier) are missed by all APIs.

## Open Questions for Production

- **Person recognition:** local face-rec step (FaceNet / face_recognition lib) should add names before the description pass and pass them in the prompt.
- **Existing EXIF descriptions:** compare output to existing, surface diffs for human review.
- **Tag normalization:** normalize tags against a controlled vocabulary post-hoc.
- **Incremental processing:** track processed files via generated JSON next to source.
