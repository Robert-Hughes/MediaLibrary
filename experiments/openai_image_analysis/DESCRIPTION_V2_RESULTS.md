# Description v1/v2 comparison on GPT-6 Luna

Measured on 13 October 2026. V2 reduced incorrect identities on this targeted
corpus, with a trade-off in useful specificity. The evaluation compared v2
against production v1. The exact evaluated v2 prompt has since been
promoted to production with `AIPromptVersion=v2`; existing metadata is unchanged.

## Experiment

- 40 photographs: 20 known failure cases and 20 controls.
- V1 and v2 each ran twice per image: 160 generation requests, 80 outputs per
  prompt. Both requested and returned model were `gpt-6-luna` for every call.
- No other models, fallback models, or paid API judges.
- Same production EXIF orientation, 1024-pixel resizing and JPEG quality 85;
  identical encoded image bytes for each pair, with counterbalanced prompt order.
- Same schema, low reasoning, output budget and cache policy. Only instructions
  changed. No metadata context or expected answers entered the requests.
- All 160 outputs were structurally valid. Original photo hashes, sizes and
  modification times were unchanged.

## Reviewed output counts

These are counts of outputs, not distinct photographs. Each prompt has two
attempts on each image; repeats are not independent whole-library samples.

| Measure                                                           |         V1 |         V2 |
| ----------------------------------------------------------------- | ---------: | ---------: |
| Incorrect identities/classifications, including false index terms |    17 / 80 |     4 / 80 |
| Incorrect on known-failure cases                                  |    15 / 40 |     3 / 40 |
| Incorrect on controls                                             |     2 / 40 |     1 / 40 |
| Supported specific identification on controls                     |    31 / 40 |    24 / 40 |
| Supported specific identification overall                         |    44 / 80 |    34 / 80 |
| Useful generic description overall                                |    18 / 80 |    40 / 80 |
| Provisional replacement identity                                  |     1 / 80 |     2 / 80 |
| Salient subject retained                                          |    80 / 80 |    80 / 80 |
| Major unsupported extra details, counted separately               |     2 / 80 |     4 / 80 |
| Identity outcome changed between repeats                          |    12 / 40 |     5 / 40 |
| Structured-output failures                                        |     0 / 80 |     0 / 80 |
| Usage-based cost, USD                                             | $0.0204566 | $0.0196656 |

Total cost was **$0.0401222**, calculated from recorded token usage and production
pricing. Neither prompt used cache reads/writes. This is not an invoice audit.

The final identity categories specific/generic/incorrect/provisional sum to 80
for each prompt. A wrong identity can retain the photographed subject, so
subject coverage does not excuse that error. Generic descriptions are distinct
from exact recognition, and the two tentative animal references cannot inflate
confirmed-specific accuracy.

## What changed

V2 avoided several invented cathedral/city names and used supported broader
descriptions. It kept lemur in both attempts where v1 changed to red panda in
one. It favored cat for the known-not-fox road animal, but that replacement is
still provisional.

The gains are not universal. V2 described the night animal generically once and
called it a bird the second time. Both prompts still called the iron grille a
stained-glass window. That wrong replacement identity fails the new scoring
even though the original clock label was avoided.

V2 lost London Eye and wallaby names on both control attempts, used deer rather
than muntjac, and lost punting on one attempt. Its generic Curfew Tower shape
description is valid, but `round-tower` remains an ambiguous search tag rather
than a successful Curfew Tower identification. V2 also made a new rodent error
on a raccoon control. V1 made new Waterloo Bridge and taxidermy errors.

## Scoring and reference corrections

See [DESCRIPTION_EVALUATION.md](DESCRIPTION_EVALUATION.md) for the revised rubric
and [README.md](README.md#paired-description-prompt-evaluation) for the runner.
Automatic regex scores are only screening aids. Final scores require explicit
review annotations for every case/prompt/repetition, with explanations and
separate index/detail checks. Review catches new wrong names not on a blacklist
and corrects false negatives for valid broad descriptions.

The initial control label for one close-up was copied as capybara from existing
AI metadata. Closer image/morphology review identified a Patagonian mara,
consistent with the [Smithsonian physical description](https://nationalzoo.si.edu/animals/patagonian-mara).
The correction was applied to both prompts without new requests. The original
run manifest is retained in private evidence; the committed future manifest
uses `c03_mara`. No generated answer alone was treated as ground truth.

A later reference correction identified IMG_1972 as the Wellington Monument,
not the high altar. The full image shows its reclining effigy and equestrian
statue; see [St Paul's monument material](https://www.stpauls.co.uk/east-india-company-st-pauls)
and [Historic England's bronze-sarcophagus record](https://historicengland.org.uk/images-books/photos/item/MD49/00394).
Generic funerary-monument/sarcophagus descriptions are therefore supported.
V1's invented French names remain incorrect; v2's two bronze-as-dark-stone
claims are separate material-detail errors. Updated reviewed scores reduce v2's
identity errors from six to four and increase its generic results from 38 to 40.
The original raw responses, corpus and pre-correction review are preserved.

The final review was performed by Codex against the photographs and truth notes,
not an independent human or a blinded paid-model judge. It focuses on primary
identity/location and major contradictory details, not exhaustive verification
of every adjective, inferred age, relationship, material or OCR character.

Future screening rules were calibrated to avoid misclassifying valid
camelid/marsupial/rodent categories, shape descriptions, domed interiors,
office towers and transit route information. Frozen raw automatic scores were
not silently replaced. Complete reviewed results and rationales are available
in the private run artifacts.

## Recommendation

V2 is the better candidate when avoiding false indexing matters more than
retaining every possible specific name. It is not a complete factual-repair
mechanism and should not justify blindly regenerating the collection. Existing
caption/title/keyword mistakes still need explicit repair. The context,
detail/crop review and protected human corrections proposed in the audit remain
useful. The production promotion uses the exact tested text and bumps the prompt
version to v2. The harness preserves a frozen v1 baseline for future comparisons.
Additional metadata context was evaluated separately; see
[the context experiment](DESCRIPTION_CONTEXT_RESULTS.md). It remains experimental.

## Validation

- Harness Rust tests: 16 passed.
- Offline scorer tests: five passed.
- `npm run check`: passed, including 1,415 frontend tests and production build.
- App Rust default tests: 927 passed, one ignored, plus six batch/scan tests.
- App Rust formatting and strict all-target/all-feature Clippy: passed.
- Harness formatting and Clippy: passed with the pre-existing
  `too_many_arguments` lint excluded for the legacy functions; all other
  warnings remain errors. Strict harness Clippy still reports those two
  pre-existing argument-count warnings.
- ExifTool integration was not rerun: only the experiment harness/docs changed,
  with no production pipeline changes.

Private raw outputs, resized input images, review annotations, cost/usage and
hash verification are stored under
`Update Metadata Scripts/description-prompt-eval-20261013/`. They are deliberately
not committed with the source.
