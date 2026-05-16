# Model Choice for Photo-Library Tagging

Analysis of OpenAI vision models for unsupervised bulk media-library tagging.
Pricing reflects cost to process 10,000 1024x1024 images via the Responses API
(input tokens only; output ~250 tokens adds a small constant).

## Excluded Models

| Model | Reason |
|-------|--------|
| `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | Audio transcription models; vision is incidental, not their job. |
| `gpt-5.3-codex` | Code-tuned variant; no advantage for image description. |
| `gpt-4o-mini` ($38/10k) | Strictly dominated by `gpt-5.4-mini` ($12/10k) — newer, cheaper, smarter. |
| `gpt-4.1-mini` ($102/10k) | Severely dominated; mini-tier priced like a flagship (patch-token math). |
| `gpt-4.1-nano` ($25/10k) | Dominated by `gpt-5.4-mini` ($12/10k). |
| `gpt-4.1` ($19/10k) | Tied with `gpt-4o` on price; no clear quality edge. |
| `gpt-5.4-pro`, `gpt-5.5-pro` ($498/10k) | 10–40x cost of flagship for marginal quality on this task. Overkill. |

## Pareto Frontier

| Tier        | Model            | 10k cost | When to choose                                    |
|-------------|------------------|----------|---------------------------------------------------|
| Floor       | `gpt-5.4-nano`   | $5       | Bulk tagging only; tolerates weak OCR/fine objects |
| Sweet spot  | `gpt-5.4-mini`   | $12      | Solid tagging + decent OCR — recommended default  |
| Baseline    | `gpt-4o`         | $19      | Known-quantity vision; useful as comparison ref   |
| Premium     | `gpt-5.4`        | $41      | Best non-pro; fine-grained scenes, strong OCR     |
| Flagship    | `gpt-5.5`        | $83      | Newest; marginal improvements over `gpt-5.4`      |

## Recommendation: `gpt-5.4-mini`

Reasoning for an unsupervised bulk update across thousands of photos:

- **Unsupervised = quality floor matters.** No human reviews each tag, so `nano`'s
  risk of bad tags you'll never catch outweighs its price advantage.
- **Patch-tokenized + 5.x-mini tier** roughly matches `gpt-4o` quality at ~⅔ the
  cost.
- **Scale economics.** $12 per 10k means a 100k-photo library = ~$120. One-shot
  pass, acceptable.
- **Flex/batch pricing** would halve this further (~$6/10k) if a one-shot run.

## Validation Before Committing

Spot-check 50–100 representative photos across three candidates before locking
in a model:

- `gpt-5.4-nano` (~$0.05)
- `gpt-5.4-mini` (~$0.12)
- `gpt-5.4` (~$0.41)

Total spike test: under $1. Compare on:

- **Tag specificity** — does "person" become "child-portrait" / "candid"?
- **OCR accuracy** on photos with signs, captions, documents
- **False-positive rate** on blurry, abstract, or low-content images
- **Tag consistency** across visually similar images

If `nano` holds up, save 60%. If `mini`→`5.4` gap is wide, bump up. Pick from
data, not from a price table.

## Cost Levers Beyond Model Choice

- **Batch API:** 50% off, relevant for one-shot bulk runs.
- **Prompt caching:** with `SYSTEM_INSTRUCTIONS` stable across 100k calls,
  cached input drops to ~$0.075/M for `gpt-5.4-mini` — input cost drops ~10x.
- **Client-side dedup:** perceptual hash before sending; bursts of near-identical
  photos (camera bursts, screenshots) waste API calls.
- **Client-side downscale** (already implemented): 1024px long side, JPEG q=85.
