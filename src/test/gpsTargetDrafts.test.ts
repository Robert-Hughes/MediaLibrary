import { describe, expect, it } from "vitest";
import {
  GpsTargetDraftPlanError,
  planGpsTargetDraftBatchV5,
} from "../gpsTargetDrafts";
import { GPS_IDS } from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const setEdit = (value = 52): MetadataDraftEdit => ({
  intent: "Set",
  value: { kind: "Real", value },
});

function info(
  id: SchemaDefinitionId,
  options: { writable?: boolean; name?: string } = {},
): TagInfo {
  return {
    id: structuredClone(id),
    group: "GPS",
    name: options.name ?? "GPSLatitude",
    writable: options.writable ?? true,
    kind: { kind: "Real" },
    description: null,
  };
}

function occurrence(
  id: SchemaDefinitionId = GPS_IDS.latitude,
  options: {
    path?: string;
    copy?: number;
    tagInfo?: TagInfo | null;
    writable?: boolean;
    writeTarget?: { group1: string; tag_name: string } | null;
  } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: options.path ?? "JPEG-APP1-GPS",
      tag_id: id.tag_id,
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(id),
    value: { kind: "Real", value: 51.5 },
    tag_info:
      options.tagInfo === undefined
        ? info(id, { writable: options.writable })
        : options.tagInfo,
    write_target:
      options.writeTarget === undefined
        ? { group1: "GPS", tag_name: "GPSLatitude" }
        : options.writeTarget,
  };
}

function expectCode(fn: () => unknown, code: GpsTargetDraftPlanError["code"]) {
  try {
    fn();
    throw new Error("Expected planner to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(GpsTargetDraftPlanError);
    expect((error as GpsTargetDraftPlanError).code).toBe(code);
  }
}

describe("planGpsTargetDraftBatchV5", () => {
  it("preserves exact existing occurrence identity, embedded schema and selector", () => {
    const source = occurrence();
    const [planned] = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitude, edit: setEdit() }],
      [source],
      undefined,
    );
    expect(planned.target).toEqual({
      kind: "ExistingOccurrence",
      occurrence_id: source.id,
      schema_id: source.tag_info!.id,
      write_target: source.write_target,
    });
    expect(planned.target).not.toBe(source.write_target);
  });

  it("creates an exact NewProperty target for a missing paired field", () => {
    const [planned] = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitudeRef, edit: setEdit() }],
      [],
      undefined,
    );
    expect(planned.target).toEqual({
      kind: "NewProperty",
      schema_id: GPS_IDS.latitudeRef,
    });
  });

  it("rejects empty, duplicate, non-GPS and loading batches", () => {
    expectCode(
      () => planGpsTargetDraftBatchV5([], [], undefined),
      "empty-batch",
    );
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [
            { id: GPS_IDS.latitude, edit: setEdit() },
            { id: structuredClone(GPS_IDS.latitude), edit: setEdit() },
          ],
          [],
          undefined,
        ),
      "duplicate-schema",
    );
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [
            {
              id: { table: "XMP::dc", tag_id: "title" },
              edit: setEdit(),
            },
          ],
          [],
          undefined,
        ),
      "non-gps-schema",
    );
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          "loading",
          undefined,
        ),
      "occurrences-loading",
    );
  });

  it("rejects multiple authoritative occurrences without selecting a sibling", () => {
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [
            occurrence(GPS_IDS.latitude, { path: "GPS-Copy0" }),
            occurrence(GPS_IDS.latitude, { path: "GPS-IFD0", copy: 1 }),
          ],
          undefined,
        ),
      "multiple-occurrences",
    );
  });

  it("rejects missing TagInfo, read-only TagInfo and missing runtime selectors", () => {
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [occurrence(GPS_IDS.latitude, { tagInfo: null })],
          undefined,
        ),
      "untargetable-occurrence",
    );
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [occurrence(GPS_IDS.latitude, { writable: false })],
          undefined,
        ),
      "untargetable-occurrence",
    );
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [occurrence(GPS_IDS.latitude, { writeTarget: null })],
          undefined,
        ),
      "untargetable-occurrence",
    );
  });

  it("accepts replacing the one complete owner equal to the planned target", () => {
    const source = occurrence();
    const first = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitude, edit: setEdit(1) }],
      [source],
      undefined,
    )[0];
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("a.jpg", first.target, first.edit);
    const [replacement] = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitude, edit: setEdit(2) }],
      [source],
      store.getMetadataFile("a.jpg"),
    );
    expect(replacement.target).toEqual(first.target);
    expect(replacement.edit).toEqual(setEdit(2));
  });

  it("rejects NewProperty/existing and different-occurrence ownership mismatches", () => {
    const source = occurrence();
    const newTarget: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: GPS_IDS.latitude,
    };
    const newOwner = {
      [metadataDraftTargetSlotToken(newTarget)]: {
        target: newTarget,
        edit: setEdit(),
      },
    };
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [source],
          newOwner,
        ),
      "incompatible-target-owner",
    );

    const other = occurrence(GPS_IDS.latitude, { path: "Other-GPS" });
    const otherPlan = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitude, edit: setEdit() }],
      [other],
      undefined,
    )[0];
    const otherOwner = {
      [metadataDraftTargetSlotToken(otherPlan.target)]: {
        target: otherPlan.target,
        edit: setEdit(),
      },
    };
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [source],
          otherOwner,
        ),
      "incompatible-target-owner",
    );
  });

  it("rejects multiple same-schema target owners", () => {
    const existing = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitude, edit: setEdit() }],
      [occurrence()],
      undefined,
    )[0].target;
    const created: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: GPS_IDS.latitude,
    };
    const owners = {
      [metadataDraftTargetSlotToken(existing)]: {
        target: existing,
        edit: setEdit(),
      },
      [metadataDraftTargetSlotToken(created)]: {
        target: created,
        edit: setEdit(),
      },
    };
    expectCode(
      () =>
        planGpsTargetDraftBatchV5(
          [{ id: GPS_IDS.latitude, edit: setEdit() }],
          [occurrence()],
          owners,
        ),
      "multiple-target-owners",
    );
  });

  it("keeps an absent schema index distinct from index zero", () => {
    const indexedTarget: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: { ...GPS_IDS.latitude, index: 0 },
    };
    const owners = {
      [metadataDraftTargetSlotToken(indexedTarget)]: {
        target: indexedTarget,
        edit: setEdit(),
      },
    };
    const [planned] = planGpsTargetDraftBatchV5(
      [{ id: GPS_IDS.latitude, edit: setEdit() }],
      [],
      owners,
    );
    expect(planned.target).toEqual({
      kind: "NewProperty",
      schema_id: GPS_IDS.latitude,
    });
  });

  it("clones all outputs and mutates no input or store object", () => {
    const source = occurrence();
    const edits = [
      {
        id: structuredClone(GPS_IDS.latitude),
        edit: { ...setEdit(), display: "fifty-two" },
      },
    ];
    const beforeEdits = structuredClone(edits);
    const beforeOccurrences = structuredClone([source]);
    const planned = planGpsTargetDraftBatchV5(edits, [source], undefined);
    planned[0].id.tag_id = "changed";
    planned[0].edit.display = "changed";
    expect(edits).toEqual(beforeEdits);
    expect([source]).toEqual(beforeOccurrences);
  });
});
