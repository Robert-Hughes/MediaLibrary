# Model Choice for Photo-Library Tagging

Final analysis of vision models for unsupervised bulk media-library tagging,
informed by a side-by-side run of five candidates on a 21-photo test set
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

## Pareto Frontier

| Tier       | Model          | 10k cost | When to choose                                     |
| ---------- | -------------- | -------- | -------------------------------------------------- |
| Floor      | `gpt-5.4-nano` | $5       | Bulk tagging only; tolerates weak OCR/fine objects |
| Sweet spot | `gpt-5.4-mini` | $12      | Solid OCR + cleaner descriptions than nano         |
| Baseline   | `gpt-4o`       | $19      | **Recommended** — names London landmarks reliably  |
| Premium    | `gpt-5.4`      | $41      | Slightly better prose; marginal landmark gain      |
| Flagship   | `gpt-5.5`      | $83      | Newest; not tested — assume similar to `gpt-5.4`   |

## Test Set Results

A 21-photo set covering wide content types (see `TEST_SET.md`). Most carry
existing EXIF descriptions as soft ground truth. Key axis evaluated:
**landmark/place recognition**, since for an unsupervised tagger that's the
difference between "ferris wheel" and "London Eye" in search results.

### Landmark Recognition Scoreboard

✅ = named correctly; ⚠️ = partial / better than generic but no name; ❌ = generic only

| Photo                                 | nano           | mini                 | gpt-4o                        | gpt-5.4         | opus-4.7 (chat)                                                        |
| ------------------------------------- | -------------- | -------------------- | ----------------------------- | --------------- | ---------------------------------------------------------------------- |
| 0036 St Pancras Renaissance Hotel     | ❌             | ❌                   | ✅                            | ✅              | ✅ (+ "former Midland Grand Hotel")                                    |
| 0042 The Meeting Place statue         | ❌             | ❌                   | ✅                            | ✅              | ✅ (+ named sculptor "Paul Day")                                       |
| 0066 Westminster Bridge / County Hall | ❌             | ❌                   | ✅                            | ✅              | ✅ (+ "green copper-domed kiosk")                                      |
| 0125 London Eye                       | ❌             | ✅                   | ✅                            | ✅              | ✅                                                                     |
| 0514 Tower of London                  | ❌             | ❌                   | ✅                            | ✅              | ✅                                                                     |
| 0136 Hungerford + Golden Jubilee Br   | ❌             | ❌                   | ✅                            | ✅              | ✅ (+ noted "from inside a London Eye capsule")                        |
| 0028 St Pancras Station interior      | ❌             | ❌                   | ❌                            | ❌              | ⚠️ (named "King's Cross" + read "EAST COAST" off train)                |
| 0322 Forth Bridge model (Sci. Museum) | ❌             | ❌                   | ⚠️                            | ❌              | ✅ (Forth Bridge + Science Museum)                                     |
| 0381 Queen's House / Greenwich Power  | ❌             | ❌                   | ✅                            | ❌ (regression) | ✅✅ (+ Old Royal Naval College, Greenwich Power Station)              |
| 0381 Greenwich Park                   | ❌             | ❌                   | ✅                            | ❌              | ✅                                                                     |
| 0581 Scroby Sands Wind Farm           | ❌             | ❌                   | ❌                            | ❌              | ⚠️ (named "offshore wind farm" + UK seaside context)                   |
| 0501 Thames Barrier                   | ❌             | ❌                   | ❌                            | ❌              | ❌ (all models missed this)                                            |
| 0686 Punting (Cambridge)              | ❌             | ✅ (with prompt fix) | ✅                            | ✅              | n/a                                                                    |
| 0047 London Underground map           | ❌ partial OCR | ✅                   | ✅                            | ✅              | ✅ (named "King's Cross St Pancras")                                   |
| Samsung Browser screenshot            | n/a            | truncated            | ✅ ("digital page", full OCR) | n/a             | ✅ (named "Issuu document viewer", page indicator, related thumbnails) |

### Observations

- **nano consistently generic-outs.** Vision is right (sees a wheel, sees a
  fortress) but never names the landmark, even after a prompt change explicitly
  encouraging it. This is a capability ceiling, not a prompt problem.
- **mini gains modest ground.** With the prompt-fix run, mini named London Eye
  and "punting" — the _globally iconic_ items. Narrower London landmarks
  (Westminster Bridge, Tower of London, St Pancras) still generic.
- **gpt-4o is the inflection point.** Confidently names St Pancras, Tower of
  London, Westminster Bridge, County Hall, Queen's House, Greenwich Park,
  Hungerford & Golden Jubilee Bridges, etc. Most London landmarks correctly
  identified. Mild "The image captures..." preamble leak.
- **gpt-5.4 is a marginal step.** Slightly cleaner prose (no preamble leak),
  uses `observation-wheel` over `ferris-wheel`, better composition language.
  But also **regressed on Queen's House** (4o named it, 5.4 didn't), so the
  ~2x cost over 4o doesn't reliably buy more recognition.
- **opus-4.7 is best-in-class** but via chat-agent interface (not Responses
  API), so cost / throughput is fundamentally different. Names extra detail
  no OpenAI model produced: sculptor name, Old Royal Naval College, Forth
  Bridge specifically, Issuu viewer for the screenshot. May have been helped
  by filename/path context (`/2010/`, `/2026/`).
- **Thames Barrier was missed by every model**, despite its visually
  unmistakable crisscross piers. Edge of the recognition long-tail.
- **Forth Bridge model only opus got right** — meta-scenes (model-of-a-thing)
  are uniquely hard.
- **Prompt change was necessary** for any landmark naming beyond globally
  iconic items. Going from "literal factual description, no speculation" to
  explicitly permitting confident landmark naming + separating speculation
  into an `interpretation` field is what unlocked mini's London Eye / punting
  wins.

### Cost vs Quality Curve

For the test set (21 images), actual cost ranged roughly:

- `gpt-5.4-nano`: $0.011 — generic descriptions, weak landmarks
- `gpt-5.4-mini`: $0.026 — clean prose, only globally iconic landmarks
- `gpt-4o`: $0.040 — most London landmarks named, minor preamble leak
- `gpt-5.4`: $0.083 — slight prose improvement, regression risk on long-tail

The gpt-4o → gpt-5.4 step doubles cost for a marginal-and-uneven prose gain.
The mini → gpt-4o step costs ~60% more but **fundamentally changes what gets
named** — that's the real value step.

## Recommendation for Production: `gpt-4o`

**Switch the previous recommendation from `gpt-5.4-mini` to `gpt-4o`** based
on the actual test results.

Reasoning:

- For a personal media library, "London Eye" beats "ferris wheel". The whole
  point is searchability — generic tags don't satisfy "show me my Tower of
  London photos."
- gpt-4o ($19/10k) names landmarks reliably; mini ($12/10k) doesn't. The 60%
  premium buys the feature you actually want.
- gpt-5.4 (2x cost of 4o) and gpt-5.5 (4x) don't reliably add quality and
  sometimes regress. Not worth it for unsupervised bulk.
- 100k-photo library ≈ $190 one-shot at gpt-4o. $95 with Batch API.

If price-capped tightly: `gpt-5.4-mini` at $120 for 100k images is still a
reasonable fallback — output is internally consistent, just narrower on
specifics.

## Production Pipeline Recommendations

1. **Model:** `gpt-4o` via Responses API with the current prompt + schema.
2. **Image preprocessing:** downscale to 1024px long side, JPEG q=85 (already
   implemented).
3. **Sampling:** `temperature=0`, `top_p=1`. No `seed` (rejected by Responses
   API). Outputs are stable-enough across reruns.
4. **Output cap:** `max_output_tokens=600` covers typical photos with
   headroom; raise to ~1500 if processing many text-heavy screenshots /
   document scans (which can truncate at 600).
5. **Structured output:** JSON schema with `description` / `objects` / `tags`
   / `ocr_text` / `interpretation`. Strict mode prevents malformed JSON.
6. **Detect truncation:** check `response.status == "incomplete"` and
   `incomplete_details.reason == "max_output_tokens"` — these come back with
   unparseable JSON, must be retried, not repaired.
7. **Batch API for cost:** if running the library in one shot (not
   incrementally over time), batch endpoint = 50% off. Trade: results arrive
   asynchronously within 24h.
8. **Skip prompt caching for gpt-4o.** Cached input is only 50% off (not the
   ~90% you get on 5.x), and our stable prefix (~500 tokens) is below the
   1024-token cache minimum anyway. Padding instructions to 1024+ tokens
   would _increase_ total cost on gpt-4o. (Caching becomes a clear win only
   if switching to a 5.x model for production bulk.)
9. **Client-side dedup:** perceptual hash (e.g. `imagehash`/`pHash`) before
   sending. Bursts of near-identical shots (camera bursts, multiple takes,
   screenshots taken in sequence) waste API calls; pick the sharpest of each
   cluster.
10. **Don't expect long-tail landmark recognition.** Thames Barrier, regional
    UK landmarks, niche sculptures — gpt-4o (and even 5.4) will generic-out.
    If these matter, supplement with:
    - **EXIF GPS** → reverse geocode to nearest landmark, inject as a hint
      in the prompt
    - **Local face recognition** for person identification (privacy: never
      send faces to an API for identification)
    - **Specialist place-recognition models** for outdoor scenes if needed
11. **Persist API failures.** Write an error stub to the output file on
    failure rather than leaving stale results in place. (Already
    implemented — `process_image` writes `{"error": ..., "detail": ...}` on
    failures.)
12. **Track actual vs predicted cost.** The tool already logs per-image and
    aggregate usage stats; review the delta on the first ~50 production
    images and tune `EXPECTED_OUTPUT_TOKENS` if predictions drift.

## Open Questions for Production

- **Person recognition:** the photo library has recurring people ("Petia",
  "Me") tagged in EXIF. Vision models can't bridge appearance ↔ name
  without per-person training data. Likely needs a local face-rec step
  (FaceNet / face_recognition lib) that adds person tags before the
  description pass — and those names should be passed _into_ the prompt so
  the model can naturally weave them in.
- **Existing EXIF descriptions:** the test set already has descriptions; for
  production, decide whether to (a) ignore EXIF and overwrite, (b) skip
  files with descriptions, (c) compare and merge. Probably (c) — compare
  output to existing, surface diffs for human review.
- **Tag normalization:** different runs produce variant tags
  (`london-eye` vs `londoneye` vs `ferris-wheel`). For a searchable library,
  normalize against a controlled vocabulary post-hoc.
- **Long-tail landmark fine-tuning:** if Thames Barrier / regional UK
  landmarks matter, building a small reference image set + retrieval
  pipeline (RAG-style "image looks like this known landmark") is cheaper
  than fine-tuning a vision model.
- **Incremental processing:** library grows over time. Tag files as
  processed (e.g. presence of `<stem> (<model>).json` next to source); skip
  on subsequent runs unless model or prompt changes.
