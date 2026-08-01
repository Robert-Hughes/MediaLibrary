# Luna normalisation and GPT-5.6 cache policy

## Recommendation

Use `gpt-5.6-luna` as the default and recommended model for metadata description normalisation and title generation, with `reasoning.effort` explicitly set to `none`.

A 12-photo cross-year corpus compared Luna at omitted/default, low, and none reasoning against the currently stored nano-derived values. A blind image-aware Sol judge preferred Luna-with-none for 8 of 12 descriptions and 10 of 12 titles, with one title tie. All 24 calls succeeded. Omitted/default reasoning produced a title truncation because hidden reasoning consumed part of the 30-token output budget. Full raw results are in `NORMALISE_LUNA_RESULTS.jsonl`.

Current API prices used by the harness and production estimator are:

| Model | Input / 1M | Cached read / 1M | Cache write / 1M | Output / 1M |
|---|---:|---:|---:|---:|
| GPT-5.6 Luna | $0.20 | $0.02 | $0.25 | $1.20 |
| GPT-5.6 Terra | $2.00 | $0.20 | $2.50 | $12.00 |

## Image-description cache finding

Production logs showed 12,247,527 Luna input tokens, but only 36,378 cache-read tokens (0.30%) and 10,805,611 cache-write tokens (88.23%). The previous apparent high hit rate was actually dominated by cache writes.

Controlled tests using the exact production request builder showed that implicit mode writes almost the whole first unique image request and only benefits an exact repeat. MediaLibrary normally describes each image once, so this is the wrong trade-off.

Production therefore sets `prompt_cache_options.mode` to `explicit` for GPT-5.6 while intentionally inserting no breakpoint. Explicit mode disables GPT-5.6's implicit breakpoint at the changing image message. The stable instructions and schema are below the 1,024-token cache minimum, so an explicit breakpoint would currently provide no cache reuse. This seemingly unusual combination is deliberate and must not be “simplified” back to implicit mode without new measurements.

## Limitations

The normalisation corpus is representative rather than exhaustive, and the judge is another model. Human-authored identity details were excluded because the experiment evaluated AI-generated normalisation quality rather than preservation of private identity knowledge. Future prompt or model changes should rerun the corpus.
