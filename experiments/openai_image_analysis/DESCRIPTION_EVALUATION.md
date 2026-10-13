# Description prompt evaluation

The versioned `description-corpus.json` contains 40 local-library photos:
20 regressions and 20 controls. Images and raw model outputs are private local
artifacts and are not committed. Each case declares a relative filename,
ground-truth summary, exact/generic acceptance expressions, contradictions and
whether replacement identity remains provisional.

Regressions cover the reported alpaca/road-animal/night-animal errors, Curfew
Tower, four more cats, lemurs, St Paul's dome/nave/altar/stairs/grille, wrong
London city names, Ely Cathedral, Birmingham New Street, York's observation
wheel and Canary Wharf. Controls include genuine wallaby/otter/lemur/
red-panda/rabbit/squirrel/raccoon/deer/mara images, actual Round Tower, St Paul's,
The Shard, London Eye, Westminster Bridge, St Pancras, Tower Bridge, a transit
map, punting, a portrait and motion blur.

The small road animal and night animal are known not to be fox/rabbit, but their
replacement identities (cat/hedgehog) remain provisional. Specific guesses on
those two cases are not counted as confirmed recognition accuracy.

## Experimental controls

- Only `gpt-6-luna` is permitted. No fallback or paid judge requests.
- Two prompts, two repetitions per image, 160 generation requests in total.
- Same production EXIF orientation, 1024-pixel cap, JPEG quality 85 and encoded
  bytes for both prompts. No resolution/detail/model/context changes.
- Prompt order is counterbalanced across cases and repetitions.
- The expected answers, filenames, album and GPS are never supplied to the API.
- Production prompt and photo metadata remain unchanged.
- Outputs are appended and flushed after each request. Existing response logs
  cannot be overwritten. HTTP/network errors stop the run without a fallback;
  parse/incomplete output failures are recorded alongside raw responses.

## Ground-truth scoring

Report separate outcomes rather than one recognition score:

| Outcome                | Meaning                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `correct_specific`     | A supported identity appears in the description and no contradicting identity appears elsewhere |
| `supported_generic`    | A useful broader description retains the subject without a false specific claim                 |
| `incorrect`            | An unsupported identity appears in description, interpretation, objects or tags                 |
| `unresolved`           | The salient subject is omitted, or there is no accepted positive observation                    |
| `provisional_specific` | A plausible but unconfirmed replacement identity is used; review required                       |

Not saying the previous wrong label does not earn a pass. Saying "bird" instead
of "fox" is still wrong for the road-animal case. Saying "small animal" while
indexing `fox` is also wrong. A hedge does not make an unsupported species or
landmark safe for search. Explicit negation is treated separately.

The deterministic expressions are a screening aid, not a semantic truth judge.
Review every output against the image and truth summary, and record all score
overrides and unsupported-extra-detail findings with explanations. Additional
wrong identities can occur outside a finite contradiction list. For example,
a candidate can invent a different cathedral that is not in the original list.
OCR must be judged against depicted text separately: signs, maps, museum models
and screens may legitimately mention another city. Specificity on easy controls
is measured separately to catch a prompt that merely becomes unhelpfully vague.

Report false identities, incorrect indexed claims, salient-subject coverage,
exact control recognition, unsupported details, schema reliability, repetition
consistency, actual usage/cost and uncertain ground truth. This targeted corpus
does not measure an unbiased error rate across the whole library.

## Historical scoring

The 5 October 2026 model comparison in `MODEL_CHOICE.md` used a narrow
"known wrong label avoided" metric on three animal regressions. That can count
an incorrect replacement as an avoidance success (sheep/bird examples).
Those historical numbers remain historical; use the rubric above for new
prompt evaluations and do not interpret an avoidance tick as correctness.

Run commands and offline checks are documented in `README.md`.

Measured v1/v2 outcomes on the initial 40-case run are in
[DESCRIPTION_V2_RESULTS.md](DESCRIPTION_V2_RESULTS.md). The raw manifest is kept
with that run; the future corpus includes the evidence-backed mara reference
correction and screening calibration described in the report.
