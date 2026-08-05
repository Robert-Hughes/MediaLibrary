# Samsung SEF panoramas with a missing JPEG EOI

This note records a recurring Samsung panorama defect, the evidence needed to
diagnose it, and the repair procedure that has preserved both pixels and
Samsung trailer data in known cases.

The repair is not implemented by MediaLibrary. Treat it as a manual recovery
procedure: calculate the boundary from the SEF directory, make and verify an
original backup, validate a staged copy, and only then replace the source.

## Symptom and cause

Affected files are otherwise valid baseline JPEG panoramas followed by a
Samsung SEF trailer, but the JPEG `FF D9` end-of-image marker is missing between
the entropy-coded JPEG data and the proprietary trailer.

MediaLibrary's `image 0.24.9` / `jpeg-decoder 0.3.2` path may report:

- `failed to fill whole buffer`;
- `RES marker found where not allowed`; or
- `JPGn(n) marker found where not allowed`.

ExifTool also reports `JPEG format error`.

The messages have the same underlying cause. Without `FF D9`, the decoder
continues looking for JPEG markers in Samsung data. A short trailer containing
no `FF` byte reaches EOF and produces `failed to fill whole buffer`. Larger
motion-panorama trailers contain accidental `FF xx` byte pairs; some are
interpreted as illegal `RES` or `JPGn` markers instead.

Pillow/libjpeg is more permissive and may decode the broken original
successfully. Pillow success does not prove that the JPEG is correctly
terminated.

## Calculating the only safe insertion point

Do not insert at the first decoder error or at the first marker-looking byte in
the trailer. Samsung offsets and embedded media are size-sensitive. Calculate
the boundary from the directory at EOF:

1. Read the little-endian `u32` directory length at `file_length - 8`.
2. Verify ASCII `SEFT` at `file_length - 4`.
3. Calculate:

   ```text
   directory_position = file_length - 8 - directory_length
   ```

4. Verify ASCII `SEFH` at `directory_position`.
5. Read the little-endian version and entry count at offsets `+4` and `+8`.
6. Verify `directory_length == 12 + 12 * entry_count`.
7. Each 12-byte directory entry is:

   ```text
   u16 reserved
   u16 type
   u32 offset
   u32 block_length
   ```

   Therefore entry `i`'s offset is the little-endian `u32` at:

   ```text
   directory_position + 16 + 12 * i
   ```

8. Calculate:

   ```text
   jpeg_trailer_boundary = directory_position - max(entry_offsets)
   ```

9. Cross-check each resolved data block. Its header repeats `reserved`, `type`,
   and a label length; known labels include `Panorama_Shot_Info`,
   `Image_UTC_Data`, and `MCC_Data`. Blocks should be contiguous and the last
   should end at `directory_position`.

For a conventionally terminated file, `FF D9` is immediately before the
calculated boundary. Some valid Samsung files have additional data between an
earlier EOI and the SEF data, so a missing adjacent EOI is a candidate filter,
not sufficient proof of this defect.

Conversely, searching for any EOI anywhere is insufficient. Embedded
thumbnails may contain their own `FF D9` even when the primary panorama is
missing its EOI.

## Scalable collection search

A collection scan does not need to decode every image:

1. Enumerate JPEG filenames, initially prioritising Samsung-style
   `YYYYMMDD_HHMMSS.jpg` names.
2. Read only the final eight bytes.
3. Keep files ending in `SEFT`.
4. Read and validate the small calculated `SEFH` directory.
5. Calculate the trailer boundary and check the preceding two bytes.
6. Fully inspect and decode only candidates without an adjacent EOI.
7. Confirm candidates with MediaLibrary's exact Rust decoder and ExifTool.
8. Widen the cheap tail scan to every JPEG so naming does not hide outliers.

In the 2026-07-28 scan:

- 13,956 JPEGs were examined;
- all files were readable after OneDrive restarted;
- 7,305 contained a valid SEF directory;
- 14 lacked an EOI immediately adjacent to the calculated boundary;
- ten SM-G935F 4032x3024 files contained an earlier valid EOI and decoded
  normally;
- four SM-G973F cylindrical panoramas failed the exact Rust decoder and were
  confirmed affected.

After repairing those four, the same collection scan had zero read errors and
only the ten known non-adjacent-but-valid layouts remained.

## Safe repair procedure

For each independently confirmed file:

1. Record its length, SHA-256, SEF layout, calculated boundary, filesystem
   timestamps, and relevant ExifTool metadata.
2. Copy the untouched original to a dedicated backup directory outside the
   photo collection.
3. Verify the backup SHA-256 equals the source SHA-256.
4. Build a staged file as:

   ```text
   original[0..boundary] + FF D9 + original[boundary..end]
   ```

5. Before touching the original, verify all of the following:

   - staged length is exactly original length plus two;
   - the prefix before the insertion is byte-identical;
   - every byte after the insertion is identical to the original trailer;
   - the full trailer SHA-256 is unchanged;
   - Pillow fully decodes the backup and staged file to identical RGB pixel
     hashes;
   - MediaLibrary's exact Rust decoder fails the backup and succeeds on the
     staged file at the expected dimensions;
   - ExifTool no longer reports `JPEG format error`;
   - ExifTool metadata, excluding filesystem fields and expected validation
     warning changes, is identical;
   - Samsung and GPano data remain recognised.

6. Recheck the original SHA-256 immediately before replacement so a concurrent
   sync or edit cannot be overwritten.
7. Replace from the verified staged file, preferably using a same-directory
   atomic replacement with a temporary rollback copy.
8. Restore the original creation and modification timestamps using
   culture-independent ISO timestamps.
9. Repeat all decoder, pixel, metadata, hash, trailer, and collection-tail
   checks against the final original path.
10. Retain the verified pre-repair backup.

If any check fails, do not replace the original. Never use the first illegal
JPEG marker as the insertion point.

## Confirmed 2026 repair set

The following files were repaired on 2026-07-28. Their verified originals are
under:

```text
D:\Temp\Samsung-panorama-eoi-repair-2026-07-28\originals
```

| File                  | Dimensions | Original boundary | Original SHA-256                                                   | Repaired SHA-256                                                   |
| --------------------- | ---------: | ----------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `20191101_182543.jpg` | 12480x3664 |        16,208,673 | `E8E6A9AC30685F6F7825BF939BC4A2132DB8ECEFE064DE1A38A4997462223B42` | `A3434778E7614F4F973C934553070239B025E111F4C4288F2052937165A573F2` |
| `20210501_144019.jpg` |  9984x2944 |        13,185,004 | `0606C7591C3D017D22501FBDF1859F75DBF5ADB4A94D74E9734BD0EA9269F595` | `3BD884D6D3BE9CB792054F3266A42CF6516A56F91BADE67D0F80B60E867268F5` |
| `20210501_144045.jpg` |  6704x2320 |         7,175,926 | `02659DDFCB7C3EC085BD7CBD45EE6FC625D869CF4EFA50CDDDD077B1731224A7` | `297D60B1BC97BECDCBA20C1902709B3A06135597AD706EDCCAE9068ECD57E17F` |
| `20210625_142433.jpg` |  9168x2864 |         8,986,285 | `2AA7B4FE1EBB0EB66FAF4CDBA96A98A1835E24ACA70F41A0F6A030D9264D6B1E` | `287B66FBF17F3B7923F88C4E95096776994212DC0D681248B5AE6EBB54022238` |

All four grew by exactly two bytes, retained identical decoded RGB pixel
hashes, retained byte-identical Samsung trailers, retained equivalent ExifTool
metadata, and decoded successfully through MediaLibrary's exact Rust stack.

Earlier confirmed cases repaired by the same method were:

- `20170818_123402.jpg`
- `20170818_124756.jpg`
- `20170903_134028.jpg`
- `20181212_130239.jpg`

The preserved pre-repair 2018 backup reproduced the exact
`JPGn(0) marker found where not allowed` error and demonstrated why large
motion-panorama trailers can surface marker errors rather than EOF.

## Related defect: dangling `OtherImageStart` / `OtherImageLength` pointers

A second Samsung defect blocks MediaLibrary writes with a different ExifTool
error. It does not involve a missing EOI: the SEF trailer is intact and the
main JPEG decodes normally. The problem is a pair of IFD0 entries that point
at a secondary embedded image which is absent from the file.

### Symptom

Applying a metadata draft to an affected file fails for **every** target. The
apply audit log records `pass.kind = Failed` for each tag with:

```text
ExifTool raw write failed: Warning: [minor] Entries in IFD0 were out of
sequence. Fixed. - <path>
Error: Error reading OtherImageStart data in IFD0 - <path>
```

`post_write` is `Missing`, verification is `MissingPostWrite` with
`proposed_reconciliation: Keep`, so the drafts stay pending and a re-apply
fails identically. The scanner also flags the pointer:

```text
[parse_exiftool] Schema gap summary: count=N tag=... { table: "Exif::Main",
tag_id: "513", index: Some(9) } (IFD0:OtherImageStart) raw_type=integer
reason=schema kind is unknown raw_example=1212
```

Reads succeed and the image renders; only writes fail.

### Cause

Samsung phone JPEGs (observed on Galaxy Z Fold5) carry IFD0 entries `0x201`
(`OtherImageStart`) and `0x202` (`OtherImageLength`) describing a secondary
preview image. In affected files the pointer is dangling: the bytes at the
referenced offset are not `FF D8`, and the file contains exactly one
SOI/EOI pair (only the main image). The embedded preview was likely stripped
by an earlier converter or sync tool while the IFD entries survived.

ExifTool treats these tags as protected, so it cannot delete them directly.
Any write that re-serialises IFD0 - for example the common `IFD0:ImageDescription`
target - forces ExifTool to relocate the `OtherImage` block. Reading the
dangling pointer is a hard error, the whole multi-tag invocation aborts, and
none of the drafts apply. Writes that touch only XMP/IPTC segments still
succeed because ExifTool copies the EXIF segment as an opaque blob.

### Diagnosis

1. Inspect the pointers:

   ```sh
   exiftool -s -G1 -IFD0:OtherImageStart -IFD0:OtherImageLength file.jpg
   ```

2. Confirm the embedded image is invalid:

   ```sh
   exiftool -b -OtherImage file.jpg
   # -> Warning: [minor] OtherImage is not a valid JPEG image
   ```

   Healthy Samsung files return the embedded preview bytes here and must not
   be touched.

3. Confirm only one SOI/EOI pair exists (the main image) and the referenced
   bytes are not `FF D8`. The raw IFD0 value is relative to the TIFF header;
   absolute offset = 12 + stored value in these files.

4. Try the write alone on a copy to reproduce:

   ```sh
   exiftool -overwrite_original -P -IFD0:ImageDescription=Test copy.jpg
   ```

   Affected files fail with `Error reading OtherImageStart data in IFD0`.

### Safe repair procedure

Direct deletion is refused (`Sorry, IFD0:OtherImageStart is protected for
writing`), so the two IFD0 entries must be removed from the file bytes.
Follow the same discipline as the missing-EOI repair: backup, verify,
stage, validate, then replace.

1. Copy the untouched originals to a dedicated backup directory outside the
   photo collection and verify SHA-256 plus filesystem timestamps.
2. Remove the `0x201`/`0x202` entries from IFD0 (see script below): parse the
   Exif APP1 (the TIFF header starts at file offset 12, after the
   `FF E1 <len> Exif\0\0` prefix), drop the two 12-byte entries, decrement the
   entry count, move the next-IFD pointer forward, and zero the vacated
   region. Do not re-sort or touch any other entry; file length is unchanged.
3. Stage and verify the copy: `exiftool -validate` warning count is
   unchanged, `exiftool -G1 -s -a` output is identical apart from the removed
   tags and `[File]` fields, Pillow decodes to identical pixel hashes, and
   the SEF trailer bytes are identical.
4. Decisive check - replay the app's exact write (the embedded config plus
   the full draft argument list in an argfile). It must exit 0 and report
   `1 image files updated` with no `Error:` lines on stderr.
5. Re-hash the original immediately before replacement, replace via a
   same-directory rename of a verified temp file, and restore the original
   creation and modification timestamps using culture-independent ISO
   timestamps.
6. Repeat the metadata, pixel, trailer, hash and write checks against the
   final path, then re-apply the pending drafts in MediaLibrary.

```js
// Remove dangling IFD0 OtherImageStart/OtherImageLength entries (513/514).
// Usage: node fix.mjs <input> <output>
import { readFileSync, writeFileSync } from "node:fs";
const [i, o] = process.argv.slice(2);
const b = readFileSync(i);
const tiff = 12; // "Exif\0\0" occupies bytes 6..11, TIFF header at 12
const be = b.toString("latin1", tiff, tiff + 2) === "MM";
const u16 = (x) => (be ? b.readUInt16BE(x) : b.readUInt16LE(x));
const u32 = (x) => (be ? b.readUInt32BE(x) : b.readUInt32LE(x));
const w16 = (x, v) => (be ? b.writeUInt16BE(v, x) : b.writeUInt16LE(v, x));
const w32 = (x, v) => (be ? b.writeUInt32BE(v, x) : b.writeUInt32LE(v, x));
const ifd0 = tiff + u32(tiff + 4);
const n = u16(ifd0);
const drop = [];
for (let i2 = 0; i2 < n; i2++) {
  const tag = u16(ifd0 + 2 + 12 * i2);
  if (tag === 513 || tag === 514) drop.push(i2);
}
if (drop.length !== 2) throw new Error("expected exactly 513 and 514");
// Safety: no kept entry may store data inside the region that gets zeroed.
const zeroFrom = ifd0 + 2 + 12 * (n - 2) + 4, zeroTo = ifd0 + 2 + 12 * n + 4;
const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
for (let i2 = 0; i2 < n; i2++) {
  if (drop.includes(i2)) continue;
  const e = ifd0 + 2 + 12 * i2;
  const size = sizes[u16(e + 2)] ?? 0;
  const cnt = u32(e + 4);
  if (size > 0 && size * cnt > 4) {
    const abs = tiff + u32(e + 8);
    if (abs >= zeroFrom && abs < zeroTo) throw new Error(`tag ${u16(e)} stores data in zeroed region`);
  }
}
const next = u32(ifd0 + 2 + 12 * n);
w16(ifd0, n - 2);
let k = 0;
for (let i2 = 0; i2 < n; i2++) {
  if (drop.includes(i2)) continue;
  const src = ifd0 + 2 + 12 * i2, dst = ifd0 + 2 + 12 * k++;
  if (dst !== src) b.copy(b, dst, src, src + 12);
}
w32(ifd0 + 2 + 12 * (n - 2), next);
b.fill(0, zeroFrom, zeroTo);
writeFileSync(o, b);
```

### Confirmed 2026-08-05 repair set

All three are Samsung Galaxy Z Fold5 files (4000x3000) in
`D:\OneDrive\Pictures\2025\`. Verified pre-repair originals are under:

```text
D:\Temp\ml-otherimage-repair-2026-08-05\originals
```

| File                  | `OtherImageStart` / `OtherImageLength` | Original SHA-256                                                   | Repaired SHA-256                                                   |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `20251229_102829.jpg` | 1212 / 61544                           | `A4F3D977E6FE1983C267534A21730B51127D36736B8208060789F02FF1CD0AFE` | `825B1EFA13B714A62FB046AFE84745FCA6F352EBB8620A609E4A73D08986016E` |
| `20251229_105206.jpg` | 1014 / 46786                           | `EDFF2EADA46387959A2419E1C3B7FDDB67FBD65A60221113BFBDEF0F42A5CB4F` | `04EAF7EEFC28C21F682BB352581F6B2BE393B03FBA957B80B8F77113031C40D2` |
| `20251229_110048.jpg` | 1014 / 46898                           | `8B85539895CB16864EE6B0DB3DEA2471F193B641CC825E319155035570833B4F` | `B504EBD9920FCE10F0643F46AA5EE44B4FA24DCB7CC06E77FB50D6376AF7FDCB` |

All three kept their original length and timestamps, retained byte-identical
SEF trailers, decoded to identical RGB pixel hashes, kept identical ExifTool
metadata apart from the removed tags, and passed the app's exact full-draft
write replay. The 2026-08-05 collection scan found exactly these three files
with dangling `OtherImage` pointers (`Exif::Main` tag 513 schema-gap
count = 3).
