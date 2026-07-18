// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  ImageMetadata,
  MetadataApplyFileResult,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { normalizeMetadataOccurrencesFromTauri } from "../utils/scanEvents";
import {
  isImageMetadata,
  isMetadataOccurrence,
  isTagInfo,
} from "../utils/metadataWireGuards";
import {
  targetApplyFileResultFromUnknown,
  targetApplyProgressFromUnknown,
  targetApplyResultFromUnknown,
  targetApplyStartedFromUnknown,
} from "../utils/targetApplyWire";

const schema = (index?: number): SchemaDefinitionId => ({
  table: "Exif::Main",
  tag_id: "282",
  ...(index === undefined ? {} : { index }),
});

const tagInfo = (): TagInfo => ({
  id: schema(),
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind: { kind: "Rational" },
  description: "Horizontal resolution",
  storage_count: "1",
});

const occurrence = (
  path = "JPEG-APP1-IFD0",
  value = 300,
): MetadataOccurrence => ({
  id: {
    document: null,
    path,
    runtime_tag_id: "282",
    tag_id_scope: { table: "Exif::Main", tag_id: "282", index: null },
    copy: 0,
  },
  schema_id: schema(),
  value: { kind: "Rational", value: { numerator: value, denominator: 1 } },
  tag_info: tagInfo(),
  observed_selector: {
    group1: "IFD0",
    group7: "ID-Test",
    tag_name: "XResolution",
  },
  write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "XResolution" },
});

const imageMetadata = (
  occurrences: MetadataOccurrence[] = [occurrence()],
  relativePath = "photo.jpg",
): ImageMetadata => ({
  relative_path: relativePath,
  occurrences,
});

const fileResult = (relativePath = "photo.jpg"): MetadataApplyFileResult => ({
  relative_path: relativePath,
  applied: true,
  error: null,
  warning: null,
  fresh_image_metadata: imageMetadata([occurrence()], relativePath),
  target_outcomes: [],
  persisted_draft_entries: null,
});

describe("occurrence-only scanner wire guards", () => {
  it("accepts valid TagInfo and occurrence values", () => {
    expect(isTagInfo(tagInfo())).toBe(true);
    expect(isMetadataOccurrence(occurrence())).toBe(true);
    expect(
      isMetadataOccurrence({
        ...occurrence(),
        id: { ...occurrence().id, copy: -1 },
      }),
    ).toBe(false);
  });

  it("requires exactly relative_path and occurrences", () => {
    expect(isImageMetadata(imageMetadata())).toBe(true);
    expect(isImageMetadata({ ...imageMetadata(), metadata: [] })).toBe(false);
    expect(isImageMetadata({ relative_path: "photo.jpg" })).toBe(false);
    expect(isImageMetadata({ relative_path: "", occurrences: [] })).toBe(false);
  });

  it("allows same-schema occurrences but rejects duplicate occurrence IDs", () => {
    const ifd0 = occurrence("JPEG-APP1-IFD0", 300);
    const ifd1 = occurrence("JPEG-APP1-IFD1", 72);
    expect(isImageMetadata(imageMetadata([ifd0, ifd1]))).toBe(true);
    expect(isImageMetadata(imageMetadata([ifd0, structuredClone(ifd0)]))).toBe(
      false,
    );
  });

  it("normalises occurrence batches by dropping malformed and duplicate IDs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const later = { ...occurrence(), id: { ...occurrence().id, copy: 1 } };
    const normalized = normalizeMetadataOccurrencesFromTauri([
      later,
      occurrence(),
      structuredClone(occurrence()),
      { bad: true },
    ]);
    expect(normalized.map((item) => item.id.copy)).toEqual([0, 1]);
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 2 invalid occurrence value(s)",
    );
  });
});

describe("target-aware apply wire", () => {
  it("accepts occurrence-only fresh metadata", () => {
    expect(targetApplyFileResultFromUnknown(fileResult())).toEqual(
      fileResult(),
    );
  });

  it("rejects the removed metadata field inside fresh_image_metadata", () => {
    const raw = structuredClone(fileResult()) as unknown as Record<string, any>;
    raw.fresh_image_metadata.metadata = [];
    expect(() => targetApplyFileResultFromUnknown(raw)).toThrow(
      /fresh_image_metadata must be null or complete valid ImageMetadata/,
    );
  });

  it("rejects fresh path mismatch and duplicate occurrence IDs", () => {
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        fresh_image_metadata: imageMetadata([occurrence()], "other.jpg"),
      }),
    ).toThrow(/does not match result path/);
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        fresh_image_metadata: imageMetadata([
          occurrence(),
          structuredClone(occurrence()),
        ]),
      }),
    ).toThrow(/duplicate occurrence ID/);
  });

  it("preserves result, progress and started outer contracts", () => {
    expect(
      targetApplyResultFromUnknown({
        files: [fileResult()],
        cancelled: false,
        aborted: false,
        abort_reason: null,
      }),
    ).toEqual({
      files: [fileResult()],
      cancelled: false,
      aborted: false,
      abort_reason: null,
    });
    expect(
      targetApplyProgressFromUnknown({
        current: 1,
        total: 1,
        result: fileResult(),
      }),
    ).toEqual({ current: 1, total: 1, result: fileResult() });
    expect(targetApplyStartedFromUnknown({ total: 2 })).toEqual({ total: 2 });
  });

  it("rejects invalid outer result and progress invariants", () => {
    expect(() =>
      targetApplyResultFromUnknown({
        files: [fileResult(), fileResult()],
        cancelled: false,
        aborted: false,
        abort_reason: null,
      }),
    ).toThrow(/duplicate file relative_path/);
    expect(() =>
      targetApplyProgressFromUnknown({
        current: 2,
        total: 1,
        result: fileResult(),
      }),
    ).toThrow(/current cannot exceed total/);
  });
});
