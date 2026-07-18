# ExifTool Schema Identity Investigation (Follow-up)

> **Historical investigation — superseded by
> [Metadata identity model](METADATA_IDENTITY_MODEL.md).**
>
> The candidate-scoring resolver proposed near the end of this document was
> rejected after runtime `-j -t -D` output was shown to expose ExifTool's exact
> selected table, ID and optional index.

This document preserves the collision evidence from the investigation into
ExifTool schema identity. Its staged resolver experiments record how the
problem was explored; they do not describe the current MediaLibrary
architecture.

---

## 1. Investigation environment

- **ExifTool Version**: `13.57`
- **Operating System**: Windows 11

The analysis used a static `-listx` export and runtime experiments over the
repository fixture corpus. Machine-local paths and temporary research-output
status have been omitted because they are not durable architecture guidance.

---

## 2. Static `G1 + TagName + TagID` Analysis

We parsed `listx.xml` (33,676 static definitions) and classified duplicate groups under two keys:

1. **`G1 + TagName`** (Base Key)
2. **`G1 + TagName + TagID`** (Extended Key)

### Quantitative Comparison

| Metric                           | Grouping A (`G1 + Name`) | Grouping B (`G1 + Name + TagID`) |
| :------------------------------- | :----------------------: | :------------------------------: |
| **Total Definitions**            |          33,676          |              33,676              |
| **Unique Keys**                  |          27,651          |              31,933              |
| **Duplicate Groups**             |          2,217           |               981                |
| **Exact Duplicate Groups**       |           962            |               756                |
| **Compatible Duplicate Groups**  |           282            |                19                |
| **Conflicting Duplicate Groups** |         **973**          |             **206**              |

### Resolution of G1:Name Conflicts by Tag ID

Of the original **973** conflicting `G1 + Name` groups:

- **654** groups (67.2%) are **fully resolved** to unique definitions by adding Tag ID.
- **132** groups (13.6%) are **reduced to compatible alternatives** (safe to merge in application).
- **187** groups (19.2%) **still contain conflicting subgroups** (corresponding to **206** distinct conflicting `G1 + Name + TagID` groups).

> [!IMPORTANT]
> `G1 + TagName + TagID` is **not** universally sufficient to resolve all conflicts. Across the complete static dataset, **206** conflicting groups survive.

---

## 3. Classification of Remaining Same-ID Conflicts

The **206** surviving conflicts are classified into the following categories:

1. **Maker-Note Conflicts** (193 groups):
   - Conflicting manufacturer-specific tags (e.g. `Sony:SonyISO:4` or `FujiFilm:AutoBracketing:4352`).
2. **Same-Format Alternative Table Conflicts** (7 groups):
   - E.g. MPEG sample rates under different tables, or RIFF text vs binary tags.
3. **Format-Level Conflicts** (3 groups):
   - `File:BMPVersion:0`
   - `JPS:JPSLayout:12`
   - `QuickTime:PixelAspectRatio:pasp`
4. **Writability-Only Conflicts** (1 group):
   - `Sony:SonyISO:4` (between `Sony::Tag9405b` [writable] and `Sony::Tag9416` [read-only]).
5. **Other** (2 groups):
   - `File:ByteOrder:ByteOrder`
   - `File:ImageLength:8`

### Complete List of Non-Maker-Note Conflicts

| G1:TagName:TagID                  | Conflict Reason            | Candidates (Tables)                                        | App-facing Differences                     |
| :-------------------------------- | :------------------------- | :--------------------------------------------------------- | :----------------------------------------- |
| `File:BMPVersion:0`               | different enum mappings    | `BMP::Main` vs `BMP::OS2`                                  | Windows V3/4/5 enums vs OS/2 V1/2 enums    |
| `JPS:JPSLayout:12`                | different enum mappings    | `JPEG::JPS` (both defs)                                    | Interleaved/Side-by-Side vs Eye selections |
| `QuickTime:PixelAspectRatio:pasp` | writability; storage types | `QuickTime::ItemPropCont` vs `QuickTime::VisualSampleDesc` | Writable int32u vs Read-only int16u        |
| `File:ByteOrder:ByteOrder`        | enum vs non-enum           | `PCAP::Main` vs `Other::PFM`                               | Intel/Motorola enum vs raw text            |
| `File:ImageLength:8`              | different storage types    | `ICO::IconDir` vs `BPG::Main`                              | `int32u` vs `var_ue7`                      |
| `FLIR:Emissivity:3`               | writability; storage types | `FLIR::Main` vs `FLIR::Params`                             | Writable rational64u vs Read-only float    |
| `FujiFilm:AutoBracketing:4352`    | different enum mappings    | `FujiFilm::Main` (both defs)                               | Off/On/Pre-shot vs Off/On/No Flash & Flash |
| `MNG:Compression:10`              | different enum mappings    | `MNG::BasisObject` vs `MNG::JNGHeader`                     | Deflate/Inflate vs Huffman JPEG            |
| `MPEG:SampleRate:Bit20-21`        | different enum mappings    | `MPEG::Audio` (3 defs)                                     | 44.1k/48k/32k vs 22k/24k/16k vs 11k/12k/8k |
| `RIFF:DateTimeOriginal:IDIT`      | different storage types    | `RIFF::Info` vs `RIFF::Hdrl` vs `RIFF::Main`               | string vs unknown `?`                      |
| `RIFF:TimeCode:ISMP`              | different storage types    | `RIFF::Info` vs `RIFF::Hdrl`                               | string vs unknown `?`                      |
| `Reconyx:TriggerMode:52`          | different storage types    | `Reconyx::HyperFire2` vs `Reconyx::UltraFire`              | `string` vs `undef`                        |
| `Sony:SonyISO:4`                  | different writability      | `Sony::Tag9405b` vs `Sony::Tag9416`                        | Writable `int16u` vs Read-only `int16u`    |

---

## 4. Static Separator Matrix (Out of 206 Surviving Conflicts)

We analyzed which static fields can distinguish the candidate definitions for the 206 surviving conflicts:

- **G0 separates**: **0** groups.
- **G2 separates**: **3** groups.
- **Type separates (Family 6 equivalent)**: **23** groups.
- **Writability separates**: **7** groups.
- **Flags separates**: **3** groups.
- **Enum mapping separates (Raw value shape equivalent)**: **186** groups.
- **Requires Table Identity**: **1** group (`Sony:SonyISO:numeric:4`).

---

## 5. Runtime Resolution Simulation

We targeted all **15 fixture files** under `test_images/`, including custom-generated minimal BMP files to exercise `File:BMPVersion`. We ran a structured, collapse-free extraction preserving G0, G1, G2, G5, G6, G7, Tag ID, and Raw Value, simulating **7 progressive resolver stages**:

- **Resolver 1**: `G1 + TagName + TagID`
- **Resolver 2**: `Resolver 1 + G0 + G2`
- **Resolver 3**: `Resolver 2 + Family 6 (runtime storage type)`
- **Resolver 4**: `Resolver 3 + Family 5 path`
- **Resolver 5**: `Resolver 4 + FileType + MIMEType + extension`
- **Resolver 6**: `Resolver 5 + Make + Model`
- **Resolver 7**: `Resolver 6 + observed raw value shape`

### Performance Metrics across 377 Tag Occurrences

| Stage          |  Unique Match   | Compatible Match | Conflicting Match | No Static Match |
| :------------- | :-------------: | :--------------: | :---------------: | :-------------: |
| **Resolver 1** |   343 (91.0%)   |    30 (8.0%)     |   **2 (0.5%)**    |    2 (0.5%)     |
| **Resolver 2** |   343 (91.0%)   |    30 (8.0%)     |   **2 (0.5%)**    |    2 (0.5%)     |
| **Resolver 3** |   343 (91.0%)   |    30 (8.0%)     |   **2 (0.5%)**    |    2 (0.5%)     |
| **Resolver 4** |   347 (92.0%)   |    26 (6.9%)     |   **2 (0.5%)**    |    2 (0.5%)     |
| **Resolver 5** |   347 (92.0%)   |    26 (6.9%)     |   **2 (0.5%)**    |    2 (0.5%)     |
| **Resolver 6** |   347 (92.0%)   |    26 (6.9%)     |   **2 (0.5%)**    |    2 (0.5%)     |
| **Resolver 7** | **349 (92.6%)** |  **26 (6.9%)**   |   **0 (0.0%)**    |  **2 (0.5%)**   |

### Detailed Resolution Progression Traces for `File:BMPVersion`

We generated two test BMPs: `test_win_v3.bmp` (Windows V3) and `test_os2_v1.bmp` (OS/2 V1). Both share G1=`File`, Name=`BMPVersion`, and TagID=`0`.

```text
Conflict occurrence: File:BMPVersion (ID: 0) in test_os2_v1.bmp
  Observed Raw Value: 12
  Stage R1 -> candidates remaining: 2, status: conflicting
  Stage R2 -> candidates remaining: 2, status: conflicting
  Stage R3 -> candidates remaining: 2, status: conflicting
  Stage R4 -> candidates remaining: 2, status: conflicting
  Stage R5 -> candidates remaining: 2, status: conflicting
  Stage R6 -> candidates remaining: 2, status: conflicting
  Stage R7 -> candidates remaining: 1, status: unique (Resolved to 'BMP::OS2')

Conflict occurrence: File:BMPVersion (ID: 0) in test_win_v3.bmp
  Observed Raw Value: 40
  Stage R1 -> candidates remaining: 2, status: conflicting
  Stage R2 -> candidates remaining: 2, status: conflicting
  Stage R3 -> candidates remaining: 2, status: conflicting
  Stage R4 -> candidates remaining: 2, status: conflicting
  Stage R5 -> candidates remaining: 2, status: conflicting
  Stage R6 -> candidates remaining: 2, status: conflicting
  Stage R7 -> candidates remaining: 1, status: unique (Resolved to 'BMP::Main')
```

---

## 6. Answers to Core Questions

### Is Family 5 path required or deterministic?

**No**. Family 5 is **not** deterministic. Both `test_win_v3.bmp` and `test_os2_v1.bmp` produce the exact same Family 5 path `BMP-File`, which fails to distinguish between the two static tables (`BMP::Main` and `BMP::OS2`). Family 5 only serves as layout-level contextual evidence.

### What causes the `IFD1:ThumbnailImage` no-match cases?

ExifTool defines `ThumbnailImage` statically in the `Composite` table with G1=`All`. However, at runtime, ExifTool dynamically overrides G0/G1 of the Composite `ThumbnailImage` tag to match its physical location in the file (`EXIF` / `IFD1`).

- **Implication**: These should be treated as a distinct "dynamic/Composite segment redirection" category rather than ordinary failures.

### What are the new-property implications?

Without an existing tag in a file, we do not have a runtime Tag ID.

- **Implication**: Adding a new property is either `not writable` (read-only tags like `BMPVersion`), `safe only with a selected target namespace/table` (maker notes or alternate tables), or `ambiguous`. Tag ID only helps resolve tags already present.

---

## 7. Superseded resolver recommendation

The investigation originally proposed resolving by `G1 + TagName + TagID`,
then scoring candidates with Make and Model, FileType and MIMEType, observed
value shape, and a preference for writable definitions. That recommendation
is rejected.

Runtime `-j -t -D` output supplies the exact selected table, ID and optional
index. Current code performs exact `SchemaDefinitionId` lookup and does not use
candidate scoring, Make/Model inference, file-type inference, value-shape
inference or a “prefer writable” fallback. Add New Property similarly presents
exact definitions for explicit selection rather than choosing a friendly-name
candidate. See the [metadata identity model](METADATA_IDENTITY_MODEL.md).
