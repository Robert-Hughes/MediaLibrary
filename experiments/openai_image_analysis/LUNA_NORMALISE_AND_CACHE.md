# Luna normalisation and cache policy

## Recommendation

Use `gpt-6-luna` as the default and recommended model for metadata description normalisation and title generation, with `reasoning.effort` explicitly set to `none`.

The original 12-photo cross-year experiment established the Luna capability tier: GPT-5.6 Luna with no reasoning beat the then-current nano-derived values on 8 of 12 descriptions and 10 of 12 titles, with one title tie. Omitted/default reasoning also produced a title truncation because hidden reasoning consumed part of the short output budget.

After GPT-6 launched, the same 12 cases were rerun with GPT-6 Luna and the same blind GPT-5.6 Sol judge. GPT-6 Luna won 7 of 12 descriptions and 10 of 12 titles against the current stored values. That is effectively the same quality tier rather than a quality upgrade, while its token pricing is materially lower. The 12-case generation run used 8,009 input tokens and 960 output tokens and cost about $0.00128.

Current standard API prices used by the harness and production estimator are:

| Model        | Input / 1M | Cached read / 1M | Cache write / 1M | Output / 1M |
| ------------ | ---------: | ---------------: | ---------------: | ----------: |
| GPT-6 Luna   |      $0.10 |            $0.01 |           $0.125 |       $0.50 |
| GPT-5.6 Luna |      $0.20 |            $0.02 |            $0.25 |       $1.20 |

The choice of GPT-6 Luna is therefore cost-led: the rerun found no material loss in normalisation quality, but standard input is half the price and output is less than half the price.

## Image-description cache finding

Production logs previously showed 12,247,527 GPT-5.6 Luna input tokens, but only 36,378 cache-read tokens (0.30%) and 10,805,611 cache-write tokens (88.23%). The apparent high hit rate was actually dominated by cache writes.

Controlled tests using the exact production request builder showed that implicit mode writes almost the whole first unique image request and only benefits an exact repeat. MediaLibrary normally describes each image once, so this is the wrong trade-off.

Production therefore sets modern GPT-5.6/GPT-6 prompt caching to explicit mode without an explicit breakpoint for this unique-photo workload. The stable instructions and schema are below the cache minimum, so adding a breakpoint would currently provide no useful reuse. This seemingly unusual combination is deliberate and should not be changed back to implicit mode without new measurements.

## Limitations

The normalisation corpus is representative rather than exhaustive, and the judge is another model. Human-authored identity details were excluded because the experiment evaluated AI-generated normalisation quality rather than preservation of private identity knowledge. Future prompt or model changes should rerun the corpus.
