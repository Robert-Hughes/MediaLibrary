# Description metadata-context results (GPT-6 Luna)

The agreed package **did not improve overall identification** in this targeted
paired test. Keep it experimental.

Forty images (20 failures and 20 controls) ran twice per arm: 160 fresh calls,
all requested and returned as **gpt-6-luna**. No other models or paid judges.
Both arms used identical production v2 instructions, image bytes, schema and
request parameters. The context arm added a labelled text block containing:
full file path, existing structured `LocationCreated`, and original EXIF capture
fields with existing offsets/subseconds. No captions, AI tags or reference labels.
Order was counterbalanced. All source files remained unchanged.

| Reviewed measure                                          | Image only | With context |
| --------------------------------------------------------- | ---------: | -----------: |
| Incorrect identity/classification or false index identity |       4/80 |         6/80 |
| Supported specific identification in prose                |      36/80 |        35/80 |
| Supported specific identification on controls             |      26/40 |        24/40 |
| Supported generic description                             |      39/80 |        37/80 |
| Provisional replacement identity                          |       1/80 |         2/80 |
| Salient subject retained                                  |      80/80 |        80/80 |
| Major unsupported extra details, separate                 |       1/80 |         0/80 |
| Case-level outcome varied between repeats                 |       3/40 |         5/40 |
| Structured-output errors                                  |       0/80 |         0/80 |
| Usage-based cost, USD                                     | $0.0193211 |   $0.0198341 |

Total usage-based cost: **$0.0391552**. Both arms had zero cache reads/writes.
These are repeated output counts, not a whole-library error-rate estimate or a
statistically established difference.

Context repaired the spiral staircase twice and named the tabby cat twice. It
retained punting twice, versus once, and named the London Eye once. A correct
Ely Cathedral tag appeared once without specific naming in the prose.

However, context called the two lemurs monkeys twice, inserted sheep into one
alpaca output's objects/tags, and called the night animal a rabbit once. The
latter's LocationName is Hat & Rabbit, a plausible anchoring clue whose causal
role is not established by this test. Context also lost some correct Windsor
Castle, raccoon, wallaby and font naming. Neither arm repaired the circular
grille/window error or named Curfew Tower. Many supplied places remained unused.

The reference for IMG_1972 was corrected to the Wellington Monument from an
incorrect high-altar label after full-resolution review and checks against
[St Paul's material](https://www.stpauls.co.uk/east-india-company-st-pauls) and
[Historic England's bronze-sarcophagus record](https://historicengland.org.uk/images-books/photos/item/MD49/00394).
Generic funerary-monument/sarcophagus wording is supported. The correction was
applied equally to both arms and the previous experiment, whose identity totals
are now 17/80 (v1) and 4/80 (v2). Raw responses/manifests/screens and the prior
review are retained. No extra calls or media edits were required.

Final grading is complete Codex visual review, not independent human or blinded
grading. It covers primary identity/location, indexed false claims and major
contradictory details, not every adjective or OCR character. Provisional animal
identities do not count as confirmed recognition. Regex screens are only aids;
a regression test now catches new monkey substitutions.

A next test should isolate full-file-path and LocationCreated effects before
altering the context prompt. This combined package cannot identify which input
caused a gain or failure. No additional paid test or production context change
has been made.

The durable full report and all private evidence are under
`Update Metadata Scripts/description-context-eval-20261013/`.
