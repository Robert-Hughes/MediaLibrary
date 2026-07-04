# Datatype mismatches between schema and runtime value

When the Details pane renders a row, two datatype badges may appear:

- `[X]` schema badge — derived from `TagInfo.kind` (ExifTool `-listx`).
- `(Y)` value badge — derived from the actual `Variant` returned by the
  scanner for this file.

Today these can disagree on tags that come straight from ExifTool, with no
user edit involved. The most visible example is `ExifIFD:ComponentsConfiguration`:

```
[B]ComponentsConfiguration   (S)   Y, Cb, Cr, -
```

Same thing for XMP-dc:Title:
LA Title Big waggle! {} x-default: Big waggle!

Schema says **Bag** (`[B]`); runtime variant is a **String** (`(S)`).

## Why it happens

`exiftool -listx -lang en` describes ComponentsConfiguration as:

```xml
<tag id='37121' name='ComponentsConfiguration'
     type='undef' count='4' writable='true' g1='ExifIFD'>
  <desc lang='en'>Components Configuration</desc>
  <values>
    <key id='0'><val lang='en'>-</val></key>
    <key id='1'><val lang='en'>Y</val></key>
    <key id='2'><val lang='en'>Cb</val></key>
    <key id='3'><val lang='en'>Cr</val></key>
    <key id='4'><val lang='en'>R</val></key>
    <key id='5'><val lang='en'>G</val></key>
    <key id='6'><val lang='en'>B</val></key>
  </values>
</tag>
```

`type='undef'` + `count='4'` + an enum value table. `derive_kind()` in
`src-tauri/src/tag_schema.rs` maps that to:

1. `undef` → `TagKind::Unknown`.
2. Enum value table present → wrap as `Enum { repr: String, options: [...] }`.
3. `count > 1` → `wrap_count` wraps the result in `Bag(...)`.

So the schema kind for this tag is `Bag(Enum(...))` → badge `[B]`.

At scan time, ExifTool's PrintConv collapses the four raw bytes through the
value table into a single human-readable string `"Y, Cb, Cr, -"`. The
scanner records that as `Variant::String("Y, Cb, Cr, -")`, so the runtime
value badge is `(S)`.

In short: the schema documents the **conceptual** shape (a list of four
enum codes), but ExifTool's default JSON output returns the **rendered**
shape (one string). Two valid views of the same tag.

## How widespread is it?

From a full `exiftool -listx -lang en` dump:

- **244 tags** have `count > 1` (would gain a `Bag(...)` wrapper).
- **117 of those** have `type='undef'` + `count > 1`.
- **454 tags** have `type='undef'` + `writable='true'` overall.

Selected writable examples that exhibit the same schema-vs-value badge
disagreement:

| Tag                                 | listx type | count  | Reality from `exiftool -j`              |
| ----------------------------------- | ---------- | ------ | --------------------------------------- |
| `ExifIFD:ComponentsConfiguration`   | undef      | 4      | one PrintConv string `"Y, Cb, Cr, -"`   |
| `ExifIFD:LensSerialNumber`          | undef      | 5      | one string                              |
| `Composite:VideoCodec`              | undef      | 4      | one string                              |
| `IPTC:RasterizedCaption`            | undef      | 7360   | one base64-ish string                   |
| `IPTC:ObjectPreviewData`            | undef      | 256000 | one base64-ish string                   |
| `GPS:GPSVersionID`                  | int8u      | 4      | `"2.3.0.0"` (single dotted-quad string) |
| `GPS:GPSLatitude` / `GPSLongitude`* | rational   | 3      | one decimal/DMS string after PrintConv  |

(*) GPS coordinates are an extra wrinkle: the `Composite:GPS*` aliases are
typed `Real` and come back as plain numbers, but the underlying
`GPS:GPSLatitude` tag is a rational array that ExifTool collapses to one
PrintConv string. Both views currently exist for any image with GPS.

It is not a one-off. Roughly every EXIF tag with `count > 1` that goes
through a PrintConv (which is the default JSON behaviour) will show this
mismatch.

## Options for fixing

Two general approaches:

### A. Narrow schema fix (cheap)

Stop wrapping `Unknown`-or-`Binary` base kinds in `Bag(...)` when listx
reports `count > 1`. The wrap was originally there to express "this is a
list", but for `undef`/binary blobs that is misleading — the user can't
edit four opaque bytes as a four-item list.

In `derive_kind` / `wrap_count` (`src-tauri/src/tag_schema.rs:487`):

```rust
fn wrap_count(kind: TagKind, count: Option<u32>) -> TagKind {
    match count {
        // Opaque / binary types stay opaque even with count > 1 — listx's
        // `count` describes byte-width, not a user-editable item list.
        Some(n) if n > 1 && !matches!(kind, TagKind::Unknown | TagKind::Binary) => {
            TagKind::Bag(Box::new(kind))
        }
        _ => kind,
    }
}
```

This kills the `[B]` badge on ComponentsConfiguration, LensSerialNumber,
RasterizedCaption, ObjectPreviewData, VideoCodec, etc. They'd render as
`Unknown` (or `Binary` after the override allowlist in `AGENTS.md`).

Pros: trivial, surgical, no scanning changes. Pros: makes the badge match
reality for the common case.

Cons: loses the "this is conceptually a 4-tuple" hint for the few cases
where that is genuinely useful (e.g. ComponentsConfiguration's enum table).

### B. Structured array scanning (broad)

Re-scan with `-#` + a per-group structured mode so multi-count tags come
back as arrays, then the variant matches the schema's Bag shape and the
badges agree without a schema change.

Two sub-options:

- **Per-tag opt-in**: keep the default human-readable scan, but for the
  small set of "list-shaped" EXIF tags rescan via a `-Tag#` request to
  fetch the raw integer/byte tuple. Adds I/O.
- **Whole-file**: scan twice (once with PrintConv, once raw) and merge.
  Heaviest but produces a uniform model — every numeric/array tag
  has both its human and raw forms available, which would also help the
  editor pick a sensible widget for any future `Bag(Integer)`-shaped tags.

Pros: matches reality, supports future editing of these tags as actual
lists. Cons: more complex, slower scanning, more memory.

### C. Cosmetic — hide the mismatched value badge

The schema badge is informational; the value badge is a divergence hint.
We could special-case "value-badge shows `(S)` but schema is `Bag(Unknown)`
or `Bag(Binary)`" and suppress the value badge entirely. Doesn't fix the
underlying model — just stops showing the badge that's confusing.

Pros: smallest change, purely UI. Cons: pretending the data agrees rather
than reconciling it.

## Recommendation (deferred)

Start with **A** in `wrap_count` — it removes the visible inconsistency
for the ~100 tags that hit this case without needing a scanner overhaul.
Pair it with the `TagKind::Binary` override allowlist for the genuinely
opaque tags (MakerNotes, PreviewImage, ThumbnailImage, XMP-as-undef, …).
Defer **B** until we actually want to let the user edit these as arrays.

## Related questions to revisit

- How should `GPSVersionID` and `Composite:GPS*` render? The composite
  view is canonical for users, the raw view is what writes go to.
- Should `XMP-mwg-rs:Regions` (a `Struct` per override) ever expose a
  list/struct badge to make its nesting visible at a glance?
- The 244 `count > 1` tags break down across many groups — IPTC has lots
  of fixed-width-padded fields like `ObjectPreviewData` (count=256000)
  that are clearly Binary, not Bag.
