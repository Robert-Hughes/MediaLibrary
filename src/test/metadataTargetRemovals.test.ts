import { describe, expect, it } from "vitest";
import {
  MetadataTargetRemovalPlanError,
  planMetadataTargetRemovals,
} from "../metadataRemovalTargets";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataTargetDraftEntry,
  SchemaDefinitionId,
} from "../types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetSlotToken,
} from "../utils/metadataDraftTarget";

const schema: SchemaDefinitionId = { table: "Exif::Main", tag_id: "282" };

function occurrence(
  path: string,
  group1: string,
  copy = 0,
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path,
      runtime_tag_id: "282",
      tag_id_scope: {
        table: "Exif::Main",
        tag_id: "282",
        index: null,
      },
      copy,
    },
    schema_id: structuredClone(schema),
    value: { kind: "Integer", value: group1 === "IFD0" ? 300 : 72 },
    tag_info: {
      id: structuredClone(schema),
      group: group1,
      name: "XResolution",
      writable: true,
      kind: { kind: "Integer", data: { min: null, max: null } },
      description: null,
    },
    observed_selector: {
      group1,
      group7: "ID-282",
      tag_name: "XResolution",
    },
    write_target: {
      group1,
      group7: "ID-282",
      tag_name: "XResolution",
    },
    ...overrides,
  };
}

function existingTarget(
  source: MetadataOccurrence,
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> {
  const resolution = existingOccurrenceTargetFromOccurrence(source);
  if (resolution.kind !== "targetable") throw new Error(resolution.reason);
  return resolution.target;
}

function newTarget(
  group1: string,
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> {
  return {
    kind: "NewProperty",
    schema_id: structuredClone(schema),
    write_target: {
      group1,
      group7: "ID-282",
      tag_name: "XResolution",
    },
  };
}

function draft(
  target: MetadataDraftTarget,
  edit: MetadataDraftEdit = {
    intent: "Set",
    value: { kind: "Integer", value: 301 },
  },
): MetadataTargetDraftEntry {
  return { target: structuredClone(target), edit: structuredClone(edit) };
}

function collection(
  entries: readonly MetadataTargetDraftEntry[],
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [metadataDraftTargetSlotToken(entry.target), entry]),
  );
}

function expectCode(
  fn: () => unknown,
  code: MetadataTargetRemovalPlanError["code"],
) {
  expect(fn).toThrowError(MetadataTargetRemovalPlanError);
  try {
    fn();
  } catch (error) {
    expect((error as MetadataTargetRemovalPlanError).code).toBe(code);
  }
}

describe("planMetadataTargetRemovals", () => {
  it("plans an exact existing occurrence deletion", () => {
    const current = occurrence("JPEG-APP1-IFD0", "IFD0");
    const target = existingTarget(current);

    expect(
      planMetadataTargetRemovals({
        targets: [target],
        occurrences: [current],
        targetDrafts: undefined,
      }),
    ).toEqual({
      upserts: [{ target, edit: { intent: "Delete", value: null } }],
      deletes: [],
      noops: [],
    });
  });

  it("cancels only the exact New Property target", () => {
    const target = newTarget("XMP-custom");

    expect(
      planMetadataTargetRemovals({
        targets: [target],
        occurrences: [],
        targetDrafts: collection([draft(target)]),
      }),
    ).toEqual({ upserts: [], deletes: [target], noops: [] });
  });

  it("returns an exact no-op for an already-staged Delete", () => {
    const current = occurrence("JPEG-APP1-IFD0", "IFD0");
    const target = existingTarget(current);

    expect(
      planMetadataTargetRemovals({
        targets: [target],
        occurrences: [current],
        targetDrafts: collection([
          draft(target, { intent: "Delete", value: null }),
        ]),
      }),
    ).toEqual({ upserts: [], deletes: [], noops: [target] });
  });

  it("rejects a changed schema snapshot", () => {
    const current = occurrence("JPEG-APP1-IFD0", "IFD0");
    const changed = existingTarget(current);
    changed.schema_id = { ...changed.schema_id, index: 0 };

    expectCode(
      () =>
        planMetadataTargetRemovals({
          targets: [changed],
          occurrences: [current],
          targetDrafts: undefined,
        }),
      "changed-schema-snapshot",
    );
  });

  it("rejects a changed selector snapshot", () => {
    const current = occurrence("JPEG-APP1-IFD0", "IFD0");
    const changed = existingTarget(current);
    changed.write_target.group1 = "IFD1";

    expectCode(
      () =>
        planMetadataTargetRemovals({
          targets: [changed],
          occurrences: [current],
          targetDrafts: undefined,
        }),
      "changed-selector-snapshot",
    );
  });

  it("rejects duplicate logical slots before planning", () => {
    const current = occurrence("JPEG-APP1-IFD0", "IFD0");
    const target = existingTarget(current);

    expectCode(
      () =>
        planMetadataTargetRemovals({
          targets: [target, structuredClone(target)],
          occurrences: [current],
          targetDrafts: undefined,
        }),
      "duplicate-target-slot",
    );
  });

  it("rejects a missing exact occurrence", () => {
    const target = existingTarget(occurrence("missing", "IFD0"));

    expectCode(
      () =>
        planMetadataTargetRemovals({
          targets: [target],
          occurrences: [],
          targetDrafts: undefined,
        }),
      "missing-occurrence",
    );
  });

  it("rejects duplicated authoritative occurrence IDs", () => {
    const current = occurrence("duplicate", "IFD0");
    const duplicate = structuredClone(current);
    duplicate.value = { kind: "Integer", value: 72 };
    const target = existingTarget(current);

    expectCode(
      () =>
        planMetadataTargetRemovals({
          targets: [target],
          occurrences: [current, duplicate],
          targetDrafts: undefined,
        }),
      "duplicate-occurrence-id",
    );
  });

  it("fails atomically when any selected target is unsafe", () => {
    const current = occurrence("present", "IFD0");
    const valid = existingTarget(current);
    const missing = existingTarget(occurrence("missing", "IFD1", 1));
    const input = {
      targets: [valid, missing],
      occurrences: [current],
      targetDrafts: undefined,
    };
    const snapshot = structuredClone(input);

    expectCode(() => planMetadataTargetRemovals(input), "missing-occurrence");
    expect(input).toEqual(snapshot);
  });

  it("keeps IFD0 and IFD1 same-schema occurrences independent", () => {
    const ifd0 = occurrence("JPEG-APP1-IFD0", "IFD0");
    const ifd1 = occurrence("JPEG-APP1-IFD1", "IFD1", 1);
    const target0 = existingTarget(ifd0);

    const result = planMetadataTargetRemovals({
      targets: [target0],
      occurrences: [ifd0, ifd1],
      targetDrafts: undefined,
    });

    expect(result.upserts).toEqual([
      { target: target0, edit: { intent: "Delete", value: null } },
    ]);
  });

  it("keeps same-schema custom New Property destinations independent", () => {
    const first = newTarget("XMP-first");
    const second = newTarget("XMP-second");
    const drafts = collection([draft(first), draft(second)]);

    const result = planMetadataTargetRemovals({
      targets: [second],
      occurrences: [],
      targetDrafts: drafts,
    });

    expect(result).toEqual({ upserts: [], deletes: [second], noops: [] });
  });

  it("rejects a stale complete target owning the requested slot", () => {
    const current = occurrence("JPEG-APP1-IFD0", "IFD0");
    const target = existingTarget(current);
    const stale = structuredClone(target);
    stale.write_target.group1 = "IFD1";

    expectCode(
      () =>
        planMetadataTargetRemovals({
          targets: [target],
          occurrences: [current],
          targetDrafts: collection([draft(stale)]),
        }),
      "stale-target-owner",
    );
  });
});
