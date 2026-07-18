import { describe, expect, it } from "vitest";
import {
  GpsTargetDraftPlanError,
  planGpsTargetDraftBatch,
  validateGpsTargetDraftEntries,
} from "../gpsTargetDrafts";
import { GPS_IDS, knownMetadataWriteTarget } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const edit: MetadataDraftEdit = {
  intent: "Set",
  value: { kind: "Real", value: 52 },
};

function info(id: SchemaDefinitionId): TagInfo {
  return {
    id: structuredClone(id),
    group: "GPS",
    name: knownMetadataWriteTarget(id)!.tag_name,
    writable: true,
    kind: { kind: "Real" },
    description: null,
  };
}

function occurrence(
  id: SchemaDefinitionId = GPS_IDS.latitude,
  options: { path?: string; copy?: number; group1?: string } = {},
): MetadataOccurrence {
  const writeTarget = {
    ...knownMetadataWriteTarget(id)!,
    group1: options.group1 ?? knownMetadataWriteTarget(id)!.group1,
  };
  return {
    id: {
      document: null,
      path: options.path ?? "JPEG-APP1-GPS",
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(id),
    value: { kind: "Real", value: 51.5 },
    tag_info: info(id),
    observed_selector: structuredClone(writeTarget),
    write_target: structuredClone(writeTarget),
  };
}

function newTarget(group1 = "GPS"): MetadataDraftTarget {
  return {
    kind: "NewProperty",
    schema_id: structuredClone(GPS_IDS.latitude),
    write_target: {
      ...knownMetadataWriteTarget(GPS_IDS.latitude)!,
      group1,
    },
  };
}

function drafts(
  entries: Array<{ target: MetadataDraftTarget; edit: MetadataDraftEdit }>,
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [metadataDraftTargetSlotToken(entry.target), entry]),
  );
}

function expectCode(fn: () => unknown, code: GpsTargetDraftPlanError["code"]) {
  expect(fn).toThrowError(GpsTargetDraftPlanError);
  try {
    fn();
  } catch (error) {
    expect((error as GpsTargetDraftPlanError).code).toBe(code);
  }
}

describe("planGpsTargetDraftBatch", () => {
  it("constructs and defensively clones a complete existing target", () => {
    const source = occurrence();
    const [planned] = planGpsTargetDraftBatch(
      [{ id: GPS_IDS.latitude, edit }],
      [source],
    );
    expect(planned.target).toEqual({
      kind: "ExistingOccurrence",
      occurrence_id: source.id,
      schema_id: source.schema_id,
      write_target: source.write_target,
    });
    expect(planned.target).not.toBe(source.write_target);
  });

  it("constructs the registered default only when no target exists yet", () => {
    const [planned] = planGpsTargetDraftBatch(
      [{ id: GPS_IDS.latitude, edit }],
      [],
    );
    expect(planned.target).toEqual({
      kind: "NewProperty",
      schema_id: GPS_IDS.latitude,
      write_target: knownMetadataWriteTarget(GPS_IDS.latitude),
    });
  });

  it("rejects ambiguous authoritative target construction", () => {
    expectCode(
      () =>
        planGpsTargetDraftBatch(
          [{ id: GPS_IDS.latitude, edit }],
          [occurrence(), occurrence(GPS_IDS.latitude, { copy: 1 })],
        ),
      "multiple-occurrences",
    );
  });
});

describe("validateGpsTargetDraftEntries", () => {
  it("accepts a captured existing target despite an unrelated same-schema target", () => {
    const source = occurrence();
    const captured = planGpsTargetDraftBatch(
      [{ id: GPS_IDS.latitude, edit }],
      [source],
    )[0];
    const unrelated = newTarget("CustomGPS");
    expect(
      validateGpsTargetDraftEntries(
        [{ target: captured.target, edit }],
        [source],
        drafts([{ target: unrelated, edit }]),
      ),
    ).toEqual([{ target: captured.target, edit }]);
  });

  it("rejects the whole captured batch when one exact occurrence changes", () => {
    const latitude = occurrence();
    const longitude = occurrence(GPS_IDS.longitude);
    const planned = planGpsTargetDraftBatch(
      [
        { id: GPS_IDS.latitude, edit },
        { id: GPS_IDS.longitude, edit },
      ],
      [latitude, longitude],
    );
    const changed = {
      ...longitude,
      write_target: { ...longitude.write_target!, group1: "MovedGPS" },
    };
    expectCode(
      () =>
        validateGpsTargetDraftEntries(
          planned.map(({ target, edit: plannedEdit }) => ({
            target,
            edit: plannedEdit,
          })),
          [latitude, changed],
          undefined,
        ),
      "stale-target",
    );
  });

  it("keeps two same-schema New Property destinations independent", () => {
    const first = newTarget("CustomGPS1");
    const second = newTarget("CustomGPS2");
    expect(
      validateGpsTargetDraftEntries(
        [
          { target: first, edit },
          { target: second, edit },
        ],
        [],
        drafts([{ target: second, edit }]),
      ).map(({ target }) => target),
    ).toEqual([first, second]);
  });

  it("preserves a captured custom destination", () => {
    const target = newTarget("CustomGPS");
    const [validated] = validateGpsTargetDraftEntries(
      [{ target, edit }],
      [],
      undefined,
    );
    expect(validated.target.write_target.group1).toBe("CustomGPS");
  });

  it("rejects occupied and colliding exact destinations", () => {
    const target = newTarget();
    expectCode(
      () =>
        validateGpsTargetDraftEntries([{ target, edit }], [occurrence()], {}),
      "destination-occupied",
    );
    const other: MetadataDraftTarget = {
      ...target,
      schema_id: structuredClone(GPS_IDS.latitudeRef),
    };
    expectCode(
      () =>
        validateGpsTargetDraftEntries(
          [{ target, edit }],
          [],
          drafts([{ target: other, edit }]),
        ),
      "selector-collision",
    );
  });

  it("does not mutate inputs when validation fails", () => {
    const target = newTarget();
    const entries = [{ target, edit }];
    const before = structuredClone(entries);
    expectCode(
      () => validateGpsTargetDraftEntries(entries, [occurrence()], undefined),
      "destination-occupied",
    );
    expect(entries).toEqual(before);
  });
});

describe("target-first GPS regressions", () => {
  it("captures one exact staged New Property destination for a missing schema", () => {
    const custom = newTarget("CustomGPS");
    const [planned] = planGpsTargetDraftBatch(
      [{ id: GPS_IDS.latitude, edit }],
      [],
      drafts([{ target: custom, edit }]),
    );
    expect(planned.target).toEqual(custom);
  });

  it("rejects multiple staged destinations instead of first-selecting or defaulting", () => {
    const first = newTarget("CustomGPS1");
    const second = newTarget("CustomGPS2");
    expectCode(
      () =>
        planGpsTargetDraftBatch(
          [{ id: GPS_IDS.latitude, edit }],
          [],
          drafts([
            { target: first, edit },
            { target: second, edit },
          ]),
        ),
      "ambiguous-staged-target",
    );
  });

  it("rejects duplicate complete occurrence IDs across different schemas independent of order", () => {
    const first = occurrence(GPS_IDS.latitude);
    const second = occurrence(GPS_IDS.longitude, { group1: "GPS" });
    second.id = structuredClone(first.id);
    for (const occurrences of [
      [first, second],
      [second, first],
    ]) {
      expectCode(
        () =>
          planGpsTargetDraftBatch(
            [{ id: GPS_IDS.latitude, edit }],
            occurrences,
          ),
        "duplicate-occurrence-id",
      );
    }
  });

  it("rejects selector collisions within the incoming batch without mutating input", () => {
    const first = newTarget("CustomGPS");
    const second: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(GPS_IDS.longitude),
      write_target: {
        ...knownMetadataWriteTarget(GPS_IDS.longitude)!,
        group1: "customgps",
        tag_name: first.write_target.tag_name.toUpperCase(),
        group7: first.write_target.group7,
      },
    };
    const entries = [
      { target: first, edit },
      { target: second, edit },
    ];
    const before = structuredClone(entries);
    expectCode(
      () => validateGpsTargetDraftEntries(entries, [], undefined),
      "selector-collision",
    );
    expect(entries).toEqual(before);
  });

  it("accepts distinct incoming selectors", () => {
    const first = newTarget("CustomGPS");
    const second: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(GPS_IDS.longitude),
      write_target: {
        ...knownMetadataWriteTarget(GPS_IDS.longitude)!,
        group1: "CustomGPS",
      },
    };
    expect(
      validateGpsTargetDraftEntries(
        [
          { target: first, edit },
          { target: second, edit },
        ],
        [],
        undefined,
      ),
    ).toHaveLength(2);
  });
});

describe("missing GPS schema staged-target hierarchy", () => {
  const staleTarget = (): MetadataDraftTarget => {
    const source = occurrence();
    return {
      kind: "ExistingOccurrence",
      occurrence_id: structuredClone(source.id),
      schema_id: structuredClone(source.schema_id),
      write_target: structuredClone(source.write_target!),
    };
  };

  it("rejects one stale ExistingOccurrence target", () => {
    expectCode(
      () =>
        planGpsTargetDraftBatch(
          [{ id: GPS_IDS.latitude, edit }],
          [],
          drafts([{ target: staleTarget(), edit }]),
        ),
      "stale-staged-target",
    );
  });

  it("rejects a New Property target combined with a stale ExistingOccurrence", () => {
    expectCode(
      () =>
        planGpsTargetDraftBatch(
          [{ id: GPS_IDS.latitude, edit }],
          [],
          drafts([
            { target: newTarget("CustomGPS"), edit },
            { target: staleTarget(), edit },
          ]),
        ),
      "stale-staged-target",
    );
  });

  it("rejects several stale ExistingOccurrence targets independent of insertion order", () => {
    const first = staleTarget();
    const second = staleTarget();
    if (second.kind === "ExistingOccurrence") second.occurrence_id.copy = 1;
    for (const targets of [
      [first, second],
      [second, first],
    ]) {
      expectCode(
        () =>
          planGpsTargetDraftBatch(
            [{ id: GPS_IDS.latitude, edit }],
            [],
            drafts(targets.map((target) => ({ target, edit }))),
          ),
        "stale-staged-target",
      );
    }
  });

  it("preserves one staged New Property target and otherwise uses the registered default", () => {
    const custom = newTarget("CustomGPS");
    expect(
      planGpsTargetDraftBatch(
        [{ id: GPS_IDS.latitude, edit }],
        [],
        drafts([{ target: custom, edit }]),
      )[0].target,
    ).toEqual(custom);
    expect(
      planGpsTargetDraftBatch([{ id: GPS_IDS.latitude, edit }], [])[0].target,
    ).toEqual({
      kind: "NewProperty",
      schema_id: GPS_IDS.latitude,
      write_target: knownMetadataWriteTarget(GPS_IDS.latitude),
    });
  });
});
