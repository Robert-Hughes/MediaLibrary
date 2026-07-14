// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  ImageMetadata,
  MetadataApplyFileResultV5,
  MetadataDraftEntryV5,
  MetadataDraftReconciliation,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataTargetOutcome,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  normalizeMetadataFromTauri,
  normalizeMetadataOccurrencesFromTauri,
} from "../utils/scanEvents";
import {
  isImageMetadata,
  isMetadataDraftReconciliation,
  isMetadataEntry,
  isMetadataOccurrence,
  isMetadataTargetOutcome,
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

const occurrence = (): MetadataOccurrence => ({
  id: {
    document: null,
    path: "JPEG-APP1-IFD0",
    tag_id: "282",
    copy: 0,
  },
  value: { kind: "Rational", value: { numerator: 300, denominator: 1 } },
  tag_info: tagInfo(),
  write_target: { group1: "IFD0", tag_name: "XResolution" },
});

const imageMetadata = (relativePath = "photo.jpg"): ImageMetadata => ({
  relative_path: relativePath,
  occurrences: [occurrence()],
  metadata: [
    {
      id: schema(),
      value: {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [{ kind: "Text", value: "landscape" }],
        },
      },
    },
  ],
});

const existing = (
  schemaId: SchemaDefinitionId = schema(),
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> => ({
  kind: "ExistingOccurrence",
  occurrence_id: { ...occurrence().id },
  schema_id: schemaId,
  write_target: { group1: "IFD0", tag_name: "XResolution" },
});

const created = (
  schemaId: SchemaDefinitionId = schema(),
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> => ({
  kind: "NewProperty",
  schema_id: schemaId,
});

const entry = (
  target: MetadataDraftTarget = existing(),
): MetadataDraftEntryV5 => ({
  target,
  edit: {
    intent: "Set",
    value: {
      kind: "Struct",
      value: { nested: { kind: "Integer", value: 7 } },
    },
    display: "seven",
  },
});

const outcome = (
  target: MetadataDraftTarget = existing(),
  draftReconciliation: MetadataDraftReconciliation = { kind: "Keep" },
): MetadataTargetOutcome => ({
  target,
  draft_reconciliation: draftReconciliation,
  display_name: "IFD0:XResolution",
  kind: "Match",
  sent: { kind: "Integer", value: 7 },
  before: null,
  observed: { kind: "Integer", value: 7 },
  message: null,
});

const fileResult = (relativePath = "photo.jpg"): MetadataApplyFileResultV5 => ({
  relative_path: relativePath,
  applied: true,
  error: null,
  warning: null,
  fresh_image_metadata: imageMetadata(relativePath),
  target_outcomes: [outcome()],
  persisted_draft_entries: [entry()],
});

describe("shared scanner-domain guards", () => {
  it("accepts valid TagInfo and rejects malformed TagInfo", () => {
    expect(isTagInfo(tagInfo())).toBe(true);
    expect(
      isTagInfo({ ...tagInfo(), kind: { kind: "Integer", data: {} } }),
    ).toBe(false);
  });

  it("validates occurrence identity and recursive semantic values", () => {
    expect(isMetadataOccurrence(occurrence())).toBe(true);
    expect(
      isMetadataOccurrence({
        ...occurrence(),
        id: { ...occurrence().id, copy: -1 },
      }),
    ).toBe(false);
    expect(
      isMetadataOccurrence({
        ...occurrence(),
        value: { kind: "List", value: { list_kind: "Bag", items: [NaN] } },
      }),
    ).toBe(false);
  });

  it("validates compatibility entries and complete ImageMetadata", () => {
    expect(isMetadataEntry(imageMetadata().metadata[0])).toBe(true);
    expect(isImageMetadata(imageMetadata())).toBe(true);
    expect(
      isImageMetadata({
        ...imageMetadata(),
        occurrences: [
          { ...occurrence(), id: { ...occurrence().id, copy: -1 } },
        ],
      }),
    ).toBe(false);
    expect(
      isImageMetadata({
        ...imageMetadata(),
        metadata: [{ id: schema(), value: { kind: "Real", value: NaN } }],
      }),
    ).toBe(false);
  });

  it("retains lossy scan drop, deduplicate, sort, and warning behaviour", () => {
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

    expect(
      normalizeMetadataFromTauri([
        imageMetadata().metadata[0],
        { id: schema(), value: { kind: "Integer", value: 1.5 } },
      ]),
    ).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "[metadata] Dropped 1 non-semantic metadata payload value(s)",
    );
    warn.mockRestore();
  });
});

describe("reconciliation and target-outcome guards", () => {
  it.each([
    { kind: "Clear" },
    { kind: "Keep" },
    { kind: "Replace", target: existing() },
    { kind: "Blocked", reason: "stale" },
  ])("accepts generated reconciliation variant %#", (value) => {
    expect(isMetadataDraftReconciliation(value)).toBe(true);
  });

  it("rejects unknown and malformed reconciliation variants", () => {
    expect(isMetadataDraftReconciliation({ kind: "Other" })).toBe(false);
    expect(isMetadataDraftReconciliation({ kind: "Replace", target: {} })).toBe(
      false,
    );
    expect(
      isMetadataDraftReconciliation({ kind: "Clear", reason: "extra" }),
    ).toBe(false);
  });

  it("accepts a complete outcome and rejects malformed fields", () => {
    expect(isMetadataTargetOutcome(outcome())).toBe(true);
    expect(isMetadataTargetOutcome({ ...outcome(), target: {} })).toBe(false);
    expect(
      isMetadataTargetOutcome({
        ...outcome(),
        sent: { kind: "Real", value: NaN },
      }),
    ).toBe(false);
    expect(
      isMetadataTargetOutcome({
        ...outcome(),
        observed: { kind: "Integer", value: 1.5 },
      }),
    ).toBe(false);
    expect(isMetadataTargetOutcome({ ...outcome(), message: 7 })).toBe(false);
  });

  it("enforces NewProperty-to-ExistingOccurrence same-schema replacement", () => {
    expect(
      isMetadataTargetOutcome(
        outcome(created(), { kind: "Replace", target: existing() }),
      ),
    ).toBe(true);
    expect(
      isMetadataTargetOutcome(
        outcome(existing(), { kind: "Replace", target: existing() }),
      ),
    ).toBe(false);
    expect(
      isMetadataTargetOutcome(
        outcome(created(), { kind: "Replace", target: created() }),
      ),
    ).toBe(false);
    expect(
      isMetadataTargetOutcome(
        outcome(created(), {
          kind: "Replace",
          target: existing({ ...schema(), tag_id: "different" }),
        }),
      ),
    ).toBe(false);
    expect(
      isMetadataTargetOutcome(
        outcome(created(schema()), {
          kind: "Replace",
          target: existing(schema(0)),
        }),
      ),
    ).toBe(false);
  });
});

describe("schema-v5 apply file-result parser", () => {
  it("accepts successful and failed results", () => {
    expect(targetApplyFileResultFromUnknown(fileResult())).toEqual(
      fileResult(),
    );
    const failed = {
      ...fileResult(),
      applied: false,
      error: "write failed",
      fresh_image_metadata: null,
      persisted_draft_entries: null,
    };
    expect(targetApplyFileResultFromUnknown(failed)).toEqual(failed);
  });

  it("enforces applied/error and fresh-metadata path invariants", () => {
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        applied: true,
        error: "failed",
      }),
    ).toThrow(/applied must be true exactly/);
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        applied: false,
        error: null,
      }),
    ).toThrow(/applied must be true exactly/);
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        fresh_image_metadata: imageMetadata("other.jpg"),
      }),
    ).toThrow(/other\.jpg.*does not match/);
  });

  it("rejects duplicate original outcome slots, including changed snapshots", () => {
    const same = existing();
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        target_outcomes: [outcome(same), outcome(structuredClone(same))],
      }),
    ).toThrow(
      /photo\.jpg.*duplicate target outcome slot.*first target|photo\.jpg.*duplicate target outcome slot/s,
    );

    const changed = {
      ...existing(),
      schema_id: { ...schema(), tag_id: "changed" },
      write_target: { group1: "XMP", tag_name: "Changed" },
    };
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        target_outcomes: [outcome(existing()), outcome(changed)],
      }),
    ).toThrow(/duplicate target outcome slot/);
  });

  it("validates null, empty, non-empty, malformed, and duplicate persisted entries", () => {
    expect(
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        persisted_draft_entries: null,
      }).persisted_draft_entries,
    ).toBeNull();
    expect(
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        persisted_draft_entries: [],
      }).persisted_draft_entries,
    ).toEqual([]);
    expect(
      targetApplyFileResultFromUnknown(fileResult()).persisted_draft_entries,
    ).toEqual([entry()]);
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        persisted_draft_entries: [{ target: existing(), edit: {} }],
      }),
    ).toThrow(/persisted_draft_entries\[0\]/);
    expect(() =>
      targetApplyFileResultFromUnknown({
        ...fileResult(),
        persisted_draft_entries: [entry(), entry(structuredClone(existing()))],
      }),
    ).toThrow(/Duplicate target draft slot/);
  });

  it("preserves complete targets, edits, and reserved-looking paths", () => {
    const raw = {
      ...fileResult("__proto__"),
      persisted_draft_entries: [entry(existing())],
    };
    const parsed = targetApplyFileResultFromUnknown(raw);
    expect(parsed.relative_path).toBe("__proto__");
    expect(parsed.persisted_draft_entries).toEqual(raw.persisted_draft_entries);
    expect(parsed.target_outcomes).toEqual(raw.target_outcomes);
  });
});

describe("batch-result and event payload parsers", () => {
  it("accepts empty, cancelled, and aborted batches", () => {
    expect(
      targetApplyResultFromUnknown({
        files: [],
        cancelled: false,
        aborted: false,
        abort_reason: null,
      }),
    ).toEqual({
      files: [],
      cancelled: false,
      aborted: false,
      abort_reason: null,
    });
    expect(
      targetApplyResultFromUnknown({
        files: [],
        cancelled: true,
        aborted: false,
        abort_reason: null,
      }).cancelled,
    ).toBe(true);
    expect(
      targetApplyResultFromUnknown({
        files: [],
        cancelled: false,
        aborted: true,
        abort_reason: "fatal",
      }).abort_reason,
    ).toBe("fatal");
  });

  it("enforces cancellation/abort invariants and unique file paths", () => {
    expect(() =>
      targetApplyResultFromUnknown({
        files: [],
        cancelled: true,
        aborted: true,
        abort_reason: "fatal",
      }),
    ).toThrow(/cannot both/);
    expect(() =>
      targetApplyResultFromUnknown({
        files: [],
        cancelled: false,
        aborted: true,
        abort_reason: null,
      }),
    ).toThrow(/exactly when/);
    expect(() =>
      targetApplyResultFromUnknown({
        files: [],
        cancelled: false,
        aborted: false,
        abort_reason: "fatal",
      }),
    ).toThrow(/exactly when/);
    expect(() =>
      targetApplyResultFromUnknown({
        files: [fileResult(), fileResult()],
        cancelled: false,
        aborted: false,
        abort_reason: null,
      }),
    ).toThrow(/duplicate file relative_path/);
  });

  it("preserves file order", () => {
    const parsed = targetApplyResultFromUnknown({
      files: [fileResult("z.jpg"), fileResult("a.jpg")],
      cancelled: false,
      aborted: false,
      abort_reason: null,
    });
    expect(parsed.files.map((file) => file.relative_path)).toEqual([
      "z.jpg",
      "a.jpg",
    ]);
  });

  it("accepts started total zero and valid progress", () => {
    expect(targetApplyStartedFromUnknown({ total: 0 })).toEqual({ total: 0 });
    const parsed = targetApplyProgressFromUnknown({
      current: 1,
      total: 2,
      result: fileResult(),
    });
    expect(parsed.current).toBe(1);
    expect(parsed.result.target_outcomes).toEqual(fileResult().target_outcomes);
    expect(parsed.result.fresh_image_metadata?.occurrences).toEqual(
      imageMetadata().occurrences,
    );
    expect(parsed.result.fresh_image_metadata?.metadata).toEqual(
      imageMetadata().metadata,
    );
  });

  it.each([
    { current: 0, total: 1 },
    { current: 2, total: 1 },
    { current: 1, total: Number.MAX_SAFE_INTEGER + 1 },
    { current: 1.5, total: 2 },
    { current: 1, total: Infinity },
  ])("rejects invalid progress counters %#", ({ current, total }) => {
    expect(() =>
      targetApplyProgressFromUnknown({ current, total, result: fileResult() }),
    ).toThrow();
  });

  it("rejects malformed nested progress results", () => {
    expect(() =>
      targetApplyProgressFromUnknown({
        current: 1,
        total: 1,
        result: { ...fileResult(), target_outcomes: [{ bad: true }] },
      }),
    ).toThrow(/target_outcomes\[0\]/);
  });
});
