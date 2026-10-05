# Model Choice for Photo-Library Tagging

Current analysis of OpenAI vision models for unsupervised bulk media-library tagging.
The October 2026 refresh reran the production image-description prompt against a
24-case corpus: the original 20-photo 2010 set, three known false-animal
regressions from `TODO.md`, and a current Google Maps screenshot. All five
models completed all 24 requests with valid structured output (120/120 total).

Pricing below is standard Responses API pricing as of 2026-10-05. Batch and
Flex are 50% cheaper where supported. Image inputs are billed as input tokens.

## Current pricing

| Model          | Input / 1M | Cached read / 1M | Cache write / 1M | Output / 1M | October benchmark role                         |
| -------------- | ---------: | ---------------: | ---------------: | ----------: | ---------------------------------------------- |
| `gpt-6-luna`   |      $0.10 |            $0.01 |           $0.125 |       $0.50 | New bulk/default candidate                     |
| `gpt-5.6-luna` |      $0.20 |            $0.02 |            $0.25 |       $1.20 | Previous default/control                       |
| `gpt-6-sol`    |      $2.00 |            $0.20 |            $2.50 |      $10.00 | GPT-6 Sol comparison                           |
| `gpt-6.1-sol`  |      $2.00 |            $0.10 |            $2.50 |      $10.00 | New quality/cost candidate                     |
| `gpt-6-astra`  |     $10.00 |            $1.00 |           $12.50 |      $50.00 | Maximum-quality reference                      |
| `gpt-5.6-sol`  |      $4.00 |            $0.40 |            $5.00 |      $20.00 | Historical flagship; current promotional price |
| `gpt-5.4-mini` |      $0.75 |           $0.075 |            $0.75 |       $4.50 | Historical inexpensive tier                    |
| `gpt-4o`       |      $2.50 |            $1.25 |            $2.50 |      $10.00 | Historical vision baseline                     |

`gpt-5.4-nano` was deprecated on 2026-10-01 and is intentionally no longer a
supported Media Library model. OpenAI recommends `gpt-6-luna` as its
replacement.

## October 2026 benchmark cost

The five fresh runs used the same 24 images and the production prompt/schema.
No prompt-cache reads or writes occurred, which is expected for unique-photo
workloads with the explicit no-breakpoint policy.

| Model          | Input tokens | Output tokens | Reasoning tokens | Actual 24-image cost | Extrapolated / 10k | Batch/Flex / 10k* |
| -------------- | -----------: | ------------: | ---------------: | -------------------: | -----------------: | ----------------: |
| `gpt-6-luna`   |       36,068 |         4,637 |              922 |        **$0.005925** |          **$2.47** |         **$1.23** |
| `gpt-5.6-luna` |       36,068 |         5,108 |            1,256 |            $0.013343 |              $5.56 |             $2.78 |
| `gpt-6-sol`    |       36,068 |         3,918 |              667 |            $0.111316 |             $46.38 |            $23.19 |
| `gpt-6.1-sol`  |       36,068 |         4,832 |              276 |            $0.120456 |             $50.19 |            $25.10 |
| `gpt-6-astra`  |       36,068 |         4,924 |              233 |            $0.606880 |            $252.87 |           $126.43 |

\*Simple 50% extrapolation from this token profile. Actual cost depends on the
images and generated output.

GPT-6 Luna was about **56% cheaper than GPT-5.6 Luna** on the measured corpus.

## Visual recognition results

For landmark scoring, an exact hit means the output named the intended landmark,
not merely the object category or city. These ten cases are deliberately hard
and should not be treated as a general-purpose accuracy percentage.

| Recognition case                        | 5.6 Luna             | 6 Luna                         | 6 Sol                                             | 6.1 Sol         | Astra               |
| --------------------------------------- | -------------------- | ------------------------------ | ------------------------------------------------- | --------------- | ------------------- |
| St Pancras Renaissance Hotel            | ✅                   | ✅                             | ✅                                                | ✅              | ✅                  |
| Westminster Bridge                      | ✅                   | ✅                             | ✅                                                | ✅              | ✅                  |
| London Eye                              | ✅                   | ✅                             | ✅                                                | ✅              | ✅                  |
| The Meeting Place                       | ✅                   | ✅                             | ✅                                                | ✅              | ✅                  |
| Tower of London                         | ✅                   | ✅                             | ✅                                                | ✅              | ✅                  |
| Hungerford + Golden Jubilee Bridges     | ❌ generic           | ✅                             | ✅                                                | ✅              | ✅                  |
| Queen's House + Greenwich Power Station | ❌ generic           | ❌ **Battersea hallucination** | ⚠️ Greenwich/Power Station, wrong museum building | ✅              | ✅                  |
| Forth Bridge model in Science Museum    | ❌ generic           | ⚠️ bridge model                | ⚠️ bridge model                                   | ⚠️ bridge model | ✅ **Forth Bridge** |
| Scroby Sands Wind Farm                  | ❌ generic wind farm | ❌                             | ❌                                                | ❌              | ❌                  |
| Thames Barrier behind selfie            | ❌ generic bridge    | ❌                             | ❌                                                | ❌              | ❌                  |
| **Exact landmark hits / 10**            | **5**                | **6**                          | **6**                                             | **7**           | **8**               |

Additional observations:

- **GPT-6 Luna** gained the Hungerford/Golden Jubilee identification at a
  fraction of 5.6 Luna's price, but made a confident Battersea Power Station
  hallucination on the Greenwich Park image.
- **GPT-6.1 Sol** correctly named the Queen's House and Greenwich Power Station
  and was the best non-Astra landmark model in this run.
- **GPT-6 Astra** was the only fresh model to identify the Forth Bridge model
  by name. It still missed both Scroby Sands and the Thames Barrier.
- On the difficult station-interior image, 5.6 Luna confidently called the
  station Paddington. GPT-6 Luna/Sol/6.1 stayed generic rather than inventing a
  station; Astra named King's Cross. The existing metadata itself mixes
  King's Cross and St Pancras wording, so this case is excluded from the exact
  landmark score.
- All models handled the London Underground map and current Google Maps
  screenshot well. 6.1 Sol and Astra were strongest at recovering specific
  station/map context and interpreting the red map annotation.

### Known false-animal regressions

These cases were added because existing generated metadata contained a known
wrong animal label. The score below asks only whether the model avoided that
specific known wrong label; it does not assume the replacement species is
necessarily correct.

| Regression                         | 5.6 Luna    | 6 Luna    | 6 Sol       | 6.1 Sol   | Astra     |
| ---------------------------------- | ----------- | --------- | ----------- | --------- | --------- |
| Known **not kangaroo** case        | ✅ sheep    | ✅ alpaca | ✅ alpaca   | ✅ alpaca | ✅ alpaca |
| Known **not fox** case             | ✅ bird     | ✅ bird   | ❌ fox      | ❌ fox    | ❌ fox    |
| Known **not rabbit** case          | ✅ hedgehog | ❌ rabbit | ✅ hedgehog | ❌ rabbit | ❌ rabbit |
| **Known wrong labels avoided / 3** | **3**       | **2**     | **2**       | **1**     | **1**     |

This is important: the quality tiers are **not monotonic for hallucination
avoidance**. Astra and 6.1 Sol improve long-tail landmark naming but were more
willing to make confident false animal identifications on this small adversarial
set.

## Pareto recommendations

### Bulk/default: `gpt-6-luna`

Use GPT-6 Luna for routine whole-library analysis.

- Lowest measured and list-price cost by a large margin.
- Improved exact landmark recognition from 5/10 to 6/10 versus 5.6 Luna.
- Strong OCR and structured-output reliability.
- One serious landmark hallucination and one known false-animal regression mean
  its output should still be treated as generated metadata, not ground truth.

This is the production default after the October 2026 refresh.

### Conservative fallback: `gpt-5.6-luna`

5.6 Luna is no longer the cost/landmark winner, but it remains useful as a
comparison/fallback because it avoided all three known false-animal labels in
this run. It is about 2.25x the measured cost of GPT-6 Luna and had fewer exact
landmark hits.

### Landmark-sensitive premium: `gpt-6.1-sol`

Use 6.1 Sol when identifying specific places/structures matters enough to pay
roughly 20x GPT-6 Luna's measured cost.

- 7/10 exact landmark hits.
- Correctly resolved the difficult Greenwich Park scene.
- Better cached-input price than GPT-6 Sol at the same standard input/output
  rates.
- Poorer performance on the false-animal regression set (1/3 avoided).

### Maximum landmark quality: `gpt-6-astra`

Use Astra only for selected hard cases where a long-tail landmark name is worth
a large premium.

- Best landmark score, 8/10.
- Only fresh model to identify the Forth Bridge model by name.
- Roughly 5x the measured cost of 6.1 Sol and over 100x GPT-6 Luna.
- Did **not** solve Scroby Sands or Thames Barrier and was not safer on the
  animal regressions.

### Not on the current frontier

- **GPT-6 Sol:** same standard input/output pricing as 6.1 Sol, worse cached
  input pricing, and lower landmark quality in this corpus. Its shorter answers
  made this particular run slightly cheaper, but that is not a durable pricing
  advantage.
- **GPT-5.4 mini / GPT-4o:** retained as non-deprecated historical options, but
  earlier testing put them behind the current frontier and they were not worth
  re-running for this refresh.
- **GPT-5.6 Sol:** retained as a historical supported option. Its old run
  uniquely identified Scroby Sands, but current GPT-6-family results and its
  much higher price mean it is no longer the general premium recommendation.

## Production request policy

1. **Default model:** `gpt-6-luna`.
2. **Image preprocessing:** downscale to 1024 px long side, JPEG q=85.
3. **Structured output:** strict JSON schema with description, interpretation,
   objects, tags, and OCR text.
4. **Reasoning:** image description uses low reasoning effort. Short text-only
   normalisation can use `none` on models that support it; 6.1 Sol and Astra
   require at least `low`.
5. **Sampling:** omit legacy `temperature` / `top_p` on GPT-5.6 and GPT-6
   reasoning-model families.
6. **Output cap:** 1,200 tokens so hidden reasoning cannot crowd out the
   structured answer.
7. **Prompt caching:** use explicit mode with no breakpoint for unique-photo
   workloads. The reusable prefix is below the cache minimum, so implicit
   caching would mostly charge cache writes on changing image content.
8. **Cost preflight:** `/responses/input_tokens` must omit request fields that
   endpoint does not accept, such as `service_tier`.
9. **Long-tail recognition:** use metadata/GPS context or selective premium
   reruns rather than assuming a more expensive model will solve every landmark.
