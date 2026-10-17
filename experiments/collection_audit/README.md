# Read-only collection audit

Checks saved media metadata for usable GPS, capture dates, descriptions,
keywords and AI descriptions, and tests idempotence using **all nine production
Normalize groups**. This is a developer command-line tool, not an app UI feature.

The adapters use the production ExifTool scanner, schema registry, frontend
`buildNormaliseItemForFile` and Rust `process_item`. They include the effective
output snapshot and unwritable-output policy. No AI client, draft repository or
apply command is used. Required AI decisions and blocked groups fail conformity;
missing metadata also fails even when Normalize cannot fill it.

## Run

Prerequisites: the app's Node dependencies (`npm ci`), Rust, Python 3.10+ and
ExifTool on PATH. Run from the repository root:

```powershell
python -B experiments/collection_audit/audit.py `
  --root "E:/Photos" `
  --output "experiments/collection_audit/runs/example"
```

Both paths are required; no personal collection or app-data path is built in.
Output must be new or empty and outside the collection. Inside this repository,
outputs are permitted only beneath this package's gitignored `runs/` directory.
External private output directories are supported. Source media are never
written. The scanner may materialise its normal ExifTool configuration in the
application cache; the tool does not open the app's draft database or settings.

`--target-dir PATH` optionally shares an existing Cargo build directory.
`--exclude-folder Assets` separates a root-relative folder in the `included`
summary; it does not omit that folder from scanning or full-collection totals.
Repeat this option for additional folders.

Every supported media file is **freshly read**, rather than trusting cached
metadata or requiring a running app. Large collections may take several minutes.
Failures abort the run instead of silently omitting files. A second inventory
detects additions, deletions and size/mtime changes; an unstable collection is
marked incomplete and exits with an error. Empty collections are supported.

## Interpretation

- Images require a valid embedded DateTimeOriginal. GIFs may instead use valid
  `XMP-photoshop:DateCreated`, since the normalizer's EXIF destination is
  unavailable in that format. The exception is explicitly noted per file.
- Video/audio date presence accepts native capture/creation fields. Zero dates,
  filesystem dates, modification dates and AI generation times do not count.
  Container creation can mean recording end or encoding, so presence does not
  establish its semantic correctness.
- GPS can come from the normal EXIF fields, structured LocationCreated/Shown or
  container GPSCoordinates/GPSPosition. Invalid and zero/zero pairs do not count.
- Description/caption, keywords and AI description must be nonempty.
- The saved metadata is audited without draft overlays. Idempotence means no
  proposed edits, no blocked group and no unresolved AI decision. It does not
  certify that an AI description, estimated date or location is factually true.
- The tool intentionally uses the production normalizer's current time/offset
  semantics, including its local-offset fallback for offsetless IPTC times.

Outputs include `report.md`, `summary.json`, per-file CSV/JSON, inventory,
fresh occurrences, exact normalizer inputs/results, conflicts and blocked fields.
These contain **private metadata and paths**; do not commit run directories.
Only generic source, synthetic tests and dependency lockfiles belong in Git.
No earlier private collection reports, annotations, images or databases are
bundled with the tool.

## Verification

```powershell
python -B -m unittest discover -s experiments/collection_audit -p test_audit.py
cargo fmt --manifest-path experiments/collection_audit/Cargo.toml -- --check
cargo clippy --manifest-path experiments/collection_audit/Cargo.toml -- -D warnings
```

For a real scanner/input-builder/normalizer smoke test:

```powershell
python -B experiments/collection_audit/smoke_test.py
```

The smoke test uses temporary copies of three known-readable repository fixtures,
checks missing-field counts and exact bytes/timestamps, handles an empty
collection, and verifies that a deliberately unreadable JPEG aborts the audit.
It accepts `--target-dir` to share a build cache. The whole `test_images/` folder
also contains deliberately unreadable and platform-sensitive fixtures, so auditing
that folder directly is expected to fail rather than produce a complete report.
Non-conformant readable fixtures are expected. A successful audit command means
complete coverage, not that every file conforms. No live collection or API is
needed for these checks.
