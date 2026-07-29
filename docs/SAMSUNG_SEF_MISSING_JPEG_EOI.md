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
