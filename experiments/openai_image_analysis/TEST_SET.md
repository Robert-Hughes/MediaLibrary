# Test Set for Model Comparison

21 images covering a deliberately wide range of photo types. 20 are from
`D:\OneDrive\Pictures\2010` and already carry EXIF descriptions and keyword
tags (visible via `exiftool`), so they double as a ground-truth set for
spot-checking model output: compare each model's `description` / `tags` /
`ocr_text` against the existing metadata. The 21st is a phone screenshot of
a text-heavy webpage — an adversarial OCR / non-photographic case that
stresses how each model handles content that isn't really a "photo".

## Photos

| #   | File                                                          | Category               | Why it's in the set                                                                                                 |
| --- | ------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | `Image0001.jpg`                                               | Portrait (single)      | Smiling-face baseline; checks basic subject ID                                                                      |
| 2   | `Image0099.jpg`                                               | Couple portrait        | Two-subject scene                                                                                                   |
| 3   | `Image0501.jpg`                                               | Selfie                 | Foreground subject + landmark background (Thames Barrier)                                                           |
| 4   | `Image0036.jpg`                                               | Architecture           | St Pancras Renaissance Hotel — landmark recognition test                                                            |
| 5   | `Image0028.jpg`                                               | Train station interior | Indoor + transport + architecture combo                                                                             |
| 6   | `Image0066.jpg`                                               | Bridge / river         | Wide cityscape with multiple landmarks                                                                              |
| 7   | `Image0125.jpg`                                               | Close-up structure     | London Eye pods — close-up of a famous object                                                                       |
| 8   | `Image0286.jpg`                                               | Flowers                | Color, species recognition (tulips)                                                                                 |
| 9   | `Image0581.jpg`                                               | Beach / sea            | Wide natural scene + distant wind turbines (fine detail)                                                            |
| 10  | `Image0381.jpg`                                               | Landscape              | Greenwich Park field with Queen's House — recognition + scene                                                       |
| 11  | `Image0118.jpg`                                               | Animals                | Pigeons in grass — small-object detection                                                                           |
| 12  | `Image0042.jpg`                                               | Statue / monument      | "The Meeting Place" — sculpture recognition                                                                         |
| 13  | `Image0514.jpg`                                               | Night                  | Tower of London illuminated — low-light scene                                                                       |
| 14  | `Image0047.jpg`                                               | Map / signage          | Underground map — heavy OCR test                                                                                    |
| 15  | `Image0322.jpg`                                               | Museum exhibit         | Forth Bridge model in display case — meta-scene (object of object)                                                  |
| 16  | `Image0136.jpg`                                               | Skyline / cityscape    | River-and-skyline composition                                                                                       |
| 17  | `Image0021.jpg`                                               | Motion blur (creative) | Tests handling of intentionally blurry images                                                                       |
| 18  | `Image0009.jpg`                                               | Pub / indoor scene     | Group of people + objects + indoor lighting                                                                         |
| 19  | `Image0686.jpg`                                               | Punting on river       | Activity recognition (specific to Cambridge)                                                                        |
| 20  | `Image0058.jpg`                                               | Close-up still life    | Handbag — fashion-object close-up                                                                                   |
| 21  | `Screenshot_20260508_112540_Samsung Browser.jpg` (in `2026/`) | Webpage screenshot     | Text-heavy phone screenshot — non-photographic content, stresses OCR and the model's handling of UI/document images |

## Running the Test Set

The tool processes one image per API call sequentially. With
`--output-next-to-image` the structured JSON gets written next to each source
file as `<stem> (<model>).json`, so multiple runs against the same image with
different models accumulate side-by-side outputs that can be diffed.

Cost ballpark per model for all 21 photos (1024x1024 input, ~250 output
tokens/image): nano $0.01, mini $0.025, gpt-4o $0.04, gpt-5.4 $0.09, gpt-5.5 $0.18.
Total across all five models ≈ $0.34.

### PowerShell one-liners

Replace the binary path if needed. The tool prompts for confirmation once per
run before sending requests.

```powershell
$IMG = @(
    "D:\OneDrive\Pictures\2010\Image0001.jpg",
    "D:\OneDrive\Pictures\2010\Image0099.jpg",
    "D:\OneDrive\Pictures\2010\Image0501.jpg",
    "D:\OneDrive\Pictures\2010\Image0036.jpg",
    "D:\OneDrive\Pictures\2010\Image0028.jpg",
    "D:\OneDrive\Pictures\2010\Image0066.jpg",
    "D:\OneDrive\Pictures\2010\Image0125.jpg",
    "D:\OneDrive\Pictures\2010\Image0286.jpg",
    "D:\OneDrive\Pictures\2010\Image0581.jpg",
    "D:\OneDrive\Pictures\2010\Image0381.jpg",
    "D:\OneDrive\Pictures\2010\Image0118.jpg",
    "D:\OneDrive\Pictures\2010\Image0042.jpg",
    "D:\OneDrive\Pictures\2010\Image0514.jpg",
    "D:\OneDrive\Pictures\2010\Image0047.jpg",
    "D:\OneDrive\Pictures\2010\Image0322.jpg",
    "D:\OneDrive\Pictures\2010\Image0136.jpg",
    "D:\OneDrive\Pictures\2010\Image0021.jpg",
    "D:\OneDrive\Pictures\2010\Image0009.jpg",
    "D:\OneDrive\Pictures\2010\Image0686.jpg",
    "D:\OneDrive\Pictures\2010\Image0058.jpg",
    "D:\OneDrive\Pictures\2026\Screenshot_20260508_112540_Samsung Browser.jpg"
)
$ARGS_LIST = @()
foreach ($p in $IMG) { $ARGS_LIST += @("--image", $p) }
$BIN = ".\target\release\openai_image_analysis.exe"

# Run each model in turn. The --output-next-to-image flag writes
# "<stem> (<model>).json" next to each source image, so outputs across
# models accumulate side-by-side for comparison.
& $BIN --model gpt-5.4-nano --output-next-to-image @ARGS_LIST
& $BIN --model gpt-5.4-mini --output-next-to-image @ARGS_LIST
& $BIN --model gpt-4o        --output-next-to-image @ARGS_LIST
& $BIN --model gpt-5.4       --output-next-to-image @ARGS_LIST
& $BIN --model gpt-5.5       --output-next-to-image @ARGS_LIST
```

### Reading EXIF ground truth

To pull the existing descriptions/tags for a single image to compare against
model output:

```powershell
exiftool -Description -Subject -Keywords "D:\OneDrive\Pictures\2010\Image0581.jpg"
```

Or bulk for all 20:

```powershell
exiftool -Description -Subject -Keywords @IMG
```

## What to Look For When Comparing

- **Landmark recognition** — does the model name "St Pancras", "Tower of
  London", "London Eye", "Big Ben", "Thames Barrier", "Queen's House"? Or
  does it generic-out to "old building", "ferris wheel"?
- **OCR fidelity** on `Image0047.jpg` (Underground map) — distinct text
  regions captured, station names readable
- **Small-object detection** on `Image0118.jpg` (pigeons) and `Image0581.jpg`
  (distant wind turbines)
- **Activity specificity** — "punting" vs generic "boating" on `Image0686.jpg`
- **Tag overlap** with existing EXIF keywords — strict overlap, near-matches,
  and what each model adds beyond what was tagged
- **Failure modes on motion blur** (`Image0021.jpg`) — does the model
  confabulate detail or correctly note "blurry"?
- **Meta-scene handling** on `Image0322.jpg` — does the model recognise this
  as a _model of a bridge in a museum display case_, or just call it a
  bridge?
- **Non-photographic content** on the Samsung Browser screenshot — does the
  model identify it as a screenshot/webpage (correct), describe it as a
  photo of a phone (wrong abstraction), or just dump OCR? Are tags
  appropriate (e.g. `screenshot`, `webpage`) or photographic (`indoor`,
  `close-up`)?
