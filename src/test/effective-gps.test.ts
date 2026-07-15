// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GPS_IDS } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import type {
  MetadataDraftCollection,
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { mockDrafts, mockMetadata } from "./factories";

const BASE_RAW = {
  "GPS:GPSLatitude": 51,
  "GPS:GPSLatitudeRef": "N",
  "GPS:GPSLongitude": 1,
  "GPS:GPSLongitudeRef": "E",
};

function valueFor(metadataValue: unknown): MetadataValue {
  if (typeof metadataValue === "number") {
    return { kind: "Real", value: metadataValue };
  }
  return { kind: "Text", value: String(metadataValue) };
}

function occurrence(
  id: SchemaDefinitionId,
  value: MetadataValue,
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: `JPEG-APP1-GPS-${id.tag_id}`,
      tag_id: id.tag_id,
      copy: 0,
    },
    value,
    tag_info: {
      id,
      group: "GPS",
      name: id.tag_id,
      writable: true,
      kind: { kind: value.kind } as never,
      description: null,
    },
    write_target: { group1: "GPS", tag_name: id.tag_id },
    ...overrides,
  };
}

function baseOccurrences(): MetadataOccurrence[] {
  return [
    occurrence(GPS_IDS.latitude, valueFor(51)),
    occurrence(GPS_IDS.latitudeRef, valueFor("N")),
    occurrence(GPS_IDS.longitude, valueFor(1)),
    occurrence(GPS_IDS.longitudeRef, valueFor("E")),
  ];
}

function existingEntry(
  current: MetadataOccurrence,
  edit: MetadataDraftEdit,
): MetadataDraftEntryV5 & {
  target: Extract<
    MetadataDraftEntryV5["target"],
    { kind: "ExistingOccurrence" }
  >;
} {
  const target = existingOccurrenceTargetFromOccurrence(current);
  if (target.kind !== "targetable") throw new Error(target.reason);
  return { target: target.target, edit };
}

function targets(...entries: MetadataDraftEntryV5[]): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry, index) => [String(index), entry]),
  );
}

function set(value: MetadataValue): MetadataDraftEdit {
  return { intent: "Set", value };
}

function resolve(
  overrides: {
    metadata?: ReturnType<typeof mockMetadata>;
    occurrences?: MetadataOccurrence[] | "loading";
    legacyDrafts?: MetadataDraftCollection;
    targetDrafts?: TargetDraftCollection;
  } = {},
) {
  return resolveEffectiveGpsForFile({
    metadata: overrides.metadata ?? mockMetadata(BASE_RAW),
    occurrences: overrides.occurrences ?? baseOccurrences(),
    legacyDrafts: overrides.legacyDrafts,
    targetDrafts: overrides.targetDrafts,
  });
}

describe("resolveEffectiveGpsForFile", () => {
  it("resolves on-disk raw GPS normally", () => {
    expect(resolve()).toEqual({ lat: 51, lon: 1 });
  });

  it("returns null coordinates when compatibility metadata is unavailable", () => {
    expect(
      resolveEffectiveGpsForFile({
        metadata: undefined,
        occurrences: baseOccurrences(),
        legacyDrafts: mockDrafts({ "GPS:GPSLatitude": 52 }),
        targetDrafts: undefined,
      }),
    ).toEqual({ lat: null, lon: null });
  });

  it("overlays uniquely resolved authoritative occurrence values", () => {
    const occurrences = baseOccurrences();
    occurrences[0] = occurrence(GPS_IDS.latitude, valueFor(52));
    occurrences[2] = occurrence(GPS_IDS.longitude, valueFor(2));
    expect(resolve({ occurrences })).toEqual({ lat: 52, lon: 2 });
  });

  it("keeps schema-v4 latitude and longitude drafts authoritative", () => {
    expect(
      resolve({
        legacyDrafts: mockDrafts({
          "GPS:GPSLatitude": 48.8584,
          "GPS:GPSLongitude": 2.2945,
        }),
      }),
    ).toEqual({ lat: 48.8584, lon: 2.2945 });
  });

  it("overlays valid schema-v5 ExistingOccurrence coordinate drafts", () => {
    const occurrences = baseOccurrences();
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(
          existingEntry(occurrences[0], set(valueFor(52))),
          existingEntry(occurrences[2], set(valueFor(2))),
        ),
      }),
    ).toEqual({ lat: 52, lon: 2 });
  });

  it("uses schema-v5 reference drafts to change coordinate signs", () => {
    const occurrences = baseOccurrences();
    expect(
      resolve({
        occurrences,
        targetDrafts: targets(
          existingEntry(occurrences[1], set(valueFor("S"))),
          existingEntry(occurrences[3], set(valueFor("W"))),
        ),
      }),
    ).toEqual({ lat: -51, lon: -1 });
  });

  it("uses missing reference fields represented by NewProperty targets", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51,
      "GPS:GPSLongitude": 1,
    });
    const occurrences = [
      occurrence(GPS_IDS.latitude, valueFor(51)),
      occurrence(GPS_IDS.longitude, valueFor(1)),
    ];
    expect(
      resolve({
        metadata,
        occurrences,
        targetDrafts: targets(
          {
            target: { kind: "NewProperty", schema_id: GPS_IDS.latitudeRef },
            edit: set(valueFor("S")),
          },
          {
            target: { kind: "NewProperty", schema_id: GPS_IDS.longitudeRef },
            edit: set(valueFor("W")),
          },
        ),
      }),
    ).toEqual({ lat: -51, lon: -1 });
  });

  it("turns a valid schema-v5 coordinate Delete into null coordinates", () => {
    const occurrences = baseOccurrences();
    const metadata = mockMetadata({
      ...BASE_RAW,
      "Composite:GPSLatitude": 51,
      "Composite:GPSLongitude": 1,
    });
    expect(
      resolve({
        metadata,
        occurrences,
        targetDrafts: targets(
          existingEntry(occurrences[0], { intent: "Delete", value: null }),
        ),
      }),
    ).toEqual({ lat: null, lon: null });
  });

  it("does not suppress valid Composite coordinates for altitude-only targets", () => {
    const altitude = occurrence(GPS_IDS.altitude, valueFor(10));
    expect(
      resolve({
        metadata: mockMetadata({
          "Composite:GPSLatitude": 51,
          "Composite:GPSLongitude": -1,
          "GPS:GPSAltitude": 10,
        }),
        occurrences: [altitude],
        targetDrafts: targets(existingEntry(altitude, set(valueFor(20)))),
      }),
    ).toEqual({ lat: 51, lon: -1 });
  });

  it("ignores a stale ExistingOccurrence target", () => {
    const occurrences = baseOccurrences();
    const entry = existingEntry(occurrences[0], set(valueFor(52)));
    entry.target = {
      ...entry.target,
      occurrence_id: { ...entry.target.occurrence_id, copy: 9 },
    };
    expect(resolve({ occurrences, targetDrafts: targets(entry) })).toEqual({
      lat: 51,
      lon: 1,
    });
  });

  it("ignores a changed runtime selector target", () => {
    const occurrences = baseOccurrences();
    const entry = existingEntry(occurrences[0], set(valueFor(52)));
    entry.target = {
      ...entry.target,
      write_target: { ...entry.target.write_target, tag_name: "Other" },
    };
    expect(resolve({ occurrences, targetDrafts: targets(entry) })).toEqual({
      lat: 51,
      lon: 1,
    });
  });

  it("ignores a changed embedded schema target", () => {
    const occurrences = baseOccurrences();
    const entry = existingEntry(occurrences[0], set(valueFor(52)));
    entry.target = { ...entry.target, schema_id: GPS_IDS.longitude };
    expect(resolve({ occurrences, targetDrafts: targets(entry) })).toEqual({
      lat: 51,
      lon: 1,
    });
  });

  it("never selects a multiply-resolved GPS schema", () => {
    const occurrences = baseOccurrences();
    const duplicate = occurrence(GPS_IDS.latitude, valueFor(60), {
      id: { ...occurrences[0].id, copy: 1 },
    });
    expect(
      resolve({
        occurrences: [...occurrences, duplicate],
        targetDrafts: targets(existingEntry(occurrences[0], set(valueFor(52)))),
      }),
    ).toEqual({ lat: 51, lon: 1 });
  });

  it("never selects among multiple exact-schema target owners", () => {
    const occurrences = baseOccurrences();
    const first = existingEntry(occurrences[0], set(valueFor(52)));
    const second = existingEntry(occurrences[0], set(valueFor(53)));
    expect(
      resolve({ occurrences, targetDrafts: targets(first, second) }),
    ).toEqual({ lat: 51, lon: 1 });
  });

  it("lets exact legacy ownership prevent the same-schema v5 overlay", () => {
    const occurrences = baseOccurrences();
    expect(
      resolve({
        occurrences,
        legacyDrafts: mockDrafts({ "GPS:GPSLatitude": 53 }),
        targetDrafts: targets(existingEntry(occurrences[0], set(valueFor(52)))),
      }),
    ).toEqual({ lat: 53, lon: 1 });
  });

  it("keeps an absent schema index distinct from index zero", () => {
    const indexedId = { ...GPS_IDS.latitude, index: 0 };
    const legacyDrafts: MetadataDraftCollection = {
      [schemaDefinitionIdToken(indexedId)]: {
        id: indexedId,
        edit: { intent: "Delete", value: null },
      },
    };
    expect(resolve({ legacyDrafts })).toEqual({ lat: 51, lon: 1 });
  });

  it("does not mutate metadata, occurrences, or either draft collection", () => {
    const metadata = mockMetadata(BASE_RAW);
    const occurrences = baseOccurrences();
    const legacyDrafts = mockDrafts({ "GPS:GPSLongitudeRef": "W" });
    const targetDrafts = targets(
      existingEntry(occurrences[0], set(valueFor(52))),
    );
    const before = structuredClone({
      metadata,
      occurrences,
      legacyDrafts,
      targetDrafts,
    });

    resolveEffectiveGpsForFile({
      metadata,
      occurrences,
      legacyDrafts,
      targetDrafts,
    });

    expect({ metadata, occurrences, legacyDrafts, targetDrafts }).toEqual(
      before,
    );
  });
});
